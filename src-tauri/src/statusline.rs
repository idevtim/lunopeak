//! Terminal status line integration for Claude Code and Codex.
//!
//! **Claude Code** runs a user-configured command on every repaint and pipes
//! it the session as JSON on stdin (code.claude.com/docs/en/statusline). The
//! app binary doubles as that command — `LunoPeak statusline` — and prints one
//! line: context fill, the plan's 5h / weekly windows, per-model weekly caps
//! (Fable), and cost. Everything comes from stdin or from files the app already
//! keeps on disk, so a repaint never touches the network.
//!
//! Each run also records the session's *authoritative* context window, keyed
//! by session id. Transcripts don't carry the window size, so `scanners::live`
//! otherwise infers it from the model name; with a record on disk it uses the
//! number Claude Code itself reported.
//!
//! **Codex** can't run a custom command in its status line (only built-in
//! item ids under `[tui] status_line`), so the Codex half just opts the user
//! into the built-in context and limit items.
//!
//! Both installers edit the user's own config files, so they keep whatever was
//! there: an existing Claude status line is chained (run first, its output kept
//! above ours) and restored on uninstall; a previous Codex item list is saved
//! and put back.

use crate::models::{
    ClaudeStatusline, CodexStatusline, StatuslinePrefs, StatuslineResetHint, StatuslineSegmentId,
    StatuslineSeparator, StatuslineSpan, StatuslineTone, TerminalIntegrations,
};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Chained status lines slower than this are dropped for the repaint rather
/// than holding ours back. Claude Code cancels a script that's still running
/// when the next update fires, so a hung chain would blank the whole line.
const CHAIN_TIMEOUT: Duration = Duration::from_millis(1500);
/// "Today" cost is written by the running app; past this age it's likely
/// missing recent spend, so we leave it off instead of understating.
const SNAPSHOT_MAX_AGE_SECS: i64 = 15 * 60;
/// Minimum gap between snapshot writes from the menu-bar refresh loop — each
/// one re-scans session costs.
const SNAPSHOT_INTERVAL_SECS: i64 = 5 * 60;
/// Usage-cache entries older than this are too stale to show in a terminal.
const USAGE_MAX_AGE_SECS: i64 = 6 * 60 * 60;
/// Session context records untouched for this long are pruned.
const RECORD_TTL_SECS: i64 = 7 * 24 * 60 * 60;
/// Built-in Codex status line items we opt the user into. Verified against
/// the ids compiled into codex-cli 0.155.
pub const CODEX_ITEMS: [&str; 5] = [
    "model-with-reasoning",
    "context-used",
    "five-hour-limit",
    "weekly-limit",
    "git-branch",
];

// ── Paths ──────────────────────────────────────────────────────────────

/// Matches Tauri's `app_config_dir()` for our bundle identifier — this code
/// also runs as a bare CLI with no `AppHandle` to ask.
pub(crate) fn app_dir() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("com.lunopeak.app"))
}
fn contexts_dir() -> Option<PathBuf> {
    Some(app_dir()?.join("claude-contexts"))
}
fn snapshot_file() -> Option<PathBuf> {
    Some(app_dir()?.join("statusline-snapshot.json"))
}
fn chain_file() -> Option<PathBuf> {
    Some(app_dir()?.join("statusline-chain.json"))
}
fn codex_prev_file() -> Option<PathBuf> {
    Some(app_dir()?.join("codex-statusline-prev.json"))
}
/// Written by `scanners::usage` (both app processes share it).
fn usage_cache_file() -> Option<PathBuf> {
    Some(app_dir()?.join("usage-cache.json"))
}
fn claude_settings_file() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("settings.json"))
}
fn codex_config_file() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".codex").join("config.toml"))
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Write via a sibling temp file + rename so a reader (Claude Code watches its
/// settings file) never sees a half-written document.
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("lunopeak-{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

// ── CLI entry ──────────────────────────────────────────────────────────

/// `LunoPeak statusline [--chain]`. Always exits 0 — a non-zero exit or a
/// stray error on stdout would replace the user's status line with noise.
pub fn run_cli(args: &[String]) -> i32 {
    let chain = args.iter().any(|a| a == "--chain");
    let mut raw = String::new();
    let _ = std::io::stdin().take(4 << 20).read_to_string(&mut raw);
    let input: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    if !input.is_null() {
        record_session(&input);
    }

    let prefs = load_prefs();
    let mut out = String::new();
    if chain {
        if let Some(prev) = run_chained(&raw) {
            out.push_str(prev.trim_end_matches(['\n', '\r']));
            out.push('\n');
        }
    }
    let spans = render_spans(&input, &Extras::load(), &prefs);
    out.push_str(&to_ansi(&spans, prefs.color));
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{out}");
    let _ = stdout.flush();
    0
}

/// The user's status line preferences, read straight from the app's
/// settings.json (only the `statusline` key — the rest is none of our
/// business on a hot path). Missing or unreadable means defaults.
fn load_prefs() -> StatuslinePrefs {
    read_json(Some(match app_dir() {
        Some(d) => d.join("settings.json"),
        None => return StatuslinePrefs::default(),
    }))
    .and_then(|v| v.get("statusline").cloned())
    .and_then(|v| serde_json::from_value::<StatuslinePrefs>(v).ok())
    .unwrap_or_default()
    .normalized()
}

// ── Rendering ──────────────────────────────────────────────────────────

/// Data that isn't in Claude Code's stdin payload, read from the app's files.
#[derive(Default)]
pub(crate) struct Extras {
    /// Fallback 5h / weekly when stdin carries no `rate_limits` (it appears
    /// only after the session's first API response).
    five_hour: Option<Window>,
    seven_day: Option<Window>,
    /// Per-model weekly caps, e.g. ("Fable", 63.0, reset).
    scoped: Vec<(String, Window)>,
    today_usd: Option<f64>,
}

#[derive(Clone, Copy)]
struct Window {
    pct: f64,
    reset: Option<i64>,
}

impl Extras {
    pub(crate) fn load() -> Self {
        let now = now_secs();
        let mut out = Extras::default();
        if let Some(entry) = read_json(usage_cache_file()) {
            let fresh = entry
                .get("fetched_unix")
                .and_then(Value::as_i64)
                .is_some_and(|t| now - t <= USAGE_MAX_AGE_SECS);
            if let Some(v) = entry.get("value").filter(|_| fresh) {
                let window = |pct: &str, reset: &str| {
                    let reset = v.get(reset).and_then(Value::as_i64);
                    let pct = v.get(pct).and_then(Value::as_f64)?;
                    // A window whose reset has passed has already rolled over.
                    reset
                        .map_or(true, |r| r > now)
                        .then_some(Window { pct, reset })
                };
                out.five_hour = window("five_hour_pct", "five_hour_reset");
                out.seven_day = window("seven_day_pct", "seven_day_reset");
                out.scoped = v
                    .get("scoped")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|l| {
                        let model = l.get("model")?.as_str()?.to_string();
                        let pct = l.get("pct")?.as_f64()?;
                        let reset = l.get("reset").and_then(Value::as_i64);
                        reset
                            .map_or(true, |r| r > now)
                            .then_some((model, Window { pct, reset }))
                    })
                    .collect();
            }
        }
        if let Some(snap) = read_json(snapshot_file()) {
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let same_day = snap.get("day").and_then(Value::as_str) == Some(today.as_str());
            let fresh = snap
                .get("written_unix")
                .and_then(Value::as_i64)
                .is_some_and(|t| now - t <= SNAPSHOT_MAX_AGE_SECS);
            if same_day && fresh {
                out.today_usd = snap.get("today_usd").and_then(Value::as_f64);
            }
        }
        out
    }
}

fn read_json(path: Option<PathBuf>) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path?).ok()?).ok()
}

