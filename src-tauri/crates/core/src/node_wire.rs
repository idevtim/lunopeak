//! What a `lunopeak-node` writes for the hub (the desktop app) to read.
//!
//! A node publishes two files per machine, at different cadences, under
//! `<root>/nodes/<host>/`:
//!
//! - `live.json`: what's running right now (activity feed, per-session
//!   state, context fill, agent processes). Rewritten when it changes, plus a
//!   heartbeat so the hub can tell a quiet node from a dead one.
//! - `sessions.json`: every parsed session summary, with the per-day and
//!   per-branch spend the IPC shape leaves out. Rewritten only when it
//!   changes.
//!
//! Both are wrapped in an [`Envelope`] that carries the schema version, so a
//! hub can skip snapshots from a node too new (or too old) to understand.
//! Transcripts are never published; replay stays on the machine that ran the
//! session.

use std::collections::BTreeMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::models::{ActiveProcess, BranchSpend, LiveActivity, LiveContext, Session};

/// Bump on any change a hub of the previous version would misread.
pub const SCHEMA: u32 = 1;

pub const LIVE_FILE: &str = "live.json";
pub const SESSIONS_FILE: &str = "sessions.json";
/// Subfolder of the shared root holding one folder per node.
pub const NODES_DIR: &str = "nodes";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub schema: u32,
    /// Sanitized host name; also the folder name under `nodes/`.
    pub host: String,
    /// LunoPeak release the node was built from.
    pub node_version: String,
    /// `std::env::consts::OS` of the node ("macos", "linux", "windows").
    pub os: String,
    /// Epoch ms when this file was written.
    pub generated_at: i64,
    /// Whether prompt and chat text was left in (`--share-prompts`).
    pub includes_prompts: bool,
    pub data: T,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveData {
    pub activity: LiveActivity,
    pub contexts: Vec<LiveContext>,
    pub processes: Vec<ActiveProcess>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsData {
    pub sessions: Vec<RemoteSession>,
}

/// A `Session` plus the two spend breakdowns that are `#[serde(skip)]` on it
/// (kept off IPC). Without them a remote machine's spend would land on no day
/// and no PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    /// "claude" | "codex". `Session` itself doesn't say, and the hub's
    /// Sessions view lists Claude sessions only, as the local one does.
    #[serde(default = "default_agent")]
    pub agent: String,
    #[serde(flatten)]
    pub session: Session,
    #[serde(default)]
    pub cost_by_day: BTreeMap<NaiveDate, f64>,
    #[serde(default)]
    pub cost_by_branch: BranchSpend,
}

impl RemoteSession {
    pub fn new(agent: &str, session: Session) -> Self {
        let cost_by_day = session.cost_by_day.clone();
        let cost_by_branch = session.cost_by_branch.clone();
        RemoteSession {
            agent: agent.to_string(),
            session,
            cost_by_day,
            cost_by_branch,
        }
    }

    /// Back to a full `Session`, with the spend breakdowns restored.
    pub fn into_session(self) -> Session {
        let mut s = self.session;
        s.cost_by_day = self.cost_by_day;
        s.cost_by_branch = self.cost_by_branch;
        s
    }
}

fn default_agent() -> String {
    "claude".to_string()
}

/// This machine's name as a node would publish it: the first label of the
/// OS host name ("tims-mbp.localdomain" -> "tims-mbp"), sanitized. The hub
/// uses the same function to skip its own folder.
pub fn local_host() -> Option<String> {
    let full = sysinfo::System::host_name()?;
    sanitize_host(full.split('.').next().unwrap_or(&full))
}

/// A host name safe to use as a folder name and a UI label: lowercase ASCII
/// letters, digits, `-` and `_`, with a trailing `.local` / `.lan` dropped.
/// Returns `None` when nothing usable is left.
pub fn sanitize_host(raw: &str) -> Option<String> {
    let lower = raw.trim().to_lowercase();
    let base = lower
        .strip_suffix(".local")
        .or_else(|| lower.strip_suffix(".lan"))
        .unwrap_or(&lower);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    (!trimmed.is_empty()).then(|| trimmed.chars().take(63).collect())
}

