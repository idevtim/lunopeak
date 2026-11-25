//! Publishing this machine's snapshots for other machines to read: shared by
//! `lunopeak-node` and the app's "Share this machine", so both write exactly
//! the same files and redact the same way.
//!
//! Each tick collects live activity (and, less often, session history),
//! drops free text unless prompts are shared, wraps it in an [`Envelope`] and
//! writes it to every target folder (an outbox served by `direct`, a shared
//! folder's `nodes/<machine id>/`). Unchanged data isn't rewritten, so a sync
//! tool isn't asked to ship the same bytes every few seconds.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::feeds::{self, Sources};
use crate::models::Session;
use crate::node_wire::{self, Envelope, LiveData, RemoteSession, SessionsData};
use crate::scanners;

/// A live snapshot is rewritten at least this often even when nothing
/// changed, so the hub can tell an idle machine from one that's gone.
pub const HEARTBEAT: Duration = Duration::from_secs(60);

/// Who is publishing and how much.
#[derive(Debug, Clone, PartialEq)]
pub struct ShareConfig {
    pub machine_id: String,
    pub name: String,
    /// Keep prompt and chat text. Off unless the user asks.
    pub share_prompts: bool,
}

/// Parsed-session caches, kept across ticks. The app passes its own, so
/// sharing doesn't parse history a second time.
#[derive(Default, Clone)]
pub struct Caches {
    pub sessions: scanners::sessions::Cache,
    pub codex: scanners::codex::Cache,
}

/// The live and sessions publishers for one set of target folders.
pub struct Publishers {
    live: Publisher,
    sessions: Publisher,
    next_sessions: Instant,
    sessions_interval: Duration,
}

impl Publishers {
    pub fn new(dirs: &[PathBuf], sessions_interval: Duration) -> Self {
        let files = |name: &str| dirs.iter().map(|d| d.join(name)).collect();
        Publishers {
            live: Publisher::new(files(node_wire::LIVE_FILE)),
            sessions: Publisher::new(files(node_wire::SESSIONS_FILE)),
            next_sessions: Instant::now(),
            sessions_interval,
        }
    }

    /// Collect and write whatever changed. Live data every call, sessions
    /// once `sessions_interval` has passed. Returns write errors, if any.
    pub fn tick(&mut self, cfg: &ShareConfig, src: Sources, caches: &Caches) -> Vec<String> {
        let mut errors = Vec::new();
        let data = collect_live(src, cfg);
        // A process's runtime and memory change on every scan; leave them
        // out of the comparison so an idle machine isn't rewritten each tick.
        // The heartbeat still refreshes them.
        let fp = node_wire::live_fingerprint(&data);
        errors.extend(self.live.publish(cfg, &data, fp, Some(HEARTBEAT)));
        if Instant::now() >= self.next_sessions {
            let data = collect_sessions(src, cfg, caches);
            let fp = serde_json::to_vec(&data).unwrap_or_default();
            errors.extend(self.sessions.publish(cfg, &data, fp, None));
            self.next_sessions = Instant::now() + self.sessions_interval;
        }
        errors
    }
}

pub fn collect_live(src: Sources, cfg: &ShareConfig) -> LiveData {
    let mut data = LiveData {
        activity: feeds::live_activity(src, 40),
        contexts: feeds::live_contexts(src),
        processes: feeds::active_processes(src),
    };
    if !cfg.share_prompts {
        node_wire::redact_live(&mut data);
    }
    node_wire::stamp_live(&mut data, &cfg.name);
    data
}

pub fn collect_sessions(src: Sources, cfg: &ShareConfig, caches: &Caches) -> SessionsData {
    let mut all: Vec<(&str, Session)> = Vec::new();
    if src.claude {
        match scanners::sessions::scan_all(&caches.sessions) {
            Ok(s) => all.extend(s.into_iter().map(|s| ("claude", s))),
            Err(e) => crate::elog!(error, "share", "claude session scan failed: {e:#}"),
        }
    }
    if src.codex {
        match scanners::codex::scan_all(&caches.codex) {
            Ok(s) => all.extend(s.into_iter().map(|s| ("codex", s))),
            Err(e) => crate::elog!(error, "share", "codex session scan failed: {e:#}"),
        }
    }
    // Newest first, ties broken by id, so an unchanged history serializes to
    // the same bytes and isn't rewritten.
    all.sort_by(|(_, a), (_, b)| b.end_ts.cmp(&a.end_ts).then_with(|| a.id.cmp(&b.id)));
    let sessions = all
        .into_iter()
        .map(|(agent, mut s)| {
            if !cfg.share_prompts {
                node_wire::redact_session(&mut s);
            }
            s.host = Some(cfg.name.clone());
            RemoteSession::new(agent, s)
        })
        .collect();
    SessionsData { sessions }
}

