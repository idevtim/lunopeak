//! macOS two-bundle glue. To get BOTH a dock-icon window app AND a menu-bar
//! popover that overlays other apps' fullscreen Spaces, LunoPeak ships as two
//! bundles that share one binary:
//!
//!   - `LunoPeak.app` (id `com.lunopeak.app`)            → the `.regular`
//!     window app (dock icon, app menu).
//!   - `…/LoginItems/LunoPeak Menu Bar.app`              → the `.accessory`
//!     menu-bar agent (LSUIElement, id `com.lunopeak.app.menubar`). It's nested
//!     inside the main app and launched with `--menubar`.
//!
//! Two distinct bundle IDs is the whole point: macOS treats them as separate
//! apps, so the agent never owns or duplicates the main app's dock icon, and a
//! dock click on the main app always lands on the main app. Cross-process
//! actions go through `open <bundle>` (LaunchServices) so there are no
//! duplicate instances; a small pidfile pair lets each side find/terminate the
//! other, and a `pending_route` file carries "open on this view".

use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

/// Diagnostics for the cross-process launch flow (processes started via `open`
/// detach, so stderr is hard to capture). No-op unless `LUNOPEAK_DEBUG` is set
/// in the environment, so it stays silent in normal/release runs; when enabled
/// it appends to `/tmp/lunopeak-debug.log`.
pub fn debug_log(msg: &str) {
    use std::io::Write;
    if std::env::var_os("LUNOPEAK_DEBUG").is_none() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/lunopeak-debug.log")
    {
        let _ = writeln!(f, "[pid {}] {msg}", std::process::id());
    }
}

const AGENT_PIDFILE: &str = "menubar.pid";
const WINDOW_PIDFILE: &str = "window.pid";
const PENDING_ROUTE_FILE: &str = "pending_route";
/// Marker left by an agent restarting onto an update while the window was
/// open, so the relaunched agent reopens the window.
const RELAUNCH_WINDOW_FILE: &str = "relaunch_window";
/// Where the menu-bar helper bundle lives, relative to the main `.app`.
const HELPER_REL: &str = "Contents/Library/LoginItems/LunoPeak Menu Bar.app";

// ── Bundle paths ───────────────────────────────────────────────────────────

/// The main `LunoPeak.app` this binary runs from. For the window process that's
/// its own bundle; for the nested menu-bar helper it's the *outer* app — we
/// take the last `.app` ancestor, which is the main app in both cases. `None`
/// when not running from a bundle (e.g. `cargo`/dev).
fn main_app_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .filter(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .last()
        .map(|p| p.to_path_buf())
}

/// The nested menu-bar helper bundle inside the main app.
fn helper_app_path() -> Option<PathBuf> {
    Some(main_app_path()?.join(HELPER_REL))
}

// ── Small config-dir files (pidfiles + pending route) ──────────────────────

fn config_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(name))
}

/// True if a process with this PID is alive. `kill -0` signals nothing but
/// succeeds only when the PID exists and is signalable — the standard probe.
fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn record_self(app: &AppHandle, name: &str) {
    if let Some(path) = config_file(app, name) {
        if let Err(err) = std::fs::write(&path, std::process::id().to_string()) {
            crate::elog!(error, "macos_agent", "could not write {}: {err}", path.display());
        }
    }
}

/// Record THIS process as the live menu-bar agent (called at agent startup).
pub fn record_agent(app: &AppHandle) {
    record_self(app, AGENT_PIDFILE);
}

/// Record THIS process as the live window process (called at window startup),
/// so the agent's "Quit" can terminate it.
pub fn record_window(app: &AppHandle) {
    record_self(app, WINDOW_PIDFILE);
}

/// Read a live PID from a pidfile, or `None` if absent/stale.
fn live_pid(app: &AppHandle, name: &str) -> Option<u32> {
    let path = config_file(app, name)?;
    let pid = std::fs::read_to_string(&path).ok()?.trim().parse::<u32>().ok()?;
    pid_alive(pid).then_some(pid)
}

/// Stash the route a window should open on, for the frontend to pick up via
/// `take_pending_route` on mount (fresh launch) or the Reopen handler (already
/// running). A file, not memory, because the writer (agent) and reader (window)
/// are different processes.
pub fn write_pending_route(app: &AppHandle, route: &str) {
    if let Some(path) = config_file(app, PENDING_ROUTE_FILE) {
        let _ = std::fs::write(path, route);
    }
}

/// Read and clear the pending route.
pub fn read_pending_route(app: &AppHandle) -> Option<String> {
    let path = config_file(app, PENDING_ROUTE_FILE)?;
    let route = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let route = route.trim();
    (!route.is_empty()).then(|| route.to_string())
}

// ── Cross-process launches ─────────────────────────────────────────────────

/// Spawn the menu-bar agent unless one is already running. Called from the
/// window process during setup. Launches the nested helper *bundle* via
/// LaunchServices (`open`) so macOS gives it its own app identity (no dock
/// icon, LSUIElement) — distinct from the main app. The helper records its own
/// pidfile at startup. Falls back to a direct `--menubar` exec in dev (no
/// bundle), which has the old single-bundle dock quirks but is dev-only.
pub fn spawn_if_needed(app: &AppHandle) {
    if live_pid(app, AGENT_PIDFILE).is_some() {
        return; // agent already running — don't spawn a duplicate.
    }

    if let Some(helper) = helper_app_path() {
        if helper.exists() {
            if let Err(err) = Command::new("open")
                .arg(&helper)
                .args(["--args", "--menubar"])
                .spawn()
            {
                crate::elog!(error, "macos_agent", "failed to open helper bundle: {err}");
            }
            return;
        }
    }
    dev_exec(Some("--menubar"), None);
}