/// Stamp `host` on every row of a live snapshot.
pub fn stamp_live(data: &mut LiveData, host: &str) {
    let h = || Some(host.to_string());
    data.activity.feed.iter_mut().for_each(|e| e.host = h());
    data.activity.sessions.iter_mut().for_each(|s| s.host = h());
    data.contexts.iter_mut().for_each(|c| c.host = h());
    data.processes.iter_mut().for_each(|p| p.host = h());
}

/// Drop prompt-like text from a live snapshot, keeping only what is
/// structural: a file path, a shell command, a search pattern, a skill name, a
/// URL. Everything else a summary can hold is dropped: Cursor chat bubbles,
/// the fallback "first string argument" of unknown and MCP tools (a question,
/// a message body, a search query), subagent task descriptions, todo text and
/// session titles. Shell commands go through `logger::scrub_secrets`, so an
/// `sk-…` key or a bearer token typed into one doesn't travel.
pub fn redact_live(data: &mut LiveData) {
    for e in &mut data.activity.feed {
        e.summary = redact_summary(&e.tool, &e.summary).unwrap_or_default();
        e.subagent = None;
    }
    for s in &mut data.activity.sessions {
        s.last_summary = redact_opt(s.last_tool.as_deref(), s.last_summary.take());
        for t in &mut s.todos {
            t.content.clear();
        }
        for a in &mut s.subagents {
            a.description = None;
            a.last_summary = redact_opt(a.last_tool.as_deref(), a.last_summary.take());
        }
    }
    for c in &mut data.contexts {
        c.name = None;
    }
}

/// Drop each session's opening prompt.
pub fn redact_session(s: &mut Session) {
    s.first_prompt = None;
}

/// The summary to publish for a call to `tool`, or `None` when the summary
/// for that tool can be free text.
fn redact_summary(tool: &str, summary: &str) -> Option<String> {
    match tool {
        "Read" | "Edit" | "Write" | "NotebookEdit" | "Glob" | "Grep" | "Skill" | "WebFetch" => {
            Some(summary.to_string())
        }
        "Bash" => Some(crate::logger::scrub_secrets(summary)),
        _ => None,
    }
}

fn redact_opt(tool: Option<&str>, summary: Option<String>) -> Option<String> {
    redact_summary(tool?, &summary?).filter(|s| !s.is_empty())
}

