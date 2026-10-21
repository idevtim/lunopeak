//! Per-session live activity scan of Codex CLI rollouts.
//!
//! Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]` files modified within
//! the recent window and emits the same `LiveEvent` / `SessionLiveState` shape
//! that `scanners::live` produces for Claude Code, tagged with
//! `agent: "codex"`. Tool names are normalized to the Claude-equivalents the
//! frontend already styles (e.g. codex `exec_command` → "Bash").

use crate::models::{ActiveProcess, LiveActivity, LiveContext, LiveEvent, SessionLiveState};
use chrono::{DateTime, Utc};
use super::codex::{open_rollout, rollout_files};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const RECENT_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_FEED: usize = 100;

pub fn collect(limit: usize) -> LiveActivity {
    let Some(root) = sessions_root() else {
        return empty();
    };
    if !root.is_dir() {
        return empty();
    }

    let cutoff = SystemTime::now()
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut events: Vec<LiveEvent> = Vec::new();
    let mut sessions: HashMap<String, SessionLiveState> = HashMap::new();

    for (path, mtime) in rollout_files(&root) {
        if mtime < cutoff {
            continue;
        }
        parse_recent(&path, &mut events, &mut sessions);
    }

    events.sort_by_key(|e| std::cmp::Reverse(e.ts));
    let cap = limit.min(MAX_FEED);
    events.truncate(cap);

    let mut session_list: Vec<SessionLiveState> = sessions.into_values().collect();
    session_list.sort_by_key(|s| std::cmp::Reverse(s.last_ts));

    LiveActivity {
        feed: events,
        sessions: session_list,
    }
}

fn parse_recent(
    path: &Path,
    events: &mut Vec<LiveEvent>,
    sessions: &mut HashMap<String, SessionLiveState>,
) {
    let Some(reader) = open_rollout(path) else {
        return;
    };

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut last_ts: i64 = 0;
    let mut last_tool: Option<String> = None;
    let mut last_summary: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };

        let ts = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ts)
            .unwrap_or(0);
        if ts > last_ts {
            last_ts = ts;
        }

        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match value.get("payload") {
            Some(p) => p,
            None => continue,
        };
        let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

        // Pull session metadata from `session_meta`.
        if kind == "session_meta" {
            if session_id.is_none() {
                session_id = payload
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            if cwd.is_none() {
                cwd = payload
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            continue;
        }

        // Tool calls live in `response_item` records — these are the model's
        // calls, emitted just before the tool runs. We translate codex tool
        // names to the same labels Claude uses so the UI styling matches.
        if kind == "response_item" {
            let Some((tool, summary)) = summarize_response_item(payload_type, payload) else {
                continue;
            };
            push_event(
                events,
                ts,
                session_id.as_deref(),
                cwd.as_deref(),
                &tool,
                &summary,
            );
            last_tool = Some(tool);
            last_summary = Some(summary);
        }
    }

    let Some(sid) = session_id else {
        return;
    };
    sessions.insert(
        sid.clone(),
        SessionLiveState {
            session_id: sid,
            cwd,
            last_ts,
            last_tool,
            last_summary,
            todos: Vec::new(),
            agent: "codex".to_string(),
        },
    );
}

// ── Per-process context window ─────────────────────────────────────────

/// Rollouts older than this can't belong to a session that's still going.
const CONTEXT_WINDOW_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const TAIL_BYTES: u64 = 512 * 1024;

