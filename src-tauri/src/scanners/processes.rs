use crate::models::ActiveProcess;
use crate::process_ext::NoWindow;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

/// Process names we count as "active AI dev sessions". Compared
/// case-insensitively against the executable name.
const TARGET_NAMES: &[&str] = &["claude", "codex", "cursor", "cline"];

/// System path prefixes that indicate the cwd is not a real project — these
/// are mostly app bundles and OS dirs that helper subprocesses inherit when
/// they didn't `cd` anywhere meaningful.
const UNIX_SYSTEM_PREFIXES: &[&str] = &[
    "/Applications",
    "/System",
    "/Library",
    "/usr",
    "/sbin",
    "/bin",
    "/private",
    "/Volumes",
];

/// Windows install/system roots. Compared case-insensitively. We also filter
/// per-user app installs under `%LOCALAPPDATA%\Programs\` (where VS Code,
/// Cursor, etc. live) — covered separately below since the prefix is
/// home-relative.
const WINDOWS_SYSTEM_PREFIXES: &[&str] = &[
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\windows",
    "c:\\programdata",
];

pub fn scan() -> Vec<ActiveProcess> {
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::everything(),
    );

    let home = dirs::home_dir().map(|h| h.to_string_lossy().into_owned());
    // Lazily resolved on first codex match so non-codex sessions don't pay the
    // rollout-walk cost. The Codex Desktop runs from `C:\Program Files\
    // WindowsApps\…` and its child `codex.exe app-server` runs in an
    // AppContainer sandbox, so its OS-level cwd is either the install dir or
    // unreadable. The active project lives in the latest rollout's
    // `session_meta.cwd` instead.
    let mut codex_session_cwd: Option<Option<String>> = None;

    let mut out = Vec::new();
    for (pid, proc_) in sys.processes() {
        // Linux: sysinfo enumerates /proc/<pid>/task/<tid> too, so multi-threaded
        // processes (claude/cursor) show up once per thread under the same name.
        // Skip threads — keep only the main process.
        if proc_.thread_kind().is_some() {
            continue;
        }
        let Some(name) = match_target(proc_) else {
            continue;
        };
        let cwd = proc_.cwd().map(|p| p.to_string_lossy().into_owned());
        let cwd_ok = is_project_cwd(cwd.as_deref(), home.as_deref());
        let final_cwd = if is_codex_name(&name) {
            // Codex Desktop processes have an unusable OS cwd (sandbox / install
            // dir); the npm CLI inherits the terminal's cwd which is fine. Use
            // the rollout-derived cwd as a fallback only — never override a real
            // project cwd that's already correct.
            if cwd_ok {
                cwd
            } else {
                codex_session_cwd
                    .get_or_insert_with(recent_codex_session_cwd)
                    .clone()
            }
        } else if cwd_ok {
            cwd
        } else {
            continue;
        };
        out.push(ActiveProcess {
            pid: pid.as_u32(),
            name,
            cwd: final_cwd,
            runtime_sec: proc_.run_time(),
            memory_kb: proc_.memory() / 1024,
        });
    }
    let out = collapse_helpers(out, "cursor");
    let mut out = collapse_helpers(out, "codex");
    out.sort_by_key(|p| std::cmp::Reverse(p.runtime_sec));
    out
}

fn is_codex_name(name: &str) -> bool {
    let n = name.to_lowercase();
    let stripped = n.strip_suffix(".exe").unwrap_or(&n);
    stripped == "codex" || stripped.starts_with("codex ")
}

/// Walk `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, find the most recently
/// modified rollout (capped at 15 minutes so we don't mislabel a long-stale
/// codex process), and return its `session_meta.cwd`. Used to give Codex
/// Desktop processes a meaningful project directory since the OS cwd is the
/// MSIX install dir.
fn recent_codex_session_cwd() -> Option<String> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    if !root.is_dir() {
        return None;
    }
    let cutoff = SystemTime::now().checked_sub(Duration::from_secs(15 * 60))?;

    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for entry in walkdir::WalkDir::new(&root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata().ok()?.modified().ok()?;
        if mtime < cutoff {
            continue;
        }
        match &latest {
            Some((cur, _)) if *cur >= mtime => {}
            _ => latest = Some((mtime, path.to_path_buf())),
        }
    }
    let (_, path) = latest?;

    // `session_meta` is always among the first lines; cap the scan so a corrupt
    // file doesn't make us read megabytes.
    let file = File::open(&path).ok()?;
    let reader = BufReader::new(file);
    for line in reader.lines().take(20).map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
            continue;
        }
        return value
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(|c| c.as_str())
            .map(str::to_string);
    }
    None
}