/// The live data with the fields that change on every scan zeroed
/// (a process's runtime and memory), for deciding whether anything a reader
/// would care about changed since the last write.
pub fn live_fingerprint(data: &LiveData) -> Vec<u8> {
    let mut d = data.clone();
    for p in &mut d.processes {
        p.runtime_sec = 0;
        p.memory_kb = 0;
    }
    serde_json::to_vec(&d).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ActiveProcess, LiveEvent, LiveTodo, SessionLiveState, TokenUsage};

    #[test]
    fn sanitizes_host_names() {
        assert_eq!(
            sanitize_host("Tims-MacBook-Pro.local").as_deref(),
            Some("tims-macbook-pro")
        );
        assert_eq!(
            sanitize_host("build box (2)").as_deref(),
            Some("build-box--2")
        );
        assert_eq!(sanitize_host("  ").as_deref(), None);
        assert_eq!(sanitize_host("../etc").as_deref(), Some("etc"));
    }

    fn session() -> Session {
        let mut s = Session {
            host: None,
            id: "s1".into(),
            project_path: None,
            project_name: None,
            branch: None,
            model: None,
            start_ts: 0,
            end_ts: 0,
            message_count: 1,
            first_prompt: Some("secret plans".into()),
            usage: TokenUsage::default(),
            cost_usd: 1.5,
            cost_by_day: BTreeMap::new(),
            subagent_count: 0,
            subagent_cost_usd: 0.0,
            cost_by_branch: BranchSpend::new(),
            tool_uses: BTreeMap::new(),
            tool_errors: 0,
            tool_errors_by_name: BTreeMap::new(),
            tool_sequences: BTreeMap::new(),
            files_edited: BTreeMap::new(),
            bash_commands: BTreeMap::new(),
        };
        s.cost_by_day
            .insert(NaiveDate::from_ymd_opt(2026, 11, 24).unwrap(), 1.5);
        s.cost_by_branch
            .entry("feat".into())
            .or_default()
            .insert(60_000, 1.5);
        s
    }

    #[test]
    fn remote_session_round_trips_skipped_spend() {
        let wire = serde_json::to_string(&RemoteSession::new("claude", session())).unwrap();
        let back: RemoteSession = serde_json::from_str(&wire).unwrap();
        let s = back.into_session();
        assert_eq!(s.cost_by_day.values().sum::<f64>(), 1.5);
        assert_eq!(s.cost_by_branch["feat"][&60_000], 1.5);
        assert_eq!(s.first_prompt.as_deref(), Some("secret plans"));
    }

    #[test]
    fn redaction_drops_prompts_and_chat_but_keeps_tool_summaries() {
        let mut s = session();
        redact_session(&mut s);
        assert_eq!(s.first_prompt, None);

        let ev = |tool: &str, agent: &str| LiveEvent {
            host: None,
            ts: 1,
            session_id: "x".into(),
            cwd: None,
            tool: tool.into(),
            summary: "text".into(),
            agent: agent.into(),
            subagent_id: None,
            subagent: None,
        };
        let mut data = LiveData::default();
        data.activity.feed = vec![
            ev("Bash", "claude"),
            ev("User", "cursor"),
            ev("Chat", "cursor"),
            ev("AskUserQuestion", "claude"),
            ev("mcp__slack__send_message", "claude"),
            ev("WebSearch", "claude"),
            ev("Read", "codex"),
        ];
        data.activity.feed[0].summary = "curl -H Authorization: Bearer abc123 x".into();
        data.activity.sessions = vec![SessionLiveState {
            host: None,
            session_id: "x".into(),
            cwd: None,
            last_ts: 1,
            last_tool: None,
            last_summary: Some("chat title".into()),
            todos: vec![LiveTodo {
                content: "ship the secret thing".into(),
                status: "pending".into(),
            }],
            agent: "cursor".into(),
            subagents: Vec::new(),
        }];
        redact_live(&mut data);
        let summaries: Vec<_> = data
            .activity
            .feed
            .iter()
            .map(|e| e.summary.as_str())
            .collect();
        assert_eq!(
            summaries,
            [
                "curl -H Authorization: Bearer *** x",
                "",
                "",
                "",
                "",
                "",
                "text"
            ]
        );
        let s = &data.activity.sessions[0];
        assert_eq!(s.last_summary, None);
        assert_eq!(s.todos[0].content, "");
        assert_eq!(s.todos[0].status, "pending");

        stamp_live(&mut data, "box");
        assert!(data
            .activity
            .feed
            .iter()
            .all(|e| e.host.as_deref() == Some("box")));
    }

    #[test]
    fn fingerprint_ignores_runtime_and_memory() {
        let proc = |runtime_sec, memory_kb| ActiveProcess {
            host: None,
            pid: 7,
            name: "claude".into(),
            cwd: None,
            runtime_sec,
            memory_kb,
        };
        let a = LiveData {
            processes: vec![proc(10, 100)],
            ..Default::default()
        };
        let b = LiveData {
            processes: vec![proc(15, 180)],
            ..Default::default()
        };
        assert_eq!(live_fingerprint(&a), live_fingerprint(&b));
        let c = LiveData {
            processes: vec![proc(10, 100), proc(1, 1)],
            ..Default::default()
        };
        assert_ne!(live_fingerprint(&a), live_fingerprint(&c));
    }
}