/// Accumulates spans for one status line.
struct Line<'a> {
    prefs: &'a StatuslinePrefs,
    spans: Vec<StatuslineSpan>,
}

impl Line<'_> {
    fn push(&mut self, tone: StatuslineTone, text: impl Into<String>) {
        self.spans.push(StatuslineSpan {
            text: text.into(),
            tone,
        });
    }
    fn dim(&mut self, text: impl Into<String>) {
        self.push(StatuslineTone::Dim, text);
    }
    fn plain(&mut self, text: impl Into<String>) {
        self.push(StatuslineTone::Plain, text);
    }
    /// Tone for a percentage against the user's warn / danger thresholds.
    fn tone(&self, pct: f64) -> StatuslineTone {
        if pct >= self.prefs.danger_percent as f64 {
            StatuslineTone::Danger
        } else if pct >= self.prefs.warn_percent as f64 {
            StatuslineTone::Warn
        } else {
            StatuslineTone::Ok
        }
    }
    fn separator(&mut self) {
        let sep = match self.prefs.separator {
            StatuslineSeparator::Bar => " │ ",
            StatuslineSeparator::Dot => " · ",
            StatuslineSeparator::Pipe => " | ",
            StatuslineSeparator::Space => "   ",
        };
        self.dim(sep);
    }
    fn limit(&mut self, label: &str, w: Window, now: i64) {
        self.dim(format!("{label} "));
        self.push(self.tone(w.pct), format!("{}%", w.pct.round()));
        let show_reset = match self.prefs.reset_hint {
            StatuslineResetHint::Always => true,
            StatuslineResetHint::NearLimit => w.pct >= self.prefs.warn_percent as f64,
            StatuslineResetHint::Never => false,
        };
        if let (true, Some(r)) = (show_reset, w.reset) {
            self.dim(format!(" ↻{}", until(r - now)));
        }
    }
}

/// Render one piece of a segment into its own span list.
fn piece(prefs: &StatuslinePrefs, f: impl FnOnce(&mut Line)) -> Vec<StatuslineSpan> {
    let mut l = Line {
        prefs,
        spans: Vec::new(),
    };
    f(&mut l);
    l.spans
}