/// Fold an Electron-style process tree into one row per (target, cwd).
/// Two cases need this:
/// - macOS Cursor: a renderer + GPU helper + one plugin process per MCP
///   server, all sharing a workspace cwd. Without this, we'd render half a
///   dozen near-identical rows.
/// - Codex Desktop on Windows: an Electron parent (`Codex.exe`) plus the
///   `codex.exe app-server` child plus an in-app rate-limit poller that all
///   share the rollout-derived cwd.
/// We anchor each group to its longest-running pid (typically the parent /
/// renderer) and aggregate memory so the row reflects what the agent is
/// actually consuming.
fn collapse_helpers(procs: Vec<ActiveProcess>, target: &str) -> Vec<ActiveProcess> {
    use std::collections::HashMap;
    let mut groups: HashMap<String, ActiveProcess> = HashMap::new();
    let mut others: Vec<ActiveProcess> = Vec::new();

    for proc in procs {
        let n = proc.name.to_lowercase();
        let stripped = n.strip_suffix(".exe").unwrap_or(&n);
        let matches = stripped == target || stripped.starts_with(&format!("{target} "));
        if !matches {
            others.push(proc);
            continue;
        }
        let cwd_key = proc.cwd.clone().unwrap_or_default();
        groups
            .entry(format!("{target}::{cwd_key}"))
            .and_modify(|existing| {
                existing.memory_kb = existing.memory_kb.saturating_add(proc.memory_kb);
                if proc.runtime_sec > existing.runtime_sec {
                    existing.runtime_sec = proc.runtime_sec;
                    existing.pid = proc.pid;
                }
            })
            .or_insert(proc);
    }

    others.extend(groups.into_values());
    others
}

/// Returns the display name to use if this process looks like one of
/// `TARGET_NAMES`, otherwise `None`. We check the reported `name()` first,
/// then fall back to the exe basename and the basenames of the cmdline args.
/// The argv fallback matters when a Node CLI (e.g. the `codex` or `claude`
/// npm package) hasn't set `process.title` — sysinfo then reports `node` and
/// the real script name lives in argv. In that case we relabel from "node" to
/// the matched target name so the live view shows "codex" instead of "node".
fn match_target(proc_: &sysinfo::Process) -> Option<String> {
    let normalize = |s: &str| {
        let lower = s.to_lowercase();
        lower
            .strip_suffix(".exe")
            .map(str::to_string)
            .unwrap_or(lower)
    };
    let target_match = |name: &str| -> Option<&'static str> {
        TARGET_NAMES
            .iter()
            .find(|t| name == **t || name.starts_with(&format!("{t} ")))
            .copied()
    };

    let proc_name = proc_.name().to_string_lossy().into_owned();
    let normalized = normalize(&proc_name);

    // macOS Cursor.app spawns a fan of helper subprocesses (Renderer, GPU,
    // and one Plugin per MCP server). They're not separate dev sessions —
    // collapse them all under the display name "Cursor" so the post-scan
    // dedup can fold them into one row per workspace cwd. The parent
    // Cursor.app process has cwd /Applications and gets filtered by
    // is_project_cwd, so we'd see *no* Cursor row without keeping helpers.
    if normalized == "cursor" || normalized.starts_with("cursor helper") {
        return Some("Cursor".to_string());
    }

    let matched = if target_match(&normalized).is_some() {
        Some(proc_name.clone())
    } else if let Some(file) = proc_.exe().and_then(|p| p.file_name()) {
        if target_match(&normalize(&file.to_string_lossy())).is_some() {
            Some(proc_name.clone())
        } else {
            None
        }
    } else {
        None
    };
    let matched = matched.or_else(|| {
        for arg in proc_.cmd() {
            let s = arg.to_string_lossy();
            if let Some(file) = Path::new(s.as_ref()).file_name() {
                if let Some(t) = target_match(&normalize(&file.to_string_lossy())) {
                    return Some(t.to_string());
                }
            }
        }
        None
    });

    let matched = matched?;

    // Codex Desktop is an Electron app: its main `Codex.exe` browser process
    // plus `--type=renderer / gpu-process / utility / crashpad-handler` helpers
    // are all named "Codex.exe". Drop the helpers — they aren't independent
    // agents and collapsing them after the fact would just inflate the row's
    // memory total with chrome overhead.
    if is_codex_name(&matched) {
        for arg in proc_.cmd() {
            let s = arg.to_string_lossy();
            if s.starts_with("--type=") || s.starts_with("/type=") {
                return None;
            }
        }
        // Relabel Codex Desktop processes (Electron parent + bundled
        // `app-server` codex.exe) so the live view shows "Codex Desktop"
        // instead of either "Codex" (capitalized parent) or "codex" (the
        // bundled CLI binary). Without this, a user running both Desktop and
        // the npm CLI sees two case-different rows that look like a bug.
        // Detection signature: exe path under the MSIX install root on
        // Windows or the .app bundle on macOS — anywhere else means it's the
        // standalone CLI.
        if is_codex_desktop_path(proc_.exe()) {
            return Some("Codex Desktop".to_string());
        }
    }

    Some(matched)
}

