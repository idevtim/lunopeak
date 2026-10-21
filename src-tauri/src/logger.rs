//! Persistent, bounded runtime log shared by the Rust backend and the React
//! frontend. Backend errors reach it through the [`elog!`] macro; the frontend
//! forwards entries over IPC (`append_log_entry`). The diagnostics export reads
//! the recent slice back via `read_diagnostics_log`.
//!
//! The on-disk format is JSON Lines (one [`LogEntry`] per line) in
//! `{app_config_dir}/logs/diagnostics.jsonl`, capped by size with a single
//! rotated generation (`diagnostics.jsonl.1`). Logging is best-effort: a failed
//! write is swallowed so it can never affect app behavior.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// One structured log line. Mirrored 1:1 by `LogEntry` in `src/types/api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// RFC3339 timestamp.
    pub ts: String,
    /// "error" | "warn" | "info".
    pub level: String,
    /// "backend" | "frontend".
    pub source: String,
    /// Subsystem tag, e.g. "tray" — the old `eprintln!("[tray] …")` prefix.
    pub scope: String,
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Roughly 1 MB per file; with one rotated generation total on-disk is ~2 MB.
const MAX_BYTES: u64 = 1_000_000;

/// Set once at startup by [`init`]. The shared `Mutex` serializes the
/// read-rotate-append sequence so concurrent backend + frontend writes don't
/// interleave or race the rotation.
static LOG_FILE: OnceLock<Mutex<PathBuf>> = OnceLock::new();

/// Path of the rotated backup for a given primary log path (append `.1`).
fn rotated_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".1");
    path.with_file_name(name)
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Resolve `{app_config_dir}/logs/diagnostics.jsonl`, create the directory, and
/// remember the path for the lifetime of the process. Safe to call once at
/// startup; logs a startup marker so every export shows when the session began.
pub fn init(app: &AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let logs_dir = config_dir.join("logs");
    if fs::create_dir_all(&logs_dir).is_err() {
        return;
    }
    let _ = LOG_FILE.set(Mutex::new(logs_dir.join("diagnostics.jsonl")));
    log("info", "app", format!("LunoPeak {} started", env!("CARGO_PKG_VERSION")));
}

/// Rotate-if-needed, then append one already-scrubbed entry as a JSONL line.
fn append_entry(path: &Path, entry: &LogEntry) -> std::io::Result<()> {
    rotate_if_needed(path, MAX_BYTES)?;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{}", format_entry(entry))
}

/// Scrub, rotate-if-needed, and append one entry under the shared lock. Every
/// failure is swallowed — logging must never affect app behavior. In debug
/// builds the entry is also echoed to stderr so `tauri:dev` keeps its console.
fn write_entry(mut entry: LogEntry) {
    entry.msg = scrub_secrets(&entry.msg);
    #[cfg(debug_assertions)]
    eprintln!("[{}] {}", entry.scope, entry.msg);
    let Some(path) = LOG_FILE.get().and_then(|lock| lock.lock().ok()) else {
        return;
    };
    let _ = append_entry(&path, &entry);
}

/// Record a backend log line. Prefer the [`elog!`] macro at call sites.
pub fn log(level: &str, scope: &str, msg: String) {
    write_entry(LogEntry {
        ts: now_rfc3339(),
        level: level.to_string(),
        source: "backend".to_string(),
        scope: scope.to_string(),
        msg,
        detail: None,
    });
}

/// Record a frontend log line forwarded over IPC (`append_log_entry`).
pub fn log_frontend(level: String, scope: String, msg: String, detail: Option<String>) {
    write_entry(LogEntry {
        ts: now_rfc3339(),
        level,
        source: "frontend".to_string(),
        scope,
        msg,
        detail,
    });
}

/// Read the recent slice of the live log for the diagnostics export. Returns an
/// empty vec before [`init`] has run (e.g. browser-only dev).
pub fn read_current(max: usize) -> Vec<LogEntry> {
    match LOG_FILE.get().and_then(|lock| lock.lock().ok()) {
        Some(path) => read_recent(&path, max),
        None => Vec::new(),
    }
}

/// Backend logging: `elog!(error, "tray", "install failed: {err}")`. The level
/// is an identifier (`error` / `warn` / `info`); the scope replaces the old
/// `[scope]` stderr prefix; the rest is `format!`-style args.
#[macro_export]
macro_rules! elog {
    ($level:ident, $scope:expr, $($arg:tt)*) => {
        $crate::logger::log(stringify!($level), $scope, format!($($arg)*))
    };
}

/// Redact obvious secret shapes from a log message: any whitespace-delimited
/// token beginning with `sk-` (OpenAI / Anthropic keys) and the token that
/// follows a case-insensitive `bearer`.
pub fn scrub_secrets(input: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut redact_next = false;
    for tok in input.split_whitespace() {
        let cleaned = if redact_next {
            redact_next = false;
            "***".to_string()
        } else if tok.starts_with("sk-") {
            "sk-***".to_string()
        } else {
            tok.to_string()
        };
        if tok.eq_ignore_ascii_case("bearer") {
            redact_next = true;
        }
        out.push(cleaned);
    }
    out.join(" ")
}

/// Parse JSON Lines into entries, silently skipping blank or malformed lines so
/// a single corrupt write never poisons the whole export.
pub fn parse_entries(text: &str) -> Vec<LogEntry> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
        .collect()
}