/// Open / focus the window app from the menu-bar agent ("Open LunoPeak" /
/// "Settings"). Goes through LaunchServices (`open <main.app>`): if the window
/// process is running it's reopened (focused); if not, it's launched. Because
/// the agent is a *different* bundle id, this never loops back to the agent and
/// never needs `-n` (so no duplicate instance / dock tile). `route` is stashed
/// in the pending-route file first; the window reads it on mount or on reopen.
pub fn launch_window(app: &AppHandle, route: Option<&str>) {
    if let Some(route) = route {
        write_pending_route(app, route);
    }
    if let Some(main_app) = main_app_path() {
        debug_log(&format!("launch_window: open {}", main_app.display()));
        match Command::new("open").arg(&main_app).output() {
            Ok(out) => debug_log(&format!(
                "launch_window: open status={} stderr={}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(err) => debug_log(&format!("launch_window: open failed: {err}")),
        }
        return;
    }
    debug_log("launch_window: no bundle, dev_exec");
    dev_exec(None, route);
}

/// Dev fallback (no `.app` bundle): re-exec the current binary directly.
fn dev_exec(mode: Option<&str>, route: Option<&str>) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut cmd = Command::new(exe);
    if let Some(mode) = mode {
        cmd.arg(mode);
    }
    if let Some(route) = route {
        cmd.args(["--route", route]);
    }
    let _ = cmd.spawn();
}

/// Pull a `--route <id>` value out of an argument list — only the dev-exec
/// fallback path passes the route as an arg (packaged builds use the file).
pub fn route_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg.as_ref() == "--route" {
            return iter.next().map(|r| r.as_ref().to_string());
        }
    }
    None
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

/// Terminate the *other* process (window→agent or agent→window) so "Quit" /
/// Cmd+Q closes both. Sends SIGTERM via `kill` so the target runs its normal
/// Tauri teardown. Skips this process's own PID, and any stale/dead pidfile.
pub fn terminate_counterpart(app: &AppHandle) {
    let me = std::process::id();
    for name in [AGENT_PIDFILE, WINDOW_PIDFILE] {
        if let Some(pid) = live_pid(app, name) {
            if pid != me {
                let _ = Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status();
            }
        }
    }
}

/// Stop the other process before this one restarts onto an installed update —
/// it's still running the old binary. Window side: the relaunched window
/// spawns a fresh agent (`spawn_if_needed` skips a live one, hence waiting
/// for it to die). Agent side: the window is reopened by the relaunched agent
/// via the `relaunch_window` marker, so restarting from the menu bar doesn't
/// silently close it.
pub fn prepare_restart(app: &AppHandle) {
    let me = std::process::id();
    let counterpart = if crate::is_menubar_agent() { WINDOW_PIDFILE } else { AGENT_PIDFILE };
    let Some(pid) = live_pid(app, counterpart).filter(|&pid| pid != me) else {
        return;
    };
    if crate::is_menubar_agent() {
        if let Some(path) = config_file(app, RELAUNCH_WINDOW_FILE) {
            let _ = std::fs::write(path, "");
        }
    }
    let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    // The window saves its geometry on the way out; give it a moment.
    for _ in 0..40 {
        if !pid_alive(pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Read and clear the `relaunch_window` marker.
pub fn take_relaunch_window(app: &AppHandle) -> bool {
    config_file(app, RELAUNCH_WINDOW_FILE).is_some_and(|path| std::fs::remove_file(path).is_ok())
}

/// Make the window process exit *gracefully* on SIGTERM. The menu-bar agent's
/// "Quit" terminates this process with SIGTERM (see `terminate_counterpart`);
/// the default disposition is a hard kill, which skips Tauri teardown and so
/// loses the window-state geometry save. Here we instead run `app.exit(0)` on a
/// dedicated thread (where calling into the app loop is safe), which drives the
/// normal RunEvent::Exit path. Window process only — the agent has no state
/// worth saving, so its default SIGTERM (hard exit) is fine.
pub fn install_graceful_term(app: AppHandle) {
    use signal_hook::consts::SIGTERM;
    use signal_hook::iterator::Signals;

    let mut signals = match Signals::new([SIGTERM]) {
        Ok(signals) => signals,
        Err(err) => {
            crate::elog!(error, "macos_agent", "SIGTERM handler install failed: {err}");
            return;
        }
    };
    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            app.exit(0);
        }
    });
}

/// Best-effort removal of this process's pidfile on exit, so a recycled PID can
/// never be mistaken for a live counterpart. `agent` selects which file.
pub fn clear_pidfile(app: &AppHandle, agent: bool) {
    let name = if agent { AGENT_PIDFILE } else { WINDOW_PIDFILE };
    if let Some(path) = config_file(app, name) {
        let _ = std::fs::remove_file(path);
    }
}