/// Heuristic for "this codex process is bundled inside the Codex Desktop
/// app". Per-platform substring match on the executable path; intentionally
/// permissive so future Desktop versions / install locations still match.
fn is_codex_desktop_path(exe: Option<&Path>) -> bool {
    let Some(p) = exe else {
        return false;
    };
    let s = p.to_string_lossy().to_lowercase();
    // Windows MSIX: %ProgramFiles%\WindowsApps\OpenAI.Codex_<ver>_<arch>__<id>\app\…
    if s.contains("\\windowsapps\\openai.codex_") || s.contains("/windowsapps/openai.codex_") {
        return true;
    }
    // macOS .app bundle: /Applications/Codex.app/Contents/MacOS/Codex (or
    // /Applications/Codex.app/Contents/Resources/codex). The lowercase match
    // also catches user-installed copies under ~/Applications.
    if s.contains("/codex.app/") {
        return true;
    }
    false
}

/// A "project cwd" is anything that looks like the user's own working
/// directory — not the filesystem root, not the home dir itself, and not a
/// system / app-bundle path that helper subprocesses tend to inherit. The
/// VS Code IDE-integration spawns `claude` with cwd inherited from the
/// editor's install dir; we filter those out here.
fn is_project_cwd(cwd: Option<&str>, home: Option<&str>) -> bool {
    let Some(path) = cwd else {
        return false;
    };
    let trimmed = path.trim_end_matches(|c| c == '/' || c == '\\');
    if trimmed.is_empty() || trimmed == "/" {
        return false;
    }

    let eq_path = |a: &str, b: &str| {
        if cfg!(target_os = "windows") {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    let starts_with_path = |hay: &str, prefix: &str| {
        if cfg!(target_os = "windows") {
            let hay_l = hay.to_ascii_lowercase();
            let pre_l = prefix.to_ascii_lowercase();
            hay_l == pre_l
                || hay_l.starts_with(&format!("{pre_l}\\"))
                || hay_l.starts_with(&format!("{pre_l}/"))
        } else {
            hay == prefix || hay.starts_with(&format!("{prefix}/"))
        }
    };

    if let Some(home) = home {
        let home_trimmed = home.trim_end_matches(|c| c == '/' || c == '\\');
        if eq_path(trimmed, home_trimmed) {
            return false;
        }
    }

    if UNIX_SYSTEM_PREFIXES
        .iter()
        .any(|prefix| starts_with_path(trimmed, prefix))
    {
        return false;
    }

    if cfg!(target_os = "windows") {
        if WINDOWS_SYSTEM_PREFIXES
            .iter()
            .any(|prefix| starts_with_path(trimmed, prefix))
        {
            return false;
        }
        // %LOCALAPPDATA%\Programs\ — per-user app installs (VS Code, Cursor).
        if let Some(home) = home {
            let home_trimmed = home.trim_end_matches(|c| c == '/' || c == '\\');
            let appdata_programs = format!("{home_trimmed}\\AppData\\Local\\Programs");
            if starts_with_path(trimmed, &appdata_programs) {
                return false;
            }
        }
    }

    true
}

pub fn kill(pid: u32) -> Result<(), String> {
    let target = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[target]),
        false,
        ProcessRefreshKind::new(),
    );
    let proc_ = sys
        .process(target)
        .ok_or_else(|| format!("process {pid} not found"))?;
    if proc_.kill() {
        Ok(())
    } else {
        Err(format!("failed to kill process {pid}"))
    }
}

