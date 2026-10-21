//! Per-session live activity scan of Cursor's chat database.
//!
//! Cursor stores chat history in a SQLite database at
//! `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
//! (and platform equivalents). The schema is undocumented and version-tied,
//! but stable enough to mine for what we need:
//!
//! - `ItemTable["composer.composerHeaders"]` — JSON list of every chat
//!   "composer" (Cursor's term for a session) with name, lastUpdatedAt,
//!   workspaceIdentifier (which gives us the cwd), createdAt, etc.
//! - `cursorDiskKV` — bubble-by-bubble chat content keyed
//!   `bubbleId:<composerId>:<bubbleId>`. Each bubble has `text`, `type`
//!   (1=user, 2=assistant), `createdAt`.
//!
//! We open the DB read-only with `mode=ro&immutable=1` so a running Cursor
//! process holding a write lock doesn't block us. Tool-use signal is sparse
//! (Cursor doesn't expose a structured tool log the way Claude/Codex do), so
//! events surface as generic Chat / User messages — enough to power the
//! Live view's "what's going on right now" feel without pretending we have
//! per-tool fidelity we don't.

use crate::models::{ActiveProcess, LiveActivity, LiveContext, LiveEvent, SessionLiveState};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const RECENT_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_FEED: usize = 100;
const BUBBLES_PER_COMPOSER: usize = 6;

pub fn collect(limit: usize) -> LiveActivity {
    let Some(db_path) = state_db_path() else {
        return empty();
    };
    if !db_path.exists() {
        return empty();
    }

    let conn = match open_readonly(&db_path) {
        Ok(c) => c,
        Err(_) => return empty(),
    };

    let cutoff_ms = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .saturating_sub(RECENT_WINDOW))
    .as_millis() as i64;

    let composers = match read_composer_headers(&conn) {
        Some(c) => c,
        None => return empty(),
    };

    let mut events: Vec<LiveEvent> = Vec::new();
    let mut sessions: HashMap<String, SessionLiveState> = HashMap::new();

    for composer in composers {
        let last_updated = composer.last_updated_ms.unwrap_or(0);
        if last_updated < cutoff_ms {
            continue;
        }

        let bubbles = read_recent_bubbles(&conn, &composer.id, BUBBLES_PER_COMPOSER);
        let mut session_last_ts = last_updated;
        let mut session_last_tool: Option<String> = None;
        let mut session_last_summary: Option<String> = composer
            .subtitle
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| composer.name.clone());

        for bubble in &bubbles {
            if bubble.ts <= 0 || bubble.ts < cutoff_ms {
                continue;
            }
            let (tool, summary) = bubble_to_event(bubble);
            if summary.is_empty() && tool.is_empty() {
                continue;
            }
            events.push(LiveEvent {
                ts: bubble.ts,
                session_id: composer.id.clone(),
                cwd: composer.cwd.clone(),
                tool: tool.clone(),
                summary: summary.clone(),
                agent: "cursor".to_string(),
            });
            if bubble.ts >= session_last_ts {
                session_last_ts = bubble.ts;
                session_last_tool = Some(tool);
                session_last_summary = Some(summary);
            }
        }

        sessions.insert(
            composer.id.clone(),
            SessionLiveState {
                session_id: composer.id,
                cwd: composer.cwd,
                last_ts: session_last_ts,
                last_tool: session_last_tool,
                last_summary: session_last_summary,
                todos: Vec::new(),
                agent: "cursor".to_string(),
            },
        );
    }

    events.sort_by_key(|e| std::cmp::Reverse(e.ts));
    events.truncate(limit.min(MAX_FEED));

    let mut session_list: Vec<SessionLiveState> = sessions.into_values().collect();
    session_list.sort_by_key(|s| std::cmp::Reverse(s.last_ts));

    LiveActivity {
        feed: events,
        sessions: session_list,
    }
}

/// A Cursor chat idle longer than this is treated as parked rather than
/// running, even though the app itself stays open.
const CONTEXT_ACTIVE_WINDOW: Duration = Duration::from_secs(30 * 60);

/// Context fill for Cursor chats touched recently while Cursor is running.
/// Cursor persists only `contextUsagePercent` per composer — no token counts
/// or model — and all chats share the one collapsed Cursor process.
pub fn contexts(procs: &[ActiveProcess]) -> Vec<LiveContext> {
    let Some(pid) = procs
        .iter()
        .find(|p| {
            let n = p.name.to_lowercase();
            n == "cursor" || n == "cursor.exe" || n.starts_with("cursor ")
        })
        .map(|p| p.pid)
    else {
        return Vec::new();
    };
    let Some(conn) = state_db_path()
        .filter(|p| p.exists())
        .and_then(|p| open_readonly(&p).ok())
    else {
        return Vec::new();
    };
    let cutoff_ms = (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .saturating_sub(CONTEXT_ACTIVE_WINDOW))
    .as_millis() as i64;
    read_composer_headers(&conn)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| !c.archived && c.last_updated_ms.unwrap_or(0) >= cutoff_ms)
        .map(|c| LiveContext {
            agent: "cursor".to_string(),
            session_id: c.id,
            pid: Some(pid),
            name: c.name,
            cwd: c.cwd,
            model: None,
            used_tokens: None,
            window_tokens: None,
            used_percent: c.context_pct.map(|p| p.clamp(0.0, 100.0)),
            status: None,
            last_ts: c.last_updated_ms.unwrap_or(0),
        })
        .collect()
}

