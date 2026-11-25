//! The hub side of `node_wire`: reads what `lunopeak-node`s on other machines
//! published under `<root>/nodes/<host>/` and hands it to the app.
//!
//! Everything read here is treated as untrusted input from another machine:
//! only the exact file names are read, files over a size cap are refused, the
//! envelope's schema and host are checked before the payload is parsed, and
//! every row's `host` is overwritten with the folder name. The hub's own host
//! is skipped (a node on this machine would duplicate local data), and a
//! session id seen locally or on an earlier node is dropped.
//!
//! Parsed files are cached by size and mtime, because the views that call in
//! poll every few seconds and `sessions.json` is megabytes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::models::{ActiveProcess, CostBreakdown, LiveActivity, LiveContext, Session};
use crate::node_wire::{self, Envelope, LiveData, SessionsData};

/// A node's live data counts as current while the hub has seen it change (or
/// heartbeat) within this long: three of the node's 60s heartbeats, plus room
/// for a sync tool's delay. Older live rows are dropped; sessions are kept.
pub const LIVE_STALE: Duration = Duration::from_secs(180);

/// Refuse anything bigger. A year of heavy use is a few MB of sessions.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// One remote machine, for Settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNode {
    pub host: String,
    pub os: Option<String>,
    pub node_version: Option<String>,
    /// Live data is current (see [`LIVE_STALE`]).
    pub online: bool,
    /// Epoch ms the hub last saw this node's live data change or heartbeat.
    pub last_seen: Option<i64>,
    /// Claude + Codex sessions it published.
    pub sessions: usize,
    /// Published with `--share-prompts`.
    pub includes_prompts: bool,
    /// Why some of its data couldn't be used, in words for the user.
    pub problem: Option<String>,
}

/// Live rows from every current remote node, merged and newest first.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLive {
    pub activity: LiveActivity,
    pub contexts: Vec<LiveContext>,
    pub processes: Vec<ActiveProcess>,
}

/// Spend on one machine, for the Costs view's "By machine" card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineCost {
    /// `None` for this machine.
    pub host: Option<String>,
    pub total_usd: f64,
    pub sessions: usize,
    /// Spend per local calendar day for the last 30 days, oldest → newest.
    pub by_day: Vec<f64>,
}

/// Costs across every machine: the combined breakdown (same shape as
/// `get_costs`) plus each machine's share. `machines` holds this machine
/// first, then the others by spend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineCosts {
    pub all: CostBreakdown,
    pub machines: Vec<MachineCost>,
}

/// Combine this machine's sessions with remote ones (each with `host` set).
pub fn machine_costs(local: &[Session], remote: &[Session]) -> MachineCosts {
    let mut by_host: std::collections::BTreeMap<&str, Vec<Session>> = Default::default();
    for s in remote {
        by_host
            .entry(s.host.as_deref().unwrap_or("?"))
            .or_default()
            .push(s.clone());
    }
    let summary = |host: Option<String>, sessions: &[Session]| MachineCost {
        host,
        total_usd: sessions.iter().map(|s| s.cost_usd).sum(),
        sessions: sessions.len(),
        by_day: crate::scanners::sessions::cost_day_buckets(sessions, 30),
    };
    let mut others: Vec<MachineCost> = by_host
        .iter()
        .map(|(h, ss)| summary(Some(h.to_string()), ss))
        .collect();
    others.sort_by(|a, b| b.total_usd.total_cmp(&a.total_usd));
    let mut machines = vec![summary(None, local)];
    machines.extend(others);

    let all: Vec<Session> = local.iter().chain(remote).cloned().collect();
    MachineCosts {
        all: crate::scanners::sessions::costs(&all),
        machines,
    }
}

/// The envelope minus its payload, parsed first so a node newer than this
/// hub is reported as such instead of as a corrupt file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    schema: u32,
    host: String,
    #[serde(default)]
    node_version: Option<String>,
    #[serde(default)]
    os: Option<String>,
    #[serde(default)]
    generated_at: i64,
    #[serde(default)]
    includes_prompts: bool,
}

struct Entry<T> {
    mtime: SystemTime,
    len: u64,
    generated_at: i64,
    /// Hub clock: when this file's `generatedAt` last changed. On first
    /// sight, the file's mtime (a node that stopped yesterday isn't online).
    seen_change: SystemTime,
    node_version: Option<String>,
    os: Option<String>,
    includes_prompts: bool,
    result: Result<Arc<T>, String>,
}