pub fn reveal_in_finder(path: &str) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let result = if cfg!(target_os = "macos") {
        Command::new("open").no_window().arg(path).spawn()
    } else if cfg!(target_os = "windows") {
        Command::new("explorer").no_window().arg(path).spawn()
    } else {
        Command::new("xdg-open").no_window().arg(path).spawn()
    };
    result.map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_dir(path: &str) -> Result<(), String> {
    if !Path::new(path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    Ok(())
}

pub fn open_in_terminal(path: &str) -> Result<(), String> {
    ensure_dir(path)?;
    let res = if cfg!(target_os = "macos") {
        Command::new("open")
            .no_window()
            .args(["-a", "Terminal"])
            .arg(path)
            .spawn()
    } else if cfg!(target_os = "windows") {
        // Set the spawned shell's cwd directly via `current_dir` instead of
        // building a `cd /d <path>` command line. cmd.exe re-parses its own
        // arguments and treats `&`, `^`, `|`, `>` as metacharacters even when
        // Rust quotes the argv element correctly — a folder name containing
        // any of those would otherwise inject commands. The new cmd /K window
        // inherits the cwd from `start`, which inherits it from us.
        Command::new("cmd")
            .no_window()
            .current_dir(path)
            .args(["/C", "start", "", "cmd", "/K"])
            .spawn()
    } else {
        Command::new("x-terminal-emulator")
            .no_window()
            .arg("--working-directory")
            .arg(path)
            .spawn()
    };
    res.map_err(|e| e.to_string())?;
    Ok(())
}

/// Open the directory in VS Code. Tries the `code` CLI first, falls back to
/// macOS's `open -a "Visual Studio Code"`.
pub fn open_in_vscode(path: &str) -> Result<(), String> {
    ensure_dir(path)?;
    open_with_editor_spec(path, &EDITOR_VSCODE)
}

/// Catalog of editors LunoPeak knows how to launch. Each spec lists the CLI
/// commands to try in order, plus the macOS `.app` bundle name to fall back
/// to via `open -a`. When no CLI is on PATH and we're not on macOS, the
/// caller gets an error explaining which launcher we couldn't find.
struct EditorSpec {
    /// Stable id used in settings + UI ("vscode", "cursor", …).
    id: &'static str,
    /// Human label, used only in error messages.
    label: &'static str,
    /// Platforms the spec is meaningful on. The picker filters by this so
    /// users on Windows / Linux don't see Mac-only entries like Xcode.
    platforms: EditorPlatforms,
    /// CLI commands to try in PATH, in order. First success wins. On Windows
    /// each is also tried with `.cmd`, `.exe`, `.bat` since most editor
    /// shims are `.cmd` files and Rust's `Command::new` doesn't honor
    /// `PATHEXT` automatically.
    cli: &'static [&'static str],
    /// macOS `.app` bundle name (no `.app` suffix needed for `open -a`).
    mac_app: Option<&'static str>,
}

#[derive(Copy, Clone)]
struct EditorPlatforms {
    macos: bool,
    windows: bool,
    linux: bool,
}

const ALL: EditorPlatforms = EditorPlatforms {
    macos: true,
    windows: true,
    linux: true,
};
const MAC_ONLY: EditorPlatforms = EditorPlatforms {
    macos: true,
    windows: false,
    linux: false,
};