/// One status line, as styled spans, from Claude Code's stdin payload plus
/// app-side extras, laid out by the user's preferences. Segments with no
/// data (a limit before the first response, cost with no snapshot) are
/// skipped rather than shown empty — except context, which always holds its
/// place so the line doesn't jump around at session start.
pub(crate) fn render_spans(
    input: &Value,
    extras: &Extras,
    prefs: &StatuslinePrefs,
) -> Vec<StatuslineSpan> {
    let now = now_secs();
    let mut line = Line {
        prefs,
        spans: Vec::new(),
    };
    let limits = input.get("rate_limits");
    let from_stdin = |key: &str| {
        let w = limits?.get(key)?;
        Some(Window {
            pct: w.get("used_percentage")?.as_f64()?,
            reset: w.get("resets_at").and_then(Value::as_i64),
        })
    };

    let mut first = true;
    for seg in prefs.segments.iter().filter(|s| s.enabled) {
        // A segment renders zero or more pieces (model limits can be several);
        // collecting them first lets an empty segment skip its separator.
        let mut pieces: Vec<Vec<StatuslineSpan>> = Vec::new();
        match seg.id {
            StatuslineSegmentId::Context => {
                // `used_percentage` is input-only (fresh + both cache legs),
                // the same figure Claude Code compacts on.
                let cw = input.get("context_window");
                let pct = cw
                    .and_then(|c| c.get("used_percentage"))
                    .and_then(Value::as_f64);
                let window = cw
                    .and_then(|c| c.get("context_window_size"))
                    .and_then(Value::as_u64);
                let used = cw
                    .and_then(|c| c.get("current_usage"))
                    .and_then(usage_tokens);
                pieces.push(piece(prefs, move |l| {
                    l.dim("ctx ");
                    let Some(p) = pct else {
                        l.dim("—");
                        return;
                    };
                    if l.prefs.context_bar {
                        l.push(l.tone(p), format!("{} ", bar(p)));
                    }
                    l.push(l.tone(p), format!("{}%", p.round()));
                    if let (true, Some(u), Some(w)) = (l.prefs.context_tokens, used, window) {
                        l.dim(format!(" {}/{}", compact(u), compact(w)));
                    }
                }));
            }
            StatuslineSegmentId::FiveHour => {
                if let Some(w) = from_stdin("five_hour").or(extras.five_hour) {
                    pieces.push(piece(prefs, move |l| l.limit("5h", w, now)));
                }
            }
            StatuslineSegmentId::Weekly => {
                if let Some(w) = from_stdin("seven_day").or(extras.seven_day) {
                    pieces.push(piece(prefs, move |l| l.limit("wk", w, now)));
                }
            }
            StatuslineSegmentId::ModelLimits => {
                for (model, w) in extras.scoped.iter().cloned() {
                    pieces.push(piece(prefs, move |l| l.limit(&model, w, now)));
                }
            }
            StatuslineSegmentId::SessionCost => {
                if let Some(c) = input
                    .get("cost")
                    .and_then(|c| c.get("total_cost_usd"))
                    .and_then(Value::as_f64)
                {
                    pieces.push(piece(prefs, move |l| l.plain(usd(c))));
                }
            }
            StatuslineSegmentId::TodayCost => {
                if let Some(t) = extras.today_usd {
                    pieces.push(piece(prefs, move |l| {
                        l.plain(usd(t));
                        l.dim(" today");
                    }));
                }
            }
            StatuslineSegmentId::Model => {
                if let Some(m) = input
                    .get("model")
                    .and_then(|m| m.get("display_name").or_else(|| m.get("id")))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                {
                    pieces.push(piece(prefs, move |l| l.plain(m)));
                }
            }
            StatuslineSegmentId::Folder => {
                if let Some(f) = current_dir(input).and_then(|d| {
                    Path::new(&d)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                }) {
                    pieces.push(piece(prefs, move |l| l.plain(f)));
                }
            }
            StatuslineSegmentId::Branch => {
                if let Some(b) = current_dir(input).and_then(|d| git_branch(Path::new(&d))) {
                    pieces.push(piece(prefs, move |l| {
                        l.dim("⎇ ");
                        l.plain(b);
                    }));
                }
            }
            StatuslineSegmentId::Unknown => {}
        }
        for spans in pieces {
            if !first {
                line.separator();
            }
            first = false;
            line.spans.extend(spans);
        }
    }
    line.spans
}

/// Spans → terminal text. Dim is SGR 2; tones map to green / yellow / red.
pub(crate) fn to_ansi(spans: &[StatuslineSpan], color: bool) -> String {
    spans
        .iter()
        .map(|s| {
            let code = match s.tone {
                StatuslineTone::Plain => None,
                StatuslineTone::Dim => Some("2"),
                StatuslineTone::Ok => Some("32"),
                StatuslineTone::Warn => Some("33"),
                StatuslineTone::Danger => Some("31"),
            };
            match (color, code) {
                (true, Some(c)) => format!("\x1b[{c}m{}\x1b[0m", s.text),
                _ => s.text.clone(),
            }
        })
        .collect()
}