#[derive(Default)]
struct State {
    live: HashMap<PathBuf, Entry<LiveData>>,
    sessions: HashMap<PathBuf, Entry<SessionsData>>,
}

/// Clone is cheap (an `Arc`), so the cache can move into blocking tasks.
#[derive(Default, Clone)]
pub struct Hub {
    state: Arc<Mutex<State>>,
}

/// One node folder after a refresh.
struct NodeView {
    host: String,
    live: Option<EntryView<LiveData>>,
    sessions: Option<EntryView<SessionsData>>,
}

struct EntryView<T> {
    seen_change: SystemTime,
    node_version: Option<String>,
    os: Option<String>,
    includes_prompts: bool,
    result: Result<Arc<T>, String>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every node folder under `root` except `skip_host` (this machine).
    pub fn nodes(&self, root: &Path, skip_host: Option<&str>) -> Vec<RemoteNode> {
        let now = SystemTime::now();
        let mut out: Vec<RemoteNode> = self
            .refresh(root, skip_host)
            .into_iter()
            .map(|n| {
                let live_ok = n.live.as_ref().filter(|l| l.result.is_ok());
                let online = live_ok.is_some_and(|l| is_fresh(l.seen_change, now));
                let live_err = n.live.as_ref().and_then(|e| e.result.as_ref().err());
                let sessions_err = n.sessions.as_ref().and_then(|e| e.result.as_ref().err());
                let problem = live_err.or(sessions_err).cloned().or_else(|| {
                    (n.live.is_none() && n.sessions.is_none()).then(|| "No data yet".to_string())
                });
                let meta = n
                    .live
                    .as_ref()
                    .map(|e| (&e.node_version, &e.os, e.includes_prompts))
                    .or_else(|| {
                        n.sessions
                            .as_ref()
                            .map(|e| (&e.node_version, &e.os, e.includes_prompts))
                    });
                RemoteNode {
                    host: n.host,
                    os: meta.and_then(|m| m.1.clone()),
                    node_version: meta.and_then(|m| m.0.clone()),
                    online,
                    last_seen: n.live.as_ref().map(|l| epoch_ms(l.seen_change)),
                    sessions: n
                        .sessions
                        .as_ref()
                        .and_then(|e| e.result.as_ref().ok())
                        .map_or(0, |d| d.sessions.len()),
                    includes_prompts: meta.is_some_and(|m| m.2),
                    problem,
                }
            })
            .collect();
        out.sort_by(|a, b| a.host.cmp(&b.host));
        out
    }

    /// Live rows from every node whose live data is current.
    pub fn live(&self, root: &Path, skip_host: Option<&str>) -> RemoteLive {
        let now = SystemTime::now();
        let mut out = RemoteLive::default();
        for n in self.refresh(root, skip_host) {
            let Some(live) = n.live else { continue };
            let Ok(data) = live.result else { continue };
            if !is_fresh(live.seen_change, now) {
                continue;
            }
            let mut d = (*data).clone();
            node_wire::stamp_live(&mut d, &n.host);
            out.activity.feed.append(&mut d.activity.feed);
            out.activity.sessions.append(&mut d.activity.sessions);
            out.contexts.append(&mut d.contexts);
            out.processes.append(&mut d.processes);
        }
        out.activity.feed.sort_by_key(|e| std::cmp::Reverse(e.ts));
        out.activity
            .sessions
            .sort_by_key(|s| std::cmp::Reverse(s.last_ts));
        out.contexts.sort_by_key(|c| std::cmp::Reverse(c.last_ts));
        out
    }