/// Writes one snapshot to each of its paths, skipping unchanged data.
struct Publisher {
    paths: Vec<PathBuf>,
    /// Fingerprint of the last data written.
    last_fingerprint: Option<Vec<u8>>,
    last_write: Option<Instant>,
    /// Config of the last write: a new name or prompt setting rewrites.
    last_cfg: Option<ShareConfig>,
}

impl Publisher {
    fn new(paths: Vec<PathBuf>) -> Self {
        Publisher {
            paths,
            last_fingerprint: None,
            last_write: None,
            last_cfg: None,
        }
    }

    /// Write `data` unless its `fingerprint` matches the last write's.
    /// `heartbeat`: also rewrite unchanged data once this much time passes.
    fn publish<T: Serialize>(
        &mut self,
        cfg: &ShareConfig,
        data: &T,
        fingerprint: Vec<u8>,
        heartbeat: Option<Duration>,
    ) -> Vec<String> {
        let changed_cfg = self.last_cfg.as_ref() != Some(cfg);
        if !changed_cfg && !self.should_write(&fingerprint, heartbeat, Instant::now()) {
            return Vec::new();
        }
        let envelope = Envelope {
            schema: node_wire::SCHEMA,
            machine_id: cfg.machine_id.clone(),
            name: cfg.name.clone(),
            node_version: crate::VERSION.to_string(),
            os: std::env::consts::OS.to_string(),
            generated_at: now_ms(),
            includes_prompts: cfg.share_prompts,
            data,
        };
        let mut errors = Vec::new();
        for path in &self.paths {
            if let Err(e) = write_atomic(path, &envelope) {
                crate::elog!(error, "share", "writing {} failed: {e}", path.display());
                errors.push(format!("Couldn't write {}: {e}", path.display()));
            }
        }
        if errors.is_empty() {
            self.last_fingerprint = Some(fingerprint);
            self.last_write = Some(Instant::now());
            self.last_cfg = Some(cfg.clone());
        }
        errors
    }

    fn should_write(&self, fingerprint: &[u8], heartbeat: Option<Duration>, now: Instant) -> bool {
        let Some(at) = self.last_write else {
            return true;
        };
        self.last_fingerprint.as_deref() != Some(fingerprint)
            || heartbeat.is_some_and(|every| now.duration_since(at) >= every)
    }
}

/// Write to a temp file in the same folder, then rename over the target, so
/// the hub (or the sync tool) never reads half a file. The temp name starts
/// with a dot so sync tools that skip hidden files don't ship it.
pub fn write_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("snapshot");
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_only_on_change_or_heartbeat() {
        let mut p = Publisher::new(vec![PathBuf::from("unused")]);
        let t0 = Instant::now();
        assert!(p.should_write(b"a", None, t0), "first write always happens");

        p.last_fingerprint = Some(b"a".to_vec());
        p.last_write = Some(t0);
        assert!(!p.should_write(b"a", None, t0 + Duration::from_secs(3600)));
        assert!(p.should_write(b"b", None, t0));

        let beat = Some(Duration::from_secs(60));
        assert!(!p.should_write(b"a", beat, t0 + Duration::from_secs(59)));
        assert!(p.should_write(b"a", beat, t0 + Duration::from_secs(60)));
    }

    #[test]
    fn a_new_name_rewrites_unchanged_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = Publisher::new(vec![dir.path().join("x.json")]);
        let mut cfg = ShareConfig {
            machine_id: "0".repeat(32),
            name: "A".into(),
            share_prompts: false,
        };
        assert!(p.publish(&cfg, &1, b"same".to_vec(), None).is_empty());
        let first = std::fs::read_to_string(dir.path().join("x.json")).unwrap();
        cfg.name = "B".into();
        p.publish(&cfg, &1, b"same".to_vec(), None);
        let second = std::fs::read_to_string(dir.path().join("x.json")).unwrap();
        assert!(first.contains("\"name\":\"A\"") && second.contains("\"name\":\"B\""));
    }
}