/// Keep only the newest `max` entries (assumes input is oldest-first).
pub fn take_recent(mut entries: Vec<LogEntry>, max: usize) -> Vec<LogEntry> {
    if entries.len() > max {
        entries.drain(0..entries.len() - max);
    }
    entries
}

/// Serialize one entry to a single JSONL line (no trailing newline).
pub fn format_entry(entry: &LogEntry) -> String {
    serde_json::to_string(entry).unwrap_or_default()
}

/// When `path` exceeds `max_bytes`, move it to its `.1` backup (overwriting any
/// previous backup) so the next append starts a fresh file. No-op if the file
/// is missing or under the cap.
pub fn rotate_if_needed(path: &Path, max_bytes: u64) -> std::io::Result<()> {
    let Ok(meta) = fs::metadata(path) else {
        return Ok(());
    };
    if meta.len() <= max_bytes {
        return Ok(());
    }
    fs::rename(path, rotated_path(path))
}

/// Read the recent log slice (oldest-first): the rotated backup followed by the
/// live file, parsed, secret-scrubbed, truncated to `max` newest entries.
pub fn read_recent(path: &Path, max: usize) -> Vec<LogEntry> {
    let mut text = String::new();
    if let Ok(backup) = fs::read_to_string(rotated_path(path)) {
        text.push_str(&backup);
    }
    if let Ok(main) = fs::read_to_string(path) {
        text.push_str(&main);
    }
    let mut entries = parse_entries(&text);
    for e in &mut entries {
        e.msg = scrub_secrets(&e.msg);
    }
    take_recent(entries, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(level: &str, msg: &str) -> LogEntry {
        LogEntry {
            ts: "2026-06-23T00:00:00Z".into(),
            level: level.into(),
            source: "backend".into(),
            scope: "test".into(),
            msg: msg.into(),
            detail: None,
        }
    }

    #[test]
    fn scrub_redacts_openai_style_key() {
        let out = scrub_secrets("auth failed with key sk-ant-abc123XYZ tail");
        assert!(!out.contains("abc123XYZ"), "key leaked: {out}");
        assert!(out.contains("sk-***"));
        assert!(out.contains("tail"));
    }

    #[test]
    fn scrub_redacts_token_after_bearer() {
        let out = scrub_secrets("header Bearer eyJ.tok.en done");
        assert!(!out.contains("eyJ.tok.en"), "token leaked: {out}");
        assert!(out.contains("Bearer ***"));
        assert!(out.contains("done"));
    }

    #[test]
    fn scrub_leaves_ordinary_text_untouched() {
        assert_eq!(scrub_secrets("tray install failed: oops"), "tray install failed: oops");
    }

    #[test]
    fn parse_skips_malformed_lines() {
        let valid = format_entry(&entry("error", "a"));
        let text = format!("{valid}\nnot json\n\n{valid}");
        assert_eq!(parse_entries(&text).len(), 2);
    }

    #[test]
    fn format_round_trips_through_parse() {
        let e = entry("warn", "hello world");
        let parsed = parse_entries(&format_entry(&e));
        assert_eq!(parsed, vec![e]);
    }

    #[test]
    fn take_recent_keeps_newest() {
        let entries: Vec<_> = (0..5).map(|i| entry("info", &i.to_string())).collect();
        let recent = take_recent(entries, 2);
        let msgs: Vec<_> = recent.iter().map(|e| e.msg.as_str()).collect();
        assert_eq!(msgs, vec!["3", "4"]);
    }

    #[test]
    fn rotate_moves_file_to_backup_when_over_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        fs::write(&path, "x".repeat(20)).unwrap();
        rotate_if_needed(&path, 10).unwrap();
        assert!(!path.exists(), "primary should be rotated away");
        assert!(rotated_path(&path).exists(), "backup should exist");
    }

    #[test]
    fn rotate_is_noop_under_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        fs::write(&path, "x".repeat(5)).unwrap();
        rotate_if_needed(&path, 10).unwrap();
        assert!(path.exists());
        assert!(!rotated_path(&path).exists());
    }

    #[test]
    fn append_entry_round_trips_through_read_recent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        append_entry(&path, &entry("info", "first")).unwrap();
        append_entry(&path, &entry("error", "second")).unwrap();
        let got = read_recent(&path, 10);
        let msgs: Vec<_> = got.iter().map(|e| e.msg.as_str()).collect();
        assert_eq!(msgs, vec!["first", "second"]);
    }

    #[test]
    fn read_recent_merges_backup_then_main_and_scrubs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("diagnostics.jsonl");
        fs::write(&rotated_path(&path), format!("{}\n", format_entry(&entry("info", "old")))).unwrap();
        let secret = format_entry(&entry("error", "leaked sk-secret123 here"));
        fs::write(&path, format!("{secret}\n")).unwrap();

        let got = read_recent(&path, 10);
        let msgs: Vec<_> = got.iter().map(|e| e.msg.as_str()).collect();
        assert_eq!(msgs[0], "old", "backup entries come first");
        assert!(msgs[1].contains("sk-***"), "secret not scrubbed: {:?}", msgs[1]);
        assert!(!msgs[1].contains("secret123"));
    }
}