/// Codex doesn't publish a pid → rollout mapping, so each running codex
/// process claims the newest rollout recorded in its cwd. Rollouts touched in
/// the live window stay in even when no process claims them — the desktop
/// app's `app-server` reports one cwd for many threads. Each rollout's latest
/// `token_count` event carries both the prompt size and the model's window.
pub fn contexts(procs: &[ActiveProcess]) -> Vec<LiveContext> {
    let codex_procs: Vec<&ActiveProcess> = procs
        .iter()
        .filter(|p| {
            let n = p.name.to_lowercase();
            let n = n.strip_suffix(".exe").unwrap_or(&n);
            n == "codex" || n.starts_with("codex ")
        })
        .collect();
    if codex_procs.is_empty() {
        return Vec::new();
    }
    let Some(root) = sessions_root() else {
        return Vec::new();
    };
    let now = SystemTime::now();
    let oldest = now.checked_sub(CONTEXT_WINDOW_AGE).unwrap_or(SystemTime::UNIX_EPOCH);
    let live_cutoff = now.checked_sub(RECENT_WINDOW).unwrap_or(SystemTime::UNIX_EPOCH);

    let mut rollouts: Vec<(SystemTime, CodexRollout)> = rollout_files(&root)
        .into_iter()
        .filter(|(_, mtime)| *mtime >= oldest)
        .filter_map(|(path, mtime)| read_rollout(&path).map(|r| (mtime, r)))
        .collect();
    // Newest first so each process claims its freshest same-cwd rollout.
    rollouts.sort_by_key(|(m, _)| std::cmp::Reverse(*m));

    let mut claimed: Vec<Option<u32>> = vec![None; rollouts.len()];
    for p in &codex_procs {
        let Some(pcwd) = p.cwd.as_deref().map(norm_cwd) else {
            continue;
        };
        let hit = rollouts.iter().enumerate().position(|(i, (_, r))| {
            claimed[i].is_none() && r.cwd.as_deref().map(norm_cwd).as_deref() == Some(pcwd.as_str())
        });
        if let Some(i) = hit {
            claimed[i] = Some(p.pid);
        }
    }

    let names = thread_names();
    rollouts
        .into_iter()
        .zip(claimed)
        .filter(|((mtime, _), pid)| pid.is_some() || *mtime >= live_cutoff)
        .map(|((_, r), pid)| LiveContext {
            agent: "codex".to_string(),
            name: names.get(&r.id).cloned(),
            session_id: r.id,
            pid,
            cwd: r.cwd,
            model: r.model,
            used_tokens: r.used,
            window_tokens: r.window,
            used_percent: r.used.zip(r.window).map(|(u, w)| super::live::percent(u, w)),
            status: None,
            last_ts: r.last_ts,
        })
        .collect()
}

struct CodexRollout {
    id: String,
    cwd: Option<String>,
    model: Option<String>,
    used: Option<u64>,
    window: Option<u64>,
    last_ts: i64,
}

fn read_rollout(path: &Path) -> Option<CodexRollout> {
    // `session_meta` is always the first record.
    let mut reader = open_rollout(path)?;
    let mut first = String::new();
    reader.read_line(&mut first).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&first).ok()?;
    if meta.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return None;
    }
    let payload = meta.get("payload")?;
    let id = payload.get("id").and_then(|v| v.as_str())?.to_string();
    let cwd = payload.get("cwd").and_then(|v| v.as_str()).map(str::to_string);

    let mut out = CodexRollout {
        id,
        cwd,
        model: None,
        used: None,
        window: None,
        last_ts: 0,
    };
    // A compressed rollout can't be seeked into, so it's read whole — what's
    // left in the reader after the meta line is the rest of the file.
    let lines: Vec<String> = if path.extension().is_some_and(|e| e == "zst") {
        reader.lines().map_while(Result::ok).collect()
    } else {
        super::live::read_tail_lines(path, TAIL_BYTES).0
    };
    for line in lines.iter().rev() {
        if out.used.is_some() && out.model.is_some() {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if out.last_ts == 0 {
            out.last_ts = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .and_then(parse_iso_ts)
                .unwrap_or(0);
        }
        let Some(p) = v.get("payload") else {
            continue;
        };
        let kind = v.get("type").and_then(|t| t.as_str());
        let payload_type = p.get("type").and_then(|t| t.as_str());
        if kind == Some("turn_context") && out.model.is_none() {
            out.model = p.get("model").and_then(|m| m.as_str()).map(str::to_string);
        } else if payload_type == Some("token_count") && out.used.is_none() {
            // `last_token_usage` is the most recent request alone — its input
            // (cached included) plus output is what now fills the window.
            // `total_token_usage` is lifetime spend, not occupancy.
            let Some(info) = p.get("info").filter(|i| !i.is_null()) else {
                continue;
            };
            out.used = info
                .get("last_token_usage")
                .and_then(|u| u.get("total_tokens"))
                .and_then(|t| t.as_u64());
            out.window = info.get("model_context_window").and_then(|w| w.as_u64());
        }
    }
    Some(out)
}

/// `~/.codex/session_index.jsonl` appends `{id, thread_name}` whenever a
/// thread is (re)named; the last entry per id wins.
fn thread_names() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(path) = dirs::home_dir().map(|h| h.join(".codex").join("session_index.jsonl")) else {
        return out;
    };
    let Ok(file) = File::open(path) else {
        return out;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let (Some(id), Some(name)) = (
            v.get("id").and_then(|x| x.as_str()),
            v.get("thread_name").and_then(|x| x.as_str()),
        ) {
            out.insert(id.to_string(), name.to_string());
        }
    }
    out
}