    /// Remote sessions from `agent` ("claude" / "codex"), newest first, with
    /// their per-day and per-branch spend restored. Ids in `local_ids` (and
    /// repeats across nodes) are dropped: the first copy wins.
    pub fn sessions(
        &self,
        root: &Path,
        skip_host: Option<&str>,
        agent: &str,
        local_ids: &HashSet<String>,
    ) -> Vec<Session> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut out = Vec::new();
        for n in self.refresh(root, skip_host) {
            let Some(Ok(data)) = n.sessions.map(|e| e.result) else {
                continue;
            };
            for r in data.sessions.iter().filter(|r| r.agent == agent) {
                if local_ids.contains(&r.session.id) || !seen.insert(r.session.id.clone()) {
                    continue;
                }
                let mut s = r.clone().into_session();
                s.host = Some(n.host.clone());
                out.push(s);
            }
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.end_ts));
        out
    }

    /// Re-read whatever changed under `root/nodes/` and return every node.
    fn refresh(&self, root: &Path, skip_host: Option<&str>) -> Vec<NodeView> {
        let dir = root.join(node_wire::NODES_DIR);
        let Ok(read) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut hosts: Vec<String> = read
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            // Only folders a node could have made; skips `.stfolder`, junk.
            .filter(|name| node_wire::sanitize_host(name).as_deref() == Some(name.as_str()))
            .filter(|name| Some(name.as_str()) != skip_host)
            .collect();
        hosts.sort();

        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        let mut keep_live = HashSet::new();
        let mut keep_sessions = HashSet::new();
        let views = hosts
            .into_iter()
            .map(|host| {
                let folder = dir.join(&host);
                let live_path = folder.join(node_wire::LIVE_FILE);
                let sessions_path = folder.join(node_wire::SESSIONS_FILE);
                let live = load(&mut state.live, &live_path, &host);
                let sessions = load(&mut state.sessions, &sessions_path, &host);
                keep_live.insert(live_path);
                keep_sessions.insert(sessions_path);
                NodeView {
                    host,
                    live,
                    sessions,
                }
            })
            .collect();
        state.live.retain(|p, _| keep_live.contains(p));
        state.sessions.retain(|p, _| keep_sessions.contains(p));
        views
    }
}

fn is_fresh(seen_change: SystemTime, now: SystemTime) -> bool {
    // A seen time in the future (clock skew, a copied file) still counts.
    now.duration_since(seen_change)
        .map_or(true, |age| age < LIVE_STALE)
}

fn epoch_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Bring the cache entry for `path` up to date and return a view of it.
/// `None` when the file doesn't exist.
fn load<T: DeserializeOwned>(
    cache: &mut HashMap<PathBuf, Entry<T>>,
    path: &Path,
    host: &str,
) -> Option<EntryView<T>> {
    let Ok(meta) = std::fs::metadata(path) else {
        cache.remove(path);
        return None;
    };
    let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
    let len = meta.len();
    let stale = cache
        .get(path)
        .is_none_or(|e| e.mtime != mtime || e.len != len);
    if stale {
        let prev = cache.remove(path);
        let entry = parse::<T>(path, host, mtime, len, prev.as_ref());
        cache.insert(path.to_path_buf(), entry);
    }
    let e = cache.get(path)?;
    Some(EntryView {
        seen_change: e.seen_change,
        node_version: e.node_version.clone(),
        os: e.os.clone(),
        includes_prompts: e.includes_prompts,
        result: e.result.clone(),
    })
}