fn open_readonly(path: &PathBuf) -> rusqlite::Result<Connection> {
    // `immutable=1` tells SQLite the file won't change, so it skips locking
    // entirely — important because the live Cursor process holds a write
    // lock on this database. The URI mode is required for the option to
    // take effect.
    let uri = format!(
        "file:{}?mode=ro&immutable=1",
        path.to_string_lossy().replace('?', "%3F")
    );
    Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
}

struct ComposerRow {
    id: String,
    name: Option<String>,
    subtitle: Option<String>,
    cwd: Option<String>,
    last_updated_ms: Option<i64>,
    context_pct: Option<f64>,
    archived: bool,
}

fn read_composer_headers(conn: &Connection) -> Option<Vec<ComposerRow>> {
    let raw: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let all = parsed.get("allComposers")?.as_array()?;

    let mut out = Vec::with_capacity(all.len());
    for c in all {
        let Some(id) = c.get("composerId").and_then(|v| v.as_str()) else {
            continue;
        };
        out.push(ComposerRow {
            id: id.to_string(),
            name: c.get("name").and_then(|v| v.as_str()).map(str::to_string),
            subtitle: c
                .get("subtitle")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            cwd: extract_cwd(c.get("workspaceIdentifier")),
            last_updated_ms: c
                .get("lastUpdatedAt")
                .and_then(|v| v.as_i64())
                .or_else(|| c.get("createdAt").and_then(|v| v.as_i64())),
            context_pct: c.get("contextUsagePercent").and_then(|v| v.as_f64()),
            archived: c.get("isArchived").and_then(|v| v.as_bool()).unwrap_or(false),
        });
    }
    Some(out)
}

/// Cursor's workspaceIdentifier carries the workspace path two ways: `uri`
/// for single-folder workspaces and `configPath` for multi-root `.code-
/// workspace` files. We prefer `uri.fsPath` (an actual repo dir) and fall
/// back to `configPath` only when no folder URI is present.
fn extract_cwd(workspace: Option<&Value>) -> Option<String> {
    let workspace = workspace?;
    let from_uri = workspace
        .get("uri")
        .and_then(|v| v.get("fsPath"))
        .and_then(|v| v.as_str());
    if let Some(path) = from_uri {
        return Some(path.to_string());
    }
    workspace
        .get("configPath")
        .and_then(|v| v.get("fsPath"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

struct Bubble {
    /// 1 = user, 2 = assistant.
    kind: u8,
    text: String,
    ts: i64,
}

fn read_recent_bubbles(conn: &Connection, composer_id: &str, limit: usize) -> Vec<Bubble> {
    let prefix = format!("bubbleId:{composer_id}:");
    let like = format!("{prefix}%");
    let mut stmt = match conn.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ?1") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let Ok(rows) = stmt.query_map([&like], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };

    let mut out: Vec<Bubble> = Vec::new();
    for raw in rows.flatten() {
        let Ok(value): Result<Value, _> = serde_json::from_str(&raw) else {
            continue;
        };
        let kind = value
            .get("type")
            .and_then(|v| v.as_u64())
            .map(|n| n as u8)
            .unwrap_or(0);
        let text = value
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default();
        let ts = value
            .get("createdAt")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ms)
            .unwrap_or(0);
        out.push(Bubble { kind, text, ts });
    }

    // Newest first, capped to the recent N — keeps wall-clock cost low even
    // for chat sessions with hundreds of bubbles.
    out.sort_by_key(|b| std::cmp::Reverse(b.ts));
    out.truncate(limit);
    out
}

/// Cursor doesn't ship a structured tool log on bubbles, so we coarse-bucket
/// to "Chat" (assistant) / "User" (prompt) — enough to drive the Live view
/// without pretending we know which tool ran.
fn bubble_to_event(b: &Bubble) -> (String, String) {
    let summary = truncate_chars(b.text.trim(), 80);
    let tool = match b.kind {
        1 => "User".to_string(),
        2 => "Chat".to_string(),
        _ => return (String::new(), summary),
    };
    (tool, summary)
}

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let truncated: String = s.chars().take(n).collect();
    format!("{truncated}…")
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc).timestamp_millis())
}

#[cfg(target_os = "macos")]
fn state_db_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

#[cfg(target_os = "windows")]
fn state_db_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()? // %APPDATA%
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

#[cfg(target_os = "linux")]
fn state_db_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()? // ~/.config
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

fn empty() -> LiveActivity {
    LiveActivity {
        feed: Vec::new(),
        sessions: Vec::new(),
    }
}
