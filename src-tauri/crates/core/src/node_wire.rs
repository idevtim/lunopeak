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
/// `<app_dir>/machine-id`, followed by a tag of the hardware it was made on.
///
/// The tag catches an app folder carried to another computer (Migration
/// Assistant, a restored backup, a cloned VM): the id would otherwise travel
/// with it, and the two machines would each hide the other as itself. When
/// the tag no longer matches, a new id is made. Where the hardware can't be
/// read, the id is kept as is.
///
/// The window, the menu-bar process and a node can all race to create it, so
/// the first `create_new` wins and the rest read what it wrote.
pub fn machine_id(app_dir: &Path) -> std::io::Result<String> {
    machine_id_on(app_dir, hardware_tag().as_deref())
}

fn machine_id_on(app_dir: &Path, hw: Option<&str>) -> std::io::Result<String> {
    let path = app_dir.join(MACHINE_ID_FILE);
    let contents = |id: &str| match hw {
        Some(tag) => format!("{id}\nhw {tag}\n"),
        None => format!("{id}\n"),
    };
    match read_machine_id(&path) {
        Ok((id, stored)) => match (stored.as_deref(), hw) {
            (Some(was), Some(now)) if was != now => {
                // Moved to other hardware: this is a different machine now.
                let fresh = uuid::Uuid::new_v4().simple().to_string();
                replace_file(&path, contents(&fresh).as_bytes())?;
                Ok(read_machine_id(&path)?.0)
            }
            (None, Some(_)) => {
                // Made before ids were tied to hardware: tie it now.
                replace_file(&path, contents(&id).as_bytes())?;
                Ok(id)
            }
            _ => Ok(id),
        },
        Err(_) => {
            std::fs::create_dir_all(app_dir)?;
            let id = uuid::Uuid::new_v4().simple().to_string();
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut f) => {
                    f.write_all(contents(&id).as_bytes())?;
                    Ok(id)
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Another process got there first; give it a moment to write.
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    Ok(read_machine_id(&path)?.0)
                }
                Err(e) => Err(e),
            }
        }
    }
}

/// The id and hardware tag in a `machine-id` file.
fn read_machine_id(path: &Path) -> std::io::Result<(String, Option<String>)> {
    let text = std::fs::read_to_string(path)?;
    let mut lines = text.lines();
    let id = lines.next().unwrap_or("").trim().to_string();
    if !is_machine_id(&id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{} doesn't hold a machine id", path.display()),
        ));
    }
    let hw = lines
        .filter_map(|l| l.strip_prefix("hw "))
        .map(|t| t.trim().to_string())
        .next();
    Ok((id, hw))
}

/// Write `bytes` to `path` through a temp file and a rename, so a reader in
/// another process never sees half of it.
pub fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// A short hash of this computer's hardware id (macOS `IOPlatformUUID`,
/// Linux `/etc/machine-id`, Windows `MachineGuid`). Read once per process.
pub fn hardware_tag() -> Option<String> {
    static TAG: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    TAG.get_or_init(|| {
        use sha2::{Digest, Sha256};
        let raw = hardware_id()?;
        let digest = Sha256::digest(raw.trim().as_bytes());
        Some(digest.iter().take(8).map(|b| format!("{b:02x}")).collect())
    })
    .clone()
}

#[cfg(target_os = "macos")]
fn hardware_id() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("\"IOPlatformUUID\""))?;
    let value = line.rsplit('"').nth(1)?.to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "linux")]
fn hardware_id() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(windows)]
fn hardware_id() -> Option<String> {
    use crate::process_ext::NoWindow;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
        .no_window()
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.contains("MachineGuid"))?;
    line.split_whitespace().last().map(str::to_string)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn hardware_id() -> Option<String> {
    None
}