impl EditorPlatforms {
    fn supports_current(self) -> bool {
        if cfg!(target_os = "macos") {
            self.macos
        } else if cfg!(target_os = "windows") {
            self.windows
        } else {
            self.linux
        }
    }
}

const EDITOR_VSCODE: EditorSpec = EditorSpec {
    id: "vscode",
    label: "VS Code",
    platforms: ALL,
    cli: &["code"],
    mac_app: Some("Visual Studio Code"),
};
const EDITOR_VSCODE_INSIDERS: EditorSpec = EditorSpec {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    platforms: ALL,
    cli: &["code-insiders"],
    mac_app: Some("Visual Studio Code - Insiders"),
};
const EDITOR_CURSOR: EditorSpec = EditorSpec {
    id: "cursor",
    label: "Cursor",
    platforms: ALL,
    cli: &["cursor"],
    mac_app: Some("Cursor"),
};
const EDITOR_ANTIGRAVITY: EditorSpec = EditorSpec {
    id: "antigravity",
    label: "Antigravity",
    platforms: ALL,
    cli: &["antigravity"],
    mac_app: Some("Antigravity"),
};
const EDITOR_WINDSURF: EditorSpec = EditorSpec {
    id: "windsurf",
    label: "Windsurf",
    platforms: ALL,
    cli: &["windsurf"],
    mac_app: Some("Windsurf"),
};
const EDITOR_ZED: EditorSpec = EditorSpec {
    id: "zed",
    label: "Zed",
    platforms: ALL,
    cli: &["zed"],
    mac_app: Some("Zed"),
};
const EDITOR_SUBLIME: EditorSpec = EditorSpec {
    id: "sublime",
    label: "Sublime Text",
    platforms: ALL,
    cli: &["subl"],
    mac_app: Some("Sublime Text"),
};
const EDITOR_XCODE: EditorSpec = EditorSpec {
    id: "xcode",
    label: "Xcode",
    platforms: MAC_ONLY,
    cli: &["xed"],
    mac_app: Some("Xcode"),
};

const EDITORS: &[&EditorSpec] = &[
    &EDITOR_VSCODE,
    &EDITOR_VSCODE_INSIDERS,
    &EDITOR_CURSOR,
    &EDITOR_ANTIGRAVITY,
    &EDITOR_WINDSURF,
    &EDITOR_ZED,
    &EDITOR_SUBLIME,
    &EDITOR_XCODE,
];

fn editor_spec(id: &str) -> Option<&'static EditorSpec> {
    EDITORS.iter().copied().find(|e| e.id == id)
}

/// Try to spawn `cli` with `path`. On Windows we additionally try the common
/// shim extensions (`.cmd` is what VS Code, Cursor, Windsurf, Antigravity,
/// and most other Electron editors install) because Rust's `Command::new`
/// only resolves a literal filename and ignores PATHEXT.
fn spawn_cli(cli: &str, path: &str) -> bool {
    if Command::new(cli).no_window().arg(path).spawn().is_ok() {
        return true;
    }
    if cfg!(target_os = "windows") {
        for ext in [".cmd", ".exe", ".bat"] {
            let candidate = format!("{cli}{ext}");
            if Command::new(&candidate)
                .no_window()
                .arg(path)
                .spawn()
                .is_ok()
            {
                return true;
            }
        }
    }
    false
}

