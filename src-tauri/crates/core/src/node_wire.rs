//! What a `lunopeak-node` writes for the hub (the desktop app) to read.
//!
//! A node publishes two files per machine, at different cadences, under
//! `<root>/nodes/<machine id>/`:
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
//!
//! Machines are told apart by a random id kept in the app dir
//! ([`machine_id`]), not by host name: two laptops both called "MacBook-Pro"
//! would otherwise write into one folder and each hide the other as itself.
//! The app and a node on the same machine share the id, so a hub never shows
//! its own machine twice. The name shown in the UI travels in the envelope.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::models::{ActiveProcess, BranchSpend, LiveActivity, LiveContext, Session, SlotSpend};

/// Bump on any change a hub of the previous version would misread.
pub const SCHEMA: u32 = 1;

pub const LIVE_FILE: &str = "live.json";
pub const SESSIONS_FILE: &str = "sessions.json";
/// Subfolder of the shared root holding one folder per node.
pub const NODES_DIR: &str = "nodes";
/// File in the app dir holding this machine's id.
pub const MACHINE_ID_FILE: &str = "machine-id";
/// Longest display name kept, in characters.
const MAX_NAME_CHARS: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub schema: u32,
    /// The node's [`machine_id`]; also its folder name under `nodes/`.
    pub machine_id: String,
    /// Name to show for the machine ([`clean_name`]d). Not unique: the hub
    /// tells apart two machines with the same name.
    pub name: String,
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
    /// Days in the node's time zone. Only used when `cost_by_slot` is empty.
    #[serde(default)]
    pub cost_by_day: BTreeMap<NaiveDate, f64>,
    #[serde(default)]
    pub cost_by_slot: SlotSpend,
    #[serde(default)]
    pub cost_by_branch: BranchSpend,
}

impl RemoteSession {
    pub fn new(agent: &str, session: Session) -> Self {
        let cost_by_day = session.cost_by_day.clone();
        let cost_by_slot = session.cost_by_slot.clone();
        let cost_by_branch = session.cost_by_branch.clone();
        RemoteSession {
            agent: agent.to_string(),
            session,
            cost_by_day,
            cost_by_slot,
            cost_by_branch,
        }
    }

    /// Back to a full `Session`, with the spend breakdowns restored and its
    /// days rebuilt in this machine's time zone.
    pub fn into_session(self) -> Session {
        let mut s = self.session;
        s.cost_by_day = if self.cost_by_slot.is_empty() {
            self.cost_by_day
        } else {
            crate::scanners::sessions::days_from_slots(&self.cost_by_slot)
        };
        s.cost_by_slot = self.cost_by_slot;
        s.cost_by_branch = self.cost_by_branch;
        s
    }
}

fn default_agent() -> String {
    "claude".to_string()
}

/// This machine's id, created on first use: 32 lowercase hex characters in
/// `<app_dir>/machine-id`. The window, the menu-bar process and a node can
/// all race to create it, so the first `create_new` wins and the rest read.
pub fn machine_id(app_dir: &Path) -> std::io::Result<String> {
    let path = app_dir.join(MACHINE_ID_FILE);
    let read = |path: &Path| -> std::io::Result<String> {
        let id = std::fs::read_to_string(path)?.trim().to_string();
        if is_machine_id(&id) {
            Ok(id)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{} doesn't hold a machine id", path.display()),
            ))
        }
    };
    if let Ok(id) = read(&path) {
        return Ok(id);
    }
    std::fs::create_dir_all(app_dir)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(id.as_bytes())?;
            Ok(id)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another process got there first; give it a moment to write.
            std::thread::sleep(std::time::Duration::from_millis(50));
            read(&path)
        }
        Err(e) => Err(e),
    }
}

/// [`machine_id`] in the app dir this build uses.
pub fn local_machine_id() -> Option<String> {
    machine_id(&crate::statusline::app_dir()?).ok()
}

/// Whether `s` is shaped like a [`machine_id`], so a folder or envelope
/// field can be trusted as a path component.
pub fn is_machine_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The name a machine goes by unless one is chosen: the first label of the
/// OS host name ("Tims-MBP.localdomain" -> "Tims-MBP").
pub fn default_name() -> Option<String> {
    let full = sysinfo::System::host_name()?;
    clean_name(full.split('.').next().unwrap_or(&full))
}

/// A display name safe to show: control characters dropped, runs of
/// whitespace collapsed, at most 40 characters. `None` when nothing is left.
pub fn clean_name(raw: &str) -> Option<String> {
    let words: Vec<&str> = raw
        .split(|c: char| c.is_whitespace() || c.is_control())
        .filter(|w| !w.is_empty())
        .collect();
    let joined: String = words.join(" ").chars().take(MAX_NAME_CHARS).collect();
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
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
    fn cleans_display_names() {
        assert_eq!(clean_name("  Build\tbox\n(2) ").as_deref(), Some("Build box (2)"));
        assert_eq!(clean_name(" \u{7}  "), None);
        assert_eq!(clean_name(&"x".repeat(100)).map(|n| n.len()), Some(40));
    }

    #[test]
    fn machine_id_is_created_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let id = machine_id(dir.path()).unwrap();
        assert!(is_machine_id(&id));
        assert_eq!(machine_id(dir.path()).unwrap(), id);
        assert!(!is_machine_id("../etc"));
        assert!(!is_machine_id(&id.to_uppercase()));
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
            cost_by_slot: Default::default(),
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
    fn slots_rebuild_days_in_this_time_zone() {
        // 23:45 UTC: the node's own day may differ from ours.
        let ts = chrono::DateTime::parse_from_rfc3339("2026-11-24T23:45:00Z")
            .unwrap()
            .timestamp_millis();
        let mut s = session();
        s.cost_by_day = BTreeMap::from([(NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), 1.5)]);
        s.cost_by_slot = SlotSpend::from([(ts, 1.5)]);
        let back = RemoteSession::new("claude", s).into_session();
        let ours = chrono::DateTime::from_timestamp_millis(ts)
            .unwrap()
            .with_timezone(&chrono::Local)
            .date_naive();
        assert_eq!(back.cost_by_day, BTreeMap::from([(ours, 1.5)]));
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