fn parse<T: DeserializeOwned>(
    path: &Path,
    host: &str,
    mtime: SystemTime,
    len: u64,
    prev: Option<&Entry<T>>,
) -> Entry<T> {
    let mut entry = Entry {
        mtime,
        len,
        generated_at: 0,
        seen_change: prev.map_or(mtime, |p| p.seen_change),
        node_version: None,
        os: None,
        includes_prompts: false,
        result: Err(String::new()),
    };
    if len > MAX_FILE_BYTES {
        entry.result = Err(format!("{} is too large to read", file_name(path)));
        return entry;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            entry.result = Err(format!("Couldn't read {}: {e}", file_name(path)));
            return entry;
        }
    };
    let header = match serde_json::from_slice::<Header>(&bytes) {
        Ok(h) => h,
        Err(_) => {
            entry.result = Err(format!("{} isn't a LunoPeak node file", file_name(path)));
            return entry;
        }
    };
    entry.node_version = header.node_version;
    entry.os = header.os;
    entry.includes_prompts = header.includes_prompts;
    entry.generated_at = header.generated_at;
    if prev.is_some_and(|p| p.generated_at != header.generated_at) {
        entry.seen_change = SystemTime::now();
    }
    if header.schema != node_wire::SCHEMA {
        let newer = header.schema > node_wire::SCHEMA;
        entry.result = Err(if newer {
            "Its node is newer than this app. Update LunoPeak here.".to_string()
        } else {
            "Its node is older than this app. Update lunopeak-node there.".to_string()
        });
        return entry;
    }
    if node_wire::sanitize_host(&header.host).as_deref() != Some(host) {
        entry.result = Err(format!(
            "{} says it's from {:?}, not {host:?}",
            file_name(path),
            header.host
        ));
        return entry;
    }
    entry.result = serde_json::from_slice::<Envelope<T>>(&bytes)
        .map(|e| Arc::new(e.data))
        .map_err(|e| format!("{} couldn't be read: {e}", file_name(path)));
    entry
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LiveEvent, TokenUsage};
    use crate::node_wire::RemoteSession;
    use std::collections::BTreeMap;
    use std::fs::File;

    fn session(id: &str, end_ts: i64) -> Session {
        Session {
            host: None,
            id: id.into(),
            project_path: None,
            project_name: None,
            branch: None,
            model: None,
            start_ts: 0,
            end_ts,
            message_count: 1,
            first_prompt: None,
            usage: TokenUsage::default(),
            cost_usd: 1.0,
            cost_by_day: BTreeMap::new(),
            subagent_count: 0,
            subagent_cost_usd: 0.0,
            cost_by_branch: Default::default(),
            tool_uses: BTreeMap::new(),
            tool_errors: 0,
            tool_errors_by_name: BTreeMap::new(),
            tool_sequences: BTreeMap::new(),
            files_edited: BTreeMap::new(),
            bash_commands: BTreeMap::new(),
        }
    }

    fn envelope<T: Serialize>(host: &str, schema: u32, data: T) -> String {
        serde_json::to_string(&Envelope {
            schema,
            host: host.into(),
            node_version: "2.5.0".into(),
            os: "linux".into(),
            generated_at: 1,
            includes_prompts: false,
            data,
        })
        .unwrap()
    }

    fn write(root: &Path, host: &str, file: &str, body: &str) -> PathBuf {
        let dir = root.join("nodes").join(host);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(file);
        std::fs::write(&p, body).unwrap();
        p
    }

    fn live_with_event(tool: &str) -> LiveData {
        let mut d = LiveData::default();
        d.activity.feed.push(LiveEvent {
            host: Some("forged".into()),
            ts: 5,
            session_id: "s".into(),
            cwd: Some("/srv/app".into()),
            tool: tool.into(),
            summary: "x".into(),
            agent: "claude".into(),
            subagent_id: None,
            subagent: None,
        });
        d
    }

    #[test]
    fn reads_nodes_skips_self_and_stamps_host_from_folder() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "box",
            "live.json",
            &envelope("box", 1, live_with_event("Bash")),
        );
        write(
            root.path(),
            "me",
            "live.json",
            &envelope("me", 1, live_with_event("Read")),
        );
        let hub = Hub::new();

        let live = hub.live(root.path(), Some("me"));
        assert_eq!(live.activity.feed.len(), 1);
        assert_eq!(live.activity.feed[0].tool, "Bash");
        assert_eq!(live.activity.feed[0].host.as_deref(), Some("box"));

        let nodes = hub.nodes(root.path(), Some("me"));
        assert_eq!(nodes.len(), 1);
        assert!(nodes[0].online);
        assert_eq!(nodes[0].problem, None);
        assert_eq!(nodes[0].os.as_deref(), Some("linux"));
    }

    #[test]
    fn rejects_newer_schema_and_mismatched_host() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "newer",
            "live.json",
            &envelope("newer", 99, serde_json::json!({"x": 1})),
        );
        write(
            root.path(),
            "liar",
            "live.json",
            &envelope("someone-else", 1, live_with_event("Bash")),
        );
        let hub = Hub::new();
        assert!(hub.live(root.path(), None).activity.feed.is_empty());
        let nodes = hub.nodes(root.path(), None);
        let problem = |h: &str| {
            nodes
                .iter()
                .find(|n| n.host == h)
                .unwrap()
                .problem
                .clone()
                .unwrap()
        };
        assert!(problem("newer").contains("newer than this app"));
        assert!(problem("liar").contains("someone-else"));
    }

    #[test]
    fn old_live_data_is_offline_but_sessions_still_count() {
        let root = tempfile::tempdir().unwrap();
        let p = write(
            root.path(),
            "box",
            "live.json",
            &envelope("box", 1, live_with_event("Bash")),
        );
        let old = SystemTime::now() - Duration::from_secs(3600);
        File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let sessions = SessionsData {
            sessions: vec![RemoteSession::new("claude", session("a", 1))],
        };
        write(
            root.path(),
            "box",
            "sessions.json",
            &envelope("box", 1, sessions),
        );

        let hub = Hub::new();
        assert!(hub.live(root.path(), None).processes.is_empty());
        assert!(hub.live(root.path(), None).activity.feed.is_empty());
        let nodes = hub.nodes(root.path(), None);
        assert!(!nodes[0].online);
        assert_eq!(nodes[0].sessions, 1);
        assert_eq!(
            hub.sessions(root.path(), None, "claude", &HashSet::new())
                .len(),
            1
        );
    }

    #[test]
    fn sessions_filter_by_agent_and_drop_duplicate_ids() {
        let root = tempfile::tempdir().unwrap();
        let a = SessionsData {
            sessions: vec![
                RemoteSession::new("claude", session("shared", 3)),
                RemoteSession::new("claude", session("only-a", 2)),
                RemoteSession::new("codex", session("codex-1", 1)),
            ],
        };
        let b = SessionsData {
            sessions: vec![
                RemoteSession::new("claude", session("only-a", 2)),
                RemoteSession::new("claude", session("only-b", 4)),
            ],
        };
        write(root.path(), "a", "sessions.json", &envelope("a", 1, a));
        write(root.path(), "b", "sessions.json", &envelope("b", 1, b));
        let local: HashSet<String> = ["shared".to_string()].into();

        let hub = Hub::new();
        let got = hub.sessions(root.path(), None, "claude", &local);
        let ids: Vec<_> = got
            .iter()
            .map(|s| (s.id.as_str(), s.host.as_deref().unwrap()))
            .collect();
        assert_eq!(ids, [("only-b", "b"), ("only-a", "a")]);
        assert_eq!(hub.sessions(root.path(), None, "codex", &local).len(), 1);
    }

    #[test]
    fn ignores_folders_a_node_could_not_have_made() {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            ".stfolder",
            "live.json",
            &envelope(".stfolder", 1, live_with_event("Bash")),
        );
        write(
            root.path(),
            "Box",
            "live.json",
            &envelope("Box", 1, live_with_event("Bash")),
        );
        assert!(Hub::new().nodes(root.path(), None).is_empty());
    }

    /// Read a real shared folder and print what the hub sees:
    /// `LUNOPEAK_HUB_ROOT=/path cargo test -p lunopeak-core hub_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn hub_live() {
        let root = PathBuf::from(std::env::var("LUNOPEAK_HUB_ROOT").expect("LUNOPEAK_HUB_ROOT"));
        let me = node_wire::local_host();
        let hub = Hub::new();
        let t = std::time::Instant::now();
        let nodes = hub.nodes(&root, me.as_deref());
        let live = hub.live(&root, me.as_deref());
        let sessions = hub.sessions(&root, me.as_deref(), "claude", &HashSet::new());
        println!("first read {:?} (skipping {me:?})", t.elapsed());
        let t = std::time::Instant::now();
        hub.sessions(&root, me.as_deref(), "claude", &HashSet::new());
        println!("cached read {:?}", t.elapsed());
        for n in &nodes {
            println!("{n:?}");
        }
        println!(
            "live: {} procs, {} events, {} contexts; {} claude sessions, ${:.2}",
            live.processes.len(),
            live.activity.feed.len(),
            live.contexts.len(),
            sessions.len(),
            sessions.iter().map(|s| s.cost_usd).sum::<f64>()
        );
    }

    #[test]
    fn machine_costs_split_by_host_and_combine() {
        let today = chrono::Local::now().date_naive();
        let with = |id: &str, host: Option<&str>, usd: f64| {
            let mut s = session(id, 1);
            s.host = host.map(str::to_string);
            s.cost_usd = usd;
            s.cost_by_day.insert(today, usd);
            s
        };
        let local = vec![with("l1", None, 2.0)];
        let remote = vec![
            with("a1", Some("a"), 1.0),
            with("b1", Some("b"), 5.0),
            with("b2", Some("b"), 1.0),
        ];
        let mc = machine_costs(&local, &remote);
        let rows: Vec<_> = mc
            .machines
            .iter()
            .map(|m| {
                (
                    m.host.as_deref(),
                    m.total_usd,
                    m.sessions,
                    *m.by_day.last().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                (None, 2.0, 1, 2.0),
                (Some("b"), 6.0, 2, 6.0),
                (Some("a"), 1.0, 1, 1.0)
            ]
        );
        assert_eq!(mc.all.total_usd, 9.0);
        assert_eq!(*mc.all.by_day.last().unwrap(), 9.0);
    }
}