fn open_with_editor_spec(path: &str, spec: &EditorSpec) -> Result<(), String> {
    if !spec.platforms.supports_current() {
        return Err(format!("{} is not available on this platform", spec.label));
    }
    for cmd in spec.cli {
        if spawn_cli(cmd, path) {
            return Ok(());
        }
    }
    if cfg!(target_os = "macos") {
        if let Some(app) = spec.mac_app {
            Command::new("open")
                .no_window()
                .args(["-a", app])
                .arg(path)
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err(format!(
        "{} launcher not found. Install the CLI shim from the editor's command palette \
        (e.g. \"Shell Command: Install '{}' command in PATH\" in VS Code-style editors).",
        spec.label,
        spec.cli.first().copied().unwrap_or("editor"),
    ))
}

fn open_with_system_handler(path: &str) -> Result<(), String> {
    let result = if cfg!(target_os = "macos") {
        Command::new("open").no_window().arg(path).spawn()
    } else if cfg!(target_os = "windows") {
        // `start` is a cmd builtin, so we go through cmd /c. The empty title
        // arg ("") prevents `start` from interpreting a quoted path as a
        // window title.
        Command::new("cmd")
            .no_window()
            .args(["/C", "start", "", path])
            .spawn()
    } else {
        Command::new("xdg-open").no_window().arg(path).spawn()
    };
    result.map_err(|e| e.to_string())?;
    Ok(())
}

/// Open `path` (file or directory) in the requested editor. `editor` is the
/// stable id from the editor catalog, or "system" / `None` to fall back to
/// the OS's default file handler.
pub fn open_path_in_editor(path: &str, editor: Option<&str>) -> Result<(), String> {
    if !Path::new(path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    let id = editor.unwrap_or("system");
    if id == "system" || id.is_empty() {
        return open_with_system_handler(path);
    }
    let spec = editor_spec(id).ok_or_else(|| format!("unknown editor: {id}"))?;
    open_with_editor_spec(path, spec)
}

/// Stable ids of the editors meaningful on the current platform. The
/// frontend uses this to hide entries that wouldn't work (e.g. Xcode on
/// Windows). "system" is always available and is added by the caller — this
/// list only covers third-party editors.
pub fn available_editor_ids() -> Vec<String> {
    EDITORS
        .iter()
        .filter(|spec| spec.platforms.supports_current())
        .map(|spec| spec.id.to_string())
        .collect()
}

/// Launch a Terminal at `path` and run `claude` in it. macOS-only via
/// AppleScript; on other platforms we fall back to opening a terminal there
/// and let the user type the command.
pub fn open_in_claude(path: &str) -> Result<(), String> {
    open_in_terminal_with_command(path, "claude")
}

pub fn open_in_codex(path: &str) -> Result<(), String> {
    open_in_terminal_with_command(path, "codex")
}

/// Opens the repo directory in Cursor's GUI app. Cursor doesn't have a chat
/// CLI to wrap the way Claude and Codex do, so the most useful entry point
/// is `cursor <path>` — its bundled CLI launcher (installed via the in-app
/// "Install 'cursor' command in PATH" menu item). Falls back to `open -a`
/// on macOS when the CLI isn't on PATH.
pub fn open_in_cursor(path: &str) -> Result<(), String> {
    ensure_dir(path)?;
    if let Ok(child) = Command::new("cursor").no_window().arg(path).spawn() {
        let _ = child;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .no_window()
            .arg("-a")
            .arg("Cursor")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    Err("Cursor CLI not found on PATH".into())
}

/// Shared helper for the `claude` / `codex` openers — drops the user into a
/// terminal at `path` and runs the agent CLI. On macOS uses Apple's Terminal
/// via AppleScript so the path gets shell-quoted safely; elsewhere falls
/// back to a plain `open_in_terminal` since the agent CLI then has to be
/// typed manually (most non-mac terminals don't have an equivalent "run a
/// command after opening" affordance).
fn open_in_terminal_with_command(path: &str, command: &str) -> Result<(), String> {
    ensure_dir(path)?;
    if cfg!(target_os = "macos") {
        // Pass the path and the command as separate argv elements to
        // osascript so `quoted form of` does the /bin/sh quoting. Embedding
        // either directly into the script string would be an injection
        // vector — folder names can legally contain `"` and `\` on macOS,
        // both of which are AppleScript metacharacters.
        let script = "on run argv\n\
                      set p to item 1 of argv\n\
                      set c to item 2 of argv\n\
                      tell application \"Terminal\"\n\
                        activate\n\
                        do script \"cd \" & quoted form of p & \" && \" & c\n\
                      end tell\n\
                      end run";
        Command::new("osascript")
            .no_window()
            .arg("-e")
            .arg(script)
            .arg("--")
            .arg(path)
            .arg(command)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    open_in_terminal(path)
}

pub fn git_pull(path: &str) -> Result<String, String> {
    ensure_dir(path)?;
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(path)
        .arg("pull")
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        let msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(msg);
    }
    let combined = if stdout.is_empty() { stderr } else { stdout };
    Ok(combined)
}