fn norm_cwd(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).replace('\\', "/").to_lowercase()
}

/// Translate a codex `response_item` tool call into a (tool_name, summary)
/// pair using Claude-style labels so existing icon/styling lookups apply.
fn summarize_response_item(
    payload_type: &str,
    payload: &serde_json::Value,
) -> Option<(String, String)> {
    match payload_type {
        "function_call" => {
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args_str = payload.get("arguments").and_then(|v| v.as_str())?;
            let args: serde_json::Value = serde_json::from_str(args_str).ok()?;
            match name {
                "exec_command" | "shell" => {
                    let cmd = args
                        .get("cmd")
                        .or_else(|| args.get("command"))
                        .and_then(|v| {
                            // `command` is sometimes an array of argv tokens.
                            if let Some(arr) = v.as_array() {
                                Some(
                                    arr.iter()
                                        .filter_map(|t| t.as_str())
                                        .collect::<Vec<_>>()
                                        .join(" "),
                                )
                            } else {
                                v.as_str().map(str::to_string)
                            }
                        })?;
                    Some(("Bash".to_string(), truncate_chars(&cmd, 80)))
                }
                _ => {
                    // Unknown function — surface the name with a best-effort
                    // first string value as the summary.
                    let summary = args
                        .as_object()
                        .and_then(|o| o.values().find_map(|v| v.as_str()))
                        .map(|s| truncate_chars(s, 80))
                        .unwrap_or_default();
                    Some((name.to_string(), summary))
                }
            }
        }
        "custom_tool_call" => {
            let name = payload.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let input = payload.get("input").and_then(|v| v.as_str()).unwrap_or("");
            match name {
                "apply_patch" => {
                    // Patch files start with `*** Begin Patch` and contain
                    // lines like `*** Update File: <path>`. Take the first
                    // file mentioned as the summary so the UI shows what's
                    // being edited.
                    let path = input
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("*** Update File: ")
                                .or_else(|| l.strip_prefix("*** Add File: "))
                                .or_else(|| l.strip_prefix("*** Delete File: "))
                                .map(str::trim)
                                .map(str::to_string)
                        })
                        .unwrap_or_default();
                    Some(("Edit".to_string(), path))
                }
                _ => Some((name.to_string(), truncate_chars(input, 80))),
            }
        }
        _ => None,
    }
}

fn push_event(
    events: &mut Vec<LiveEvent>,
    ts: i64,
    session_id: Option<&str>,
    cwd: Option<&str>,
    tool: &str,
    summary: &str,
) {
    if tool.is_empty() {
        return;
    }
    let sid = session_id.unwrap_or("").to_string();
    events.push(LiveEvent {
        ts,
        session_id: sid,
        cwd: cwd.map(str::to_string),
        tool: tool.to_string(),
        summary: summary.to_string(),
        agent: "codex".to_string(),
    });
}

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let truncated: String = s.chars().take(n).collect();
    format!("{truncated}…")
}

fn parse_iso_ts(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
}

fn sessions_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

fn empty() -> LiveActivity {
    LiveActivity {
        feed: Vec::new(),
        sessions: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rollout_reads_latest_token_count_and_model() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        let lines = [
            r#"{"timestamp":"2026-09-04T17:28:00Z","type":"session_meta","payload":{"id":"abc","cwd":"/work/repo"}}"#,
            r#"{"timestamp":"2026-09-04T17:28:01Z","type":"turn_context","payload":{"model":"gpt-5.5-codex"}}"#,
            r#"{"timestamp":"2026-09-04T17:28:02Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":1000},"model_context_window":258400}}}"#,
            r#"{"timestamp":"2026-09-04T17:29:45Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":36167},"model_context_window":258400}}}"#,
            r#"{"timestamp":"2026-09-04T17:29:46Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#,
        ];
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        f.flush().unwrap();

        let r = read_rollout(f.path()).unwrap();
        assert_eq!(r.id, "abc");
        assert_eq!(r.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(r.model.as_deref(), Some("gpt-5.5-codex"));
        assert_eq!(r.used, Some(36_167));
        assert_eq!(r.window, Some(258_400));
        assert!(r.last_ts > 0);
    }

    #[test]
    fn rollout_without_session_meta_is_ignored() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(f, r#"{{"type":"event_msg","payload":{{}}}}"#).unwrap();
        f.flush().unwrap();
        assert!(read_rollout(f.path()).is_none());
    }

    #[test]
    fn contexts_empty_without_codex_process() {
        assert!(contexts(&[]).is_empty());
    }
}