/// [`machine_id`] in the app dir this build uses, read once per process.
pub fn local_machine_id() -> Option<String> {
    static ID: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    ID.get_or_init(|| machine_id(&crate::statusline::app_dir()?).ok())
        .clone()
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

/// Mask secrets in everything a snapshot carries that can hold a command or
/// URL. Runs whether or not prompts are shared: sharing prompts is a choice
/// about conversation text, never about credentials.
pub fn scrub_live_secrets(data: &mut LiveData) {
    let scrub = |tool: &str, text: &mut String| {
        if matches!(tool, "Bash" | "WebFetch") {
            *text = scrub_command(text);
        }
    };
    for e in &mut data.activity.feed {
        scrub(&e.tool, &mut e.summary);
    }
    for st in &mut data.activity.sessions {
        if let (Some(tool), Some(sum)) = (st.last_tool.clone(), st.last_summary.as_mut()) {
            scrub(&tool, sum);
        }
        for a in &mut st.subagents {
            if let (Some(tool), Some(sum)) = (a.last_tool.clone(), a.last_summary.as_mut()) {
                scrub(&tool, sum);
            }
        }
    }
}

/// [`scrub_live_secrets`] for a session's command counts, whose keys are
/// each command's first word (which can be `API_KEY=…`).
pub fn scrub_session_secrets(s: &mut Session) {
    let mut cleaned = std::collections::BTreeMap::new();
    for (cmd, n) in std::mem::take(&mut s.bash_commands) {
        *cleaned.entry(scrub_command(&cmd)).or_insert(0) += n;
    }
    s.bash_commands = cleaned;
}

/// Names that mark the next word, or an `=value`, as a secret.
const SECRET_WORDS: &[&str] = &[
    "key", "token", "secret", "password", "passwd", "pass", "pwd", "auth", "credential", "credentials",
    "apikey", "api-key", "api_key", "access-key", "private-key",
];

/// Prefixes of well-known credential formats.
const SECRET_PREFIXES: &[&str] = &[
    "sk-", "sk_", "pk_live_", "rk_live_", "ghp_", "gho_", "ghs_", "ghu_", "ghr_", "github_pat_", "glpat-",
    "xoxb-", "xoxp-", "xoxa-", "xoxs-", "xapp-", "AKIA", "ASIA", "AIza", "hf_", "npm_", "pypi-", "dop_v1_",
    "ya29.", "eyJ",
];

/// Mask credentials in a shell command or URL, keeping its shape: known key
/// formats, values of secret-named variables and flags (`API_KEY=…`,
/// `--token …`), the password in `-u user:pass`, the word after `Bearer`, passwords in URLs
/// and secret-named query parameters, and long random-looking words.
pub fn scrub_command(input: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut mask_next = false;
    let mut after_user_flag = false;
    for word in input.split_whitespace() {
        if mask_next {
            mask_next = false;
            out.push("***".into());
            continue;
        }
        // `curl -u user:pass`: keep the user, mask the password. (`-u` alone
        // means other things elsewhere, like `git push -u origin`.)
        if std::mem::take(&mut after_user_flag) {
            if let Some((user, _)) = word.split_once(':') {
                out.push(format!("{user}:***"));
                continue;
            }
        }
        let bare = word.trim_matches(|c| c == '"' || c == '\'');
        let lower = bare.to_ascii_lowercase();
        if lower == "-u" || lower == "--user" {
            out.push(word.to_string());
            after_user_flag = true;
            continue;
        }
        // `--token value`, `Bearer value`.
        let flag = lower.trim_start_matches('-');
        if lower == "bearer" || (lower.starts_with('-') && !lower.contains('=') && is_secret_name(flag)) {
            out.push(word.to_string());
            mask_next = true;
            continue;
        }
        // `NAME=value` and `--name=value`.
        if let Some((name, value)) = bare.split_once('=') {
            if !value.is_empty() && is_secret_name(name.trim_start_matches('-')) {
                out.push(format!("{name}=***"));
                continue;
            }
        }
        out.push(scrub_word(word));
    }
    out.join(" ")
}

fn is_secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| {
        n == *w
            || n.ends_with(&format!("_{w}"))
            || n.ends_with(&format!("-{w}"))
            || n.starts_with(&format!("{w}_"))
            || n.starts_with(&format!("{w}-"))
    }) || n.contains("token")
        || n.contains("secret")
        || n.contains("password")
        || n.contains("api_key")
        || n.contains("apikey")
}

/// One word: a URL's password and secret query values, a known key format,
/// or a long random-looking string.
fn scrub_word(word: &str) -> String {
    if let Some(rest) = word.split_once("://").map(|(_, r)| r) {
        let mut w = word.to_string();
        // https://user:pass@host → https://user:***@host
        if let Some(at) = rest.find('@') {
            let userinfo = &rest[..at];
            if let Some((user, _)) = userinfo.split_once(':') {
                w = w.replacen(userinfo, &format!("{user}:***"), 1);
            }
        }
        if let Some((base, query)) = w.clone().split_once('?') {
            let q: Vec<String> = query
                .split('&')
                .map(|kv| match kv.split_once('=') {
                    Some((k, v)) if !v.is_empty() && is_secret_name(k) => format!("{k}=***"),
                    _ => kv.to_string(),
                })
                .collect();
            w = format!("{base}?{}", q.join("&"));
        }
        return w;
    }
    let bare = word.trim_matches(|c: char| c == '"' || c == '\'' || c == ',' || c == ';');
    if SECRET_PREFIXES.iter().any(|p| bare.starts_with(p) && bare.len() > p.len() + 8) || looks_random(bare) {
        return word.replace(bare, "***");
    }
    word.to_string()
}