fn current_dir(input: &Value) -> Option<String> {
    input
        .get("workspace")
        .and_then(|w| w.get("current_dir"))
        .or_else(|| input.get("cwd"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Current branch from `.git/HEAD`, walking up from `dir` — a file read, not
/// a `git` spawn, since this runs on every repaint. Linked worktrees have a
/// `.git` *file* pointing at their real git dir. Detached HEAD shows the
/// short commit.
fn git_branch(dir: &Path) -> Option<String> {
    let mut cur = Some(dir);
    while let Some(d) = cur {
        let dot_git = d.join(".git");
        let git_dir = if dot_git.is_dir() {
            Some(dot_git)
        } else if dot_git.is_file() {
            std::fs::read_to_string(&dot_git)
                .ok()?
                .trim()
                .strip_prefix("gitdir:")
                .map(|p| d.join(p.trim()))
        } else {
            None
        };
        if let Some(g) = git_dir {
            let head = std::fs::read_to_string(g.join("HEAD")).ok()?;
            let head = head.trim();
            return Some(match head.strip_prefix("ref: refs/heads/") {
                Some(branch) => branch.to_string(),
                None => head.chars().take(7).collect(),
            });
        }
        cur = d.parent();
    }
    None
}

fn usage_tokens(u: &Value) -> Option<u64> {
    let n = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let total = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    (total > 0).then_some(total)
}

fn bar(pct: f64) -> String {
    const CELLS: usize = 10;
    let filled = ((pct.clamp(0.0, 100.0) / 100.0) * CELLS as f64).round() as usize;
    format!("{}{}", "▓".repeat(filled), "░".repeat(CELLS - filled))
}

/// 340_000 → "340K", 1_000_000 → "1M", 1_260_000 → "1.3M".
fn compact(n: u64) -> String {
    if n >= 1_000_000 {
        let m = n as f64 / 1_000_000.0;
        if (m - m.round()).abs() < 0.05 {
            format!("{}M", m.round())
        } else {
            format!("{m:.1}M")
        }
    } else if n >= 1_000 {
        format!("{}K", (n as f64 / 1_000.0).round())
    } else {
        n.to_string()
    }
}

fn usd(v: f64) -> String {
    format!("${v:.2}")
}

fn until(secs: i64) -> String {
    let secs = secs.max(0);
    if secs < 3600 {
        format!("{}m", (secs / 60).max(1))
    } else if secs < 86_400 {
        format!("{}h", (secs as f64 / 3600.0).round())
    } else {
        format!("{}d", (secs as f64 / 86_400.0).round())
    }
}

// ── Chained status line ────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct ChainRecord {
    /// The user's `statusLine` object as it was before we installed.
    previous: Value,
}

fn run_chained(stdin_raw: &str) -> Option<String> {
    let rec: ChainRecord = serde_json::from_value(read_json(chain_file())?).ok()?;
    let cmd = rec.previous.get("command")?.as_str()?.to_string();
    if is_ours(&cmd) {
        return None; // never recurse into ourselves
    }
    let mut child = shell(&cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_raw.as_bytes());
    }
    let mut stdout = child.stdout.take()?;
    // Read on a thread: a chatty child would otherwise block on a full pipe
    // while we wait for it to exit.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let deadline = Instant::now() + CHAIN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    rx.recv_timeout(Duration::from_millis(200))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

fn shell(cmd: &str) -> Command {
    #[cfg(windows)]
    {
        use crate::process_ext::NoWindow;
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", cmd]).no_window();
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", cmd]);
        c
    }
}

// ── Session context records ────────────────────────────────────────────

/// Context window facts Claude Code reported for one session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RecordedContext {
    pub window_tokens: u64,
    pub used_tokens: Option<u64>,
    pub used_percent: Option<f64>,
    pub model: Option<String>,
    pub written_unix: i64,
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn record_session(input: &Value) {
    let Some(sid) = input.get("session_id").and_then(Value::as_str) else {
        return;
    };
    let Some(dir) = contexts_dir() else {
        return;
    };
    let cw = input.get("context_window");
    let Some(window) = cw
        .and_then(|c| c.get("context_window_size"))
        .and_then(Value::as_u64)
    else {
        return;
    };
    let rec = RecordedContext {
        window_tokens: window,
        used_tokens: cw
            .and_then(|c| c.get("current_usage"))
            .and_then(usage_tokens),
        used_percent: cw
            .and_then(|c| c.get("used_percentage"))
            .and_then(Value::as_f64),
        model: input
            .get("model")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        written_unix: now_secs(),
    };
    let _ = write_record(&dir, sid, &rec);
}

fn write_record(dir: &Path, sid: &str, rec: &RecordedContext) -> Result<()> {
    if !valid_session_id(sid) {
        bail!("invalid session id");
    }
    let path = dir.join(format!("{sid}.json"));
    let is_new = !path.exists();
    write_atomic(&path, &serde_json::to_string(rec)?)?;
    // Prune on first sight of a session: rare enough to be free, frequent
    // enough that the directory never grows past a week of sessions.
    if is_new {
        prune_records(dir, now_secs());
    }
    Ok(())
}

fn prune_records(dir: &Path, now: i64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .is_some_and(|d| now - d.as_secs() as i64 > RECORD_TTL_SECS);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The last context facts the status line recorded for `session_id`.
pub(crate) fn recorded_context(session_id: &str) -> Option<RecordedContext> {
    if !valid_session_id(session_id) {
        return None;
    }
    let path = contexts_dir()?.join(format!("{session_id}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

// ── Today's cost snapshot ──────────────────────────────────────────────

static LAST_SNAPSHOT: AtomicI64 = AtomicI64::new(0);

/// Record today's all-tools spend for the status line. `by_day` is the Costs
/// page's 30-day series, oldest → newest, so its last bucket is today.
pub(crate) fn write_snapshot(by_day: &[f64]) {
    let Some(path) = snapshot_file() else {
        return;
    };
    let now = now_secs();
    LAST_SNAPSHOT.store(now, Ordering::Relaxed);
    let snap = serde_json::json!({
        "day": chrono::Local::now().format("%Y-%m-%d").to_string(),
        "today_usd": by_day.last().copied().unwrap_or(0.0),
        "written_unix": now,
    });
    let _ = write_atomic(&path, &snap.to_string());
}

/// Whether the menu-bar loop should re-scan costs for the snapshot: only
/// when the Claude status line is installed, and at most every few minutes.
pub(crate) fn snapshot_due() -> bool {
    now_secs() - LAST_SNAPSHOT.load(Ordering::Relaxed) >= SNAPSHOT_INTERVAL_SECS
        && claude_settings_file()
            .and_then(|p| read_claude_settings(&p).ok())
            .and_then(|s| status_command(&s))
            .is_some_and(|c| is_ours(&c))
}

// ── Claude install / uninstall ─────────────────────────────────────────

/// Our commands contain the app binary's path and the `statusline` verb.
fn is_ours(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    c.contains("lunopeak") && c.contains(" statusline")
}

fn status_command(settings: &Value) -> Option<String> {
    settings
        .get("statusLine")?
        .get("command")?
        .as_str()
        .map(str::to_string)
}

/// Path to invoke, or why this copy of the app can't be installed.
fn our_exe() -> Result<String> {
    let exe = std::env::current_exe().context("can't locate the LunoPeak binary")?;
    let s = exe.to_string_lossy().to_string();
    // Gatekeeper runs quarantined apps from a randomized read-only path that
    // disappears on relaunch; a DMG mount disappears on eject.
    if s.contains("/AppTranslocation/") || s.starts_with("/Volumes/") {
        bail!("Move LunoPeak into Applications first — it's running from a temporary location, so the path would stop working.");
    }
    Ok(s)
}

fn command_for(exe: &str, chain: bool) -> String {
    let suffix = if chain {
        " statusline --chain"
    } else {
        " statusline"
    };
    if cfg!(windows) {
        // Claude Code runs this through Git Bash when present, which eats
        // backslashes — forward slashes work under both shells.
        format!("\"{}\"{suffix}", exe.replace('\\', "/"))
    } else {
        format!("'{}'{suffix}", exe.replace('\'', r"'\''"))
    }
}

fn read_claude_settings(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Value::Object(Default::default())),
        Ok(raw) => {
            let v: Value = serde_json::from_str(&raw).with_context(|| {
                format!(
                    "{} isn't valid JSON — fix it before enabling this",
                    path.display()
                )
            })?;
            if !v.is_object() {
                bail!("{} isn't a JSON object", path.display());
            }
            Ok(v)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(e.into()),
    }
}

fn write_claude_settings(path: &Path, v: &Value) -> Result<()> {
    write_atomic(path, &(serde_json::to_string_pretty(v)? + "\n"))
}

fn install_claude_at(settings_path: &Path, chain_path: &Path, exe: &str) -> Result<()> {
    let mut settings = read_claude_settings(settings_path)?;
    if settings_path.exists() {
        let _ = std::fs::copy(
            settings_path,
            settings_path.with_extension("json.lunopeak-bak"),
        );
    }
    let existing = settings.get("statusLine").cloned();
    let existing_cmd = existing
        .as_ref()
        .and_then(|s| s.get("command"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let chained = match (&existing, &existing_cmd) {
        // Re-install / path repair: keep whatever chain we already recorded.
        (_, Some(c)) if is_ours(c) => chain_path.exists(),
        (Some(prev), Some(_)) => {
            let rec = ChainRecord {
                previous: prev.clone(),
            };
            write_atomic(chain_path, &serde_json::to_string_pretty(&rec)?)?;
            true
        }
        _ => false,
    };

    let mut line = serde_json::json!({
        "type": "command",
        "command": command_for(exe, chained),
    });
    // Keep the chained line's layout knobs so it renders as it did.
    if chained {
        let prev =
            read_json(Some(chain_path.to_path_buf())).and_then(|r| r.get("previous").cloned());
        for key in ["padding", "refreshInterval"] {
            if let Some(v) = prev.as_ref().and_then(|p| p.get(key)) {
                line[key] = v.clone();
            }
        }
    }
    settings
        .as_object_mut()
        .ok_or_else(|| anyhow!("settings is not an object"))?
        .insert("statusLine".into(), line);
    write_claude_settings(settings_path, &settings)
}

fn uninstall_claude_at(settings_path: &Path, chain_path: &Path) -> Result<()> {
    let mut settings = read_claude_settings(settings_path)?;
    if !status_command(&settings).is_some_and(|c| is_ours(&c)) {
        let _ = std::fs::remove_file(chain_path);
        return Ok(());
    }
    let previous =
        read_json(Some(chain_path.to_path_buf())).and_then(|r| r.get("previous").cloned());
    let obj = settings
        .as_object_mut()
        .ok_or_else(|| anyhow!("settings is not an object"))?;
    match previous {
        Some(prev) => {
            obj.insert("statusLine".into(), prev);
        }
        None => {
            obj.remove("statusLine");
        }
    }
    write_claude_settings(settings_path, &settings)?;
    let _ = std::fs::remove_file(chain_path);
    Ok(())
}

fn claude_status() -> ClaudeStatusline {
    let path = claude_settings_file();
    let available = path
        .as_ref()
        .and_then(|p| p.parent())
        .is_some_and(Path::is_dir);
    let settings = path.as_deref().and_then(|p| read_claude_settings(p).ok());
    let cmd = settings.as_ref().and_then(status_command);
    let installed = cmd.as_deref().is_some_and(is_ours);
    let exe = our_exe();
    let chained_command = if installed {
        read_json(chain_file()).and_then(|r| {
            r.get("previous")?
                .get("command")?
                .as_str()
                .map(str::to_string)
        })
    } else {
        None
    };
    ClaudeStatusline {
        available,
        installed,
        // Our command starts with this binary's quoted path; if it doesn't,
        // the app has moved since install.
        stale_path: installed
            && exe.as_ref().is_ok_and(|e| {
                let quoted = command_for(e, false);
                let quoted = quoted.trim_end_matches(" statusline");
                !cmd.as_deref().unwrap_or("").starts_with(quoted)
            }),
        other_command: cmd.filter(|c| !is_ours(c)),
        chained_command,
        blocked_reason: exe.err().map(|e| e.to_string()),
        settings_path: path.map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

// ── Codex install / uninstall ──────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct CodexPrev {
    /// TOML source of the previous `tui.status_line` value, if any.
    previous: Option<String>,
}

fn read_codex_doc(path: &Path) -> Result<toml_edit::DocumentMut> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    raw.parse::<toml_edit::DocumentMut>().with_context(|| {
        format!(
            "{} isn't valid TOML — fix it before enabling this",
            path.display()
        )
    })
}

fn codex_items(doc: &toml_edit::DocumentMut) -> Option<Vec<String>> {
    let arr = doc.get("tui")?.get("status_line")?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
    )
}

fn codex_is_ours(doc: &toml_edit::DocumentMut) -> bool {
    codex_items(doc).is_some_and(|items| items.iter().map(String::as_str).eq(CODEX_ITEMS))
}

/// The `[tui]` table, created (or promoted from an implicit dotted parent
/// like `[tui.model_availability_nux]`) so keys set on it are written out.
fn tui_table(doc: &mut toml_edit::DocumentMut) -> Result<&mut toml_edit::Table> {
    if doc.get("tui").is_none() {
        doc.insert("tui", toml_edit::table());
    }
    let tui = doc["tui"]
        .as_table_mut()
        .ok_or_else(|| anyhow!("`tui` in config.toml isn't a table"))?;
    tui.set_implicit(false);
    Ok(tui)
}

fn install_codex_at(config_path: &Path, prev_path: &Path) -> Result<()> {
    let mut doc = read_codex_doc(config_path)?;
    if !codex_is_ours(&doc) {
        let previous = doc
            .get("tui")
            .and_then(|t| t.get("status_line"))
            .and_then(|i| i.as_value())
            .map(|v| v.to_string().trim().to_string());
        write_atomic(prev_path, &serde_json::to_string(&CodexPrev { previous })?)?;
    }
    let arr: toml_edit::Array = CODEX_ITEMS.iter().copied().collect();
    tui_table(&mut doc)?.insert("status_line", toml_edit::value(arr));
    write_atomic(config_path, &doc.to_string())
}

fn uninstall_codex_at(config_path: &Path, prev_path: &Path) -> Result<()> {
    let mut doc = read_codex_doc(config_path)?;
    if !codex_is_ours(&doc) {
        let _ = std::fs::remove_file(prev_path);
        return Ok(());
    }
    let previous = read_json(Some(prev_path.to_path_buf()))
        .and_then(|v| serde_json::from_value::<CodexPrev>(v).ok())
        .and_then(|p| p.previous);
    let tui = tui_table(&mut doc)?;
    match previous.and_then(|src| format!("v = {src}").parse::<toml_edit::DocumentMut>().ok()) {
        Some(parsed) => {
            if let Some(v) = parsed.get("v").and_then(|i| i.as_value()).cloned() {
                tui.insert("status_line", toml_edit::Item::Value(v));
            }
        }
        None => {
            tui.remove("status_line");
        }
    }
    write_atomic(config_path, &doc.to_string())?;
    let _ = std::fs::remove_file(prev_path);
    Ok(())
}

fn codex_status() -> CodexStatusline {
    let path = codex_config_file();
    let available = path
        .as_ref()
        .and_then(|p| p.parent())
        .is_some_and(Path::is_dir);
    let doc = path.as_deref().and_then(|p| read_codex_doc(p).ok());
    CodexStatusline {
        available,
        installed: doc.as_ref().is_some_and(codex_is_ours),
        current_items: doc.as_ref().and_then(codex_items).unwrap_or_default(),
        config_path: path.map(|p| p.display().to_string()).unwrap_or_default(),
    }
}

// ── Public API for commands ────────────────────────────────────────────

pub fn status() -> TerminalIntegrations {
    TerminalIntegrations {
        claude: claude_status(),
        codex: codex_status(),
    }
}

pub fn set_claude(enabled: bool) -> Result<()> {
    let settings = claude_settings_file().ok_or_else(|| anyhow!("no home directory"))?;
    let chain = chain_file().ok_or_else(|| anyhow!("no config directory"))?;
    if enabled {
        if !settings.parent().is_some_and(Path::is_dir) {
            bail!("Claude Code isn't set up on this machine (no ~/.claude folder).");
        }
        install_claude_at(&settings, &chain, &our_exe()?)
    } else {
        uninstall_claude_at(&settings, &chain)
    }
}

pub fn set_codex(enabled: bool) -> Result<()> {
    let config = codex_config_file().ok_or_else(|| anyhow!("no home directory"))?;
    let prev = codex_prev_file().ok_or_else(|| anyhow!("no config directory"))?;
    if enabled {
        if !config.parent().is_some_and(Path::is_dir) {
            bail!("Codex isn't set up on this machine (no ~/.codex folder).");
        }
        install_codex_at(&config, &prev)
    } else {
        uninstall_codex_at(&config, &prev)
    }
}

/// Sample line for Settings' live preview: a mid-session payload rendered
/// with `prefs` and the real limits and cost the terminal would show now.
/// Limits the account doesn't have yet are filled with sample values so every
/// enabled segment is visible while the user arranges them.
pub fn preview(prefs: &StatuslinePrefs) -> Vec<StatuslineSpan> {
    let now = now_secs();
    let mut extras = Extras::load();
    if extras.scoped.is_empty() {
        extras.scoped.push((
            "Fable".into(),
            Window {
                pct: 63.0,
                reset: Some(now + 4 * 86_400),
            },
        ));
    }
    extras.today_usd.get_or_insert(4.21);
    let cwd = std::env::current_dir()
        .ok()
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    let sample = serde_json::json!({
        "model": { "display_name": "Opus 5.5" },
        "workspace": { "current_dir": cwd },
        "context_window": {
            "used_percentage": 34.0,
            "context_window_size": 1_000_000,
            "current_usage": { "input_tokens": 4_000, "cache_read_input_tokens": 336_000 }
        },
        "rate_limits": {
            "five_hour": { "used_percentage": extras.five_hour.map_or(41.0, |w| w.pct), "resets_at": now + 2 * 3600 },
            "seven_day": { "used_percentage": extras.seven_day.map_or(28.0, |w| w.pct), "resets_at": now + 4 * 86_400 }
        },
        "cost": { "total_cost_usd": 1.2 }
    });
    render_spans(&sample, &extras, &prefs.clone().normalized())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::StatuslineSegment;

    fn sample() -> Value {
        serde_json::json!({
            "session_id": "abc-123",
            "model": { "id": "claude-opus-5-5", "display_name": "Opus 5.5" },
            "context_window": {
                "used_percentage": 34.2,
                "context_window_size": 1_000_000,
                "current_usage": {
                    "input_tokens": 2,
                    "cache_creation_input_tokens": 3_998,
                    "cache_read_input_tokens": 336_000,
                    "output_tokens": 500
                }
            },
            "rate_limits": {
                "five_hour": { "used_percentage": 41.0, "resets_at": now_secs() + 7200 },
                "seven_day": { "used_percentage": 88.0, "resets_at": now_secs() + 3 * 86_400 }
            },
            "cost": { "total_cost_usd": 1.2 }
        })
    }

    fn text(spans: &[StatuslineSpan]) -> String {
        to_ansi(spans, false)
    }

    fn fable_and_today() -> Extras {
        Extras {
            scoped: vec![(
                "Fable".into(),
                Window {
                    pct: 63.0,
                    reset: None,
                },
            )],
            today_usd: Some(4.21),
            ..Default::default()
        }
    }

    #[test]
    fn renders_default_segments() {
        let line = text(&render_spans(
            &sample(),
            &fable_and_today(),
            &StatuslinePrefs::default(),
        ));
        assert_eq!(
            line,
            "ctx ▓▓▓░░░░░░░ 34% 340K/1M │ 5h 41% │ wk 88% ↻3d │ Fable 63% │ $1.20 │ $4.21 today"
        );
    }

    #[test]
    fn follows_order_toggles_and_style_prefs() {
        let mut prefs = StatuslinePrefs::default();
        // Weekly first, context second, everything else off.
        prefs.segments = vec![
            StatuslineSegment {
                id: StatuslineSegmentId::Weekly,
                enabled: true,
            },
            StatuslineSegment {
                id: StatuslineSegmentId::Context,
                enabled: true,
            },
            StatuslineSegment {
                id: StatuslineSegmentId::FiveHour,
                enabled: false,
            },
            StatuslineSegment {
                id: StatuslineSegmentId::Model,
                enabled: true,
            },
        ];
        prefs.context_bar = false;
        prefs.context_tokens = false;
        prefs.reset_hint = StatuslineResetHint::Never;
        prefs.separator = StatuslineSeparator::Dot;
        let line = text(&render_spans(&sample(), &Extras::default(), &prefs));
        assert_eq!(line, "wk 88% · ctx 34% · Opus 5.5");
    }

    #[test]
    fn thresholds_set_the_tones() {
        let mut prefs = StatuslinePrefs::default();
        prefs.segments = vec![StatuslineSegment {
            id: StatuslineSegmentId::FiveHour,
            enabled: true,
        }];
        let tone = |p: &StatuslinePrefs| {
            render_spans(&sample(), &Extras::default(), p)
                .into_iter()
                .find(|s| s.text == "41%")
                .unwrap()
                .tone
        };
        assert_eq!(tone(&prefs), StatuslineTone::Ok);
        prefs.warn_percent = 40;
        assert_eq!(tone(&prefs), StatuslineTone::Warn);
        prefs.danger_percent = 41;
        assert_eq!(tone(&prefs), StatuslineTone::Danger);
    }

    #[test]
    fn reset_hint_always_shows_even_when_low() {
        let mut prefs = StatuslinePrefs::default();
        prefs.segments = vec![StatuslineSegment {
            id: StatuslineSegmentId::FiveHour,
            enabled: true,
        }];
        prefs.reset_hint = StatuslineResetHint::Always;
        assert_eq!(
            text(&render_spans(&sample(), &Extras::default(), &prefs)),
            "5h 41% ↻2h"
        );
    }

    #[test]
    fn empty_segments_leave_no_dangling_separator() {
        let input = serde_json::json!({ "context_window": { "used_percentage": null } });
        let extras = Extras {
            five_hour: Some(Window {
                pct: 12.0,
                reset: None,
            }),
            ..Default::default()
        };
        // Weekly, Fable and both costs have no data here and drop out.
        assert_eq!(
            text(&render_spans(&input, &extras, &StatuslinePrefs::default())),
            "ctx — │ 5h 12%"
        );
    }

    #[test]
    fn colors_only_when_asked() {
        let spans = render_spans(&sample(), &Extras::default(), &StatuslinePrefs::default());
        assert!(to_ansi(&spans, true).contains("\x1b[31m")); // 88% weekly is red
        assert!(!to_ansi(&spans, false).contains('\x1b'));
    }

    #[test]
    fn saved_prefs_normalize() {
        // A newer build's unknown segment, a duplicate, and inverted thresholds.
        let v = serde_json::json!({
            "segments": [
                { "id": "weekly", "enabled": true },
                { "id": "sparkles", "enabled": true },
                { "id": "weekly", "enabled": false }
            ],
            "warnPercent": 90,
            "dangerPercent": 50
        });
        let p = serde_json::from_value::<StatuslinePrefs>(v)
            .unwrap()
            .normalized();
        assert_eq!(
            p.segments[0],
            StatuslineSegment {
                id: StatuslineSegmentId::Weekly,
                enabled: true
            }
        );
        assert_eq!(p.segments.len(), StatuslineSegmentId::ALL.len());
        // Segments the saved list predates come back switched off.
        assert!(p.segments[1..].iter().all(|s| !s.enabled));
        assert!(p.warn_percent < p.danger_percent);
        // Fields the saved prefs lack take their defaults.
        assert!(p.context_bar && p.color);
    }

    #[test]
    fn reads_branch_from_head_including_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/feat/context\n").unwrap();
        std::fs::create_dir_all(repo.join("src/deep")).unwrap();
        assert_eq!(
            git_branch(&repo.join("src/deep")).as_deref(),
            Some("feat/context")
        );

        let wt = dir.path().join("wt");
        let wt_git = dir.path().join("gitdirs/wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&wt_git).unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", wt_git.display())).unwrap();
        std::fs::write(wt_git.join("HEAD"), "0123456789abcdef\n").unwrap();
        assert_eq!(git_branch(&wt).as_deref(), Some("0123456"));
    }

    #[test]
    fn compact_and_bar() {
        assert_eq!(compact(340_000), "340K");
        assert_eq!(compact(1_000_000), "1M");
        assert_eq!(compact(1_260_000), "1.3M");
        assert_eq!(compact(999), "999");
        assert_eq!(bar(0.0), "░░░░░░░░░░");
        assert_eq!(bar(100.0), "▓▓▓▓▓▓▓▓▓▓");
    }

    #[test]
    fn session_ids_cannot_escape_the_records_dir() {
        assert!(valid_session_id("7e4a5a84-e57f-413a-8963-e70c00331349"));
        assert!(!valid_session_id("../../etc/passwd"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn records_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let rec = RecordedContext {
            window_tokens: 1_000_000,
            used_tokens: Some(340_000),
            used_percent: Some(34.0),
            model: Some("claude-opus-5-5".into()),
            written_unix: now_secs(),
        };
        write_record(dir.path(), "abc-123", &rec).unwrap();
        let back: RecordedContext = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("abc-123.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(back.window_tokens, 1_000_000);
        assert!(write_record(dir.path(), "../x", &rec).is_err());
    }

    #[test]
    fn command_quotes_paths_with_spaces() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(
            command_for("/Applications/Luno Peak.app/Contents/MacOS/LunoPeak", true),
            "'/Applications/Luno Peak.app/Contents/MacOS/LunoPeak' statusline --chain"
        );
        assert!(is_ours(&command_for(
            "/Applications/LunoPeak.app/Contents/MacOS/LunoPeak",
            false
        )));
        assert!(!is_ours("npx -y ccstatusline@latest"));
    }

    #[test]
    fn claude_install_fresh_then_uninstall_removes_key() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let chain = dir.path().join("chain.json");
        std::fs::write(&settings, r#"{"model":"opus","env":{"A":"1"}}"#).unwrap();

        install_claude_at(&settings, &chain, "/Apps/LunoPeak").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["statusLine"]["command"], "'/Apps/LunoPeak' statusline");
        assert_eq!(v["model"], "opus");
        assert!(!chain.exists());
        // Key order is preserved: the user's keys stay first.
        let raw = std::fs::read_to_string(&settings).unwrap();
        assert!(raw.find("\"model\"").unwrap() < raw.find("\"statusLine\"").unwrap());

        uninstall_claude_at(&settings, &chain).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(v.get("statusLine").is_none());
        assert_eq!(v["env"]["A"], "1");
    }

    #[test]
    fn claude_install_chains_existing_and_uninstall_restores_it() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        let chain = dir.path().join("chain.json");
        std::fs::write(
            &settings,
            r#"{"statusLine":{"type":"command","command":"npx -y ccstatusline@latest","padding":1}}"#,
        )
        .unwrap();

        install_claude_at(&settings, &chain, "/Apps/LunoPeak").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            v["statusLine"]["command"],
            "'/Apps/LunoPeak' statusline --chain"
        );
        assert_eq!(v["statusLine"]["padding"], 1);

        // Re-installing (e.g. after the app moved) keeps the chain.
        install_claude_at(&settings, &chain, "/Applications/LunoPeak").unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            v["statusLine"]["command"],
            "'/Applications/LunoPeak' statusline --chain"
        );

        uninstall_claude_at(&settings, &chain).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["statusLine"]["command"], "npx -y ccstatusline@latest");
        assert!(!chain.exists());
    }

    #[test]
    fn claude_install_refuses_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, "{ not json").unwrap();
        assert!(install_claude_at(&settings, &dir.path().join("c.json"), "/x/LunoPeak").is_err());
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{ not json");
    }

    #[test]
    fn codex_install_promotes_implicit_tui_and_restores_previous() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let prev = dir.path().join("prev.json");
        let original =
            "# my config\nmodel = \"gpt-5.5\"\n\n[tui.model_availability_nux]\nseen = true\n";
        std::fs::write(&config, original).unwrap();

        install_codex_at(&config, &prev).unwrap();
        let raw = std::fs::read_to_string(&config).unwrap();
        assert!(raw.contains("# my config"));
        let doc = read_codex_doc(&config).unwrap();
        assert!(codex_is_ours(&doc));
        assert_eq!(
            doc["tui"]["model_availability_nux"]["seen"].as_bool(),
            Some(true)
        );

        uninstall_codex_at(&config, &prev).unwrap();
        let doc = read_codex_doc(&config).unwrap();
        assert!(doc["tui"].get("status_line").is_none());
        assert_eq!(doc["model"].as_str(), Some("gpt-5.5"));
    }

    #[test]
    fn codex_uninstall_puts_back_a_custom_item_list() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.toml");
        let prev = dir.path().join("prev.json");
        std::fs::write(
            &config,
            "[tui]\nstatus_line = [\"model-name\", \"current-dir\"]\n",
        )
        .unwrap();

        install_codex_at(&config, &prev).unwrap();
        uninstall_codex_at(&config, &prev).unwrap();
        let doc = read_codex_doc(&config).unwrap();
        assert_eq!(
            codex_items(&doc).unwrap(),
            vec!["model-name", "current-dir"]
        );
    }
}