/// 32+ characters of letters, digits and `-_+=`, mixing letters and digits,
/// not plain hex (commit hashes) and not a path or a dotted name.
fn looks_random(s: &str) -> bool {
    s.len() >= 32
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '='))
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_alphabetic())
        && !s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The summary to publish for a call to `tool`, or `None` when the summary
/// for that tool can be free text.
fn redact_summary(tool: &str, summary: &str) -> Option<String> {
    match tool {
        "Read" | "Edit" | "Write" | "NotebookEdit" | "Glob" | "Grep" | "Skill" => Some(summary.to_string()),
        "WebFetch" => Some(scrub_command(summary)),
        "Bash" => Some(scrub_command(summary)),
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
    fn machine_id_changes_when_moved_to_other_hardware() {
        let dir = tempfile::tempdir().unwrap();
        let first = machine_id_on(dir.path(), Some("aaaa")).unwrap();
        assert_eq!(machine_id_on(dir.path(), Some("aaaa")).unwrap(), first);
        // Unreadable hardware keeps the id.
        assert_eq!(machine_id_on(dir.path(), None).unwrap(), first);
        let moved = machine_id_on(dir.path(), Some("bbbb")).unwrap();
        assert_ne!(moved, first);
        assert!(is_machine_id(&moved));
        assert_eq!(machine_id_on(dir.path(), Some("bbbb")).unwrap(), moved);
    }

    #[test]
    fn machine_id_made_before_hardware_tags_is_kept_and_tied() {
        let dir = tempfile::tempdir().unwrap();
        let id = "0123456789abcdef0123456789abcdef";
        std::fs::write(dir.path().join(MACHINE_ID_FILE), id).unwrap();
        assert_eq!(machine_id_on(dir.path(), Some("aaaa")).unwrap(), id);
        let (_, hw) = read_machine_id(&dir.path().join(MACHINE_ID_FILE)).unwrap();
        assert_eq!(hw.as_deref(), Some("aaaa"));
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

    #[test]
    fn scrubs_credentials_from_commands_and_urls() {
        let cases = [
            ("OPENAI_API_KEY=sk-abc123def456ghi789 python app.py", "OPENAI_API_KEY=*** python app.py"),
            ("gh auth login --with-token ghp_AbCdEf1234567890xyz", "gh auth login --with-token ***"),
            ("curl -H 'Authorization: Bearer abc.def' https://x.io", "curl -H 'Authorization: Bearer *** https://x.io"),
            ("curl -u tim:hunter2 https://x.io", "curl -u tim:*** https://x.io"),
            ("git clone https://tim:s3cret@github.com/a/b", "git clone https://tim:***@github.com/a/b"),
            ("open https://x.io/cb?code=1&access_token=zzz", "open https://x.io/cb?code=1&access_token=***"),
            ("deploy --api-key=abcdef", "deploy --api-key=***"),
            ("export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "export AWS_SECRET_ACCESS_KEY=***"),
            ("echo AKIAIOSFODNN7EXAMPLE1", "echo ***"),
            ("x qX7b9Lm2Pz8Rt4Vw6Yc1Nd3Fh5Jk0Ab9Cd", "x ***"),
        ];
        for (input, want) in cases {
            assert_eq!(scrub_command(input), want, "{input}");
        }
        // Ordinary commands survive, commit hashes and paths included.
        for keep in [
            "git checkout 3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a",
            "cargo test -p lunopeak-core --release",
            "npm run build",
            "cat /Users/tim/projects/really-long-folder-name-2026/src/main.rs",
            "git push origin feat/remote-pairing",
            "git push -u origin main",
        ] {
            assert_eq!(scrub_command(keep), keep);
        }
    }

    #[test]
    fn session_command_counts_are_scrubbed() {
        let mut s = session();
        s.bash_commands = BTreeMap::from([("TOKEN=abc123".to_string(), 2), ("git".to_string(), 5)]);
        scrub_session_secrets(&mut s);
        assert_eq!(s.bash_commands.get("TOKEN=***"), Some(&2));
        assert_eq!(s.bash_commands.get("git"), Some(&5));
    }
}
