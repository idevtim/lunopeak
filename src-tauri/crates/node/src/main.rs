//! `lunopeak-node`: runs LunoPeak's provider scanners on this machine and
//! publishes what they find for a LunoPeak hub on another machine to show.
//!
//! It writes `<out>/nodes/<host>/live.json` and `sessions.json` (see
//! `lunopeak_core::node_wire`). Point `--out` at a folder that Syncthing,
//! iCloud Drive, Dropbox or a network share keeps in sync with the hub. No
//! GUI, no network calls of its own, no credentials: it only reads the agents'
//! local files, the same way the desktop app does.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use lunopeak_core::feeds::{self, Sources};
use lunopeak_core::models::{AgentSources, Session};
use lunopeak_core::node_wire::{self, Envelope, LiveData, RemoteSession, SessionsData};
use lunopeak_core::scanners;
use serde::Serialize;

const USAGE: &str = "\
lunopeak-node: publish this machine's coding-agent sessions to a LunoPeak hub

USAGE:
    lunopeak-node --out <DIR> [OPTIONS]

OPTIONS:
    --out <DIR>               Shared folder the hub reads (Syncthing, iCloud, a
                              network share...). Files go to DIR/nodes/<host>/.
    --host <NAME>             Name shown in the hub [default: this machine's
                              host name]
    --interval <SECS>         How often to read live activity [default: 5]
    --sessions-interval <SECS>
                              How often to re-scan session history [default: 60]
    --share-prompts           Include prompt and chat text. Off by default:
                              session opening prompts and Cursor chat messages
                              are dropped before anything is written.
    --once                    Write one snapshot of each kind and exit
    -h, --help                Print this help
    -V, --version             Print the version

Which agents are read follows the LunoPeak app's settings on this machine
when it's installed; otherwise Claude Code, Codex and Cursor are all read.";

/// A live snapshot is rewritten at least this often even when nothing
/// changed, so the hub can tell an idle node from one that's gone.
const HEARTBEAT: Duration = Duration::from_secs(60);

struct Args {
    out: PathBuf,
    host: String,
    interval: Duration,
    sessions_interval: Duration,
    share_prompts: bool,
    once: bool,
}

fn main() {
    let args = match parse_args(std::env::args().skip(1).collect()) {
        Ok(Some(a)) => a,
        Ok(None) => return,
        Err(msg) => {
            eprintln!("lunopeak-node: {msg}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    if let Some(dir) = lunopeak_core::statusline::app_dir() {
        lunopeak_core::logger::init_at(&dir.join("node-logs"), "LunoPeak node");
    }
    let dir = args.out.join(node_wire::NODES_DIR).join(&args.host);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("lunopeak-node: can't create {}: {e}", dir.display());
        std::process::exit(1);
    }
    eprintln!(
        "lunopeak-node {}: publishing as \"{}\" to {}{}",
        lunopeak_core::VERSION,
        args.host,
        dir.display(),
        if args.share_prompts {
            " (with prompt text)"
        } else {
            ""
        },
    );
    run(&args, &dir);
}

fn run(args: &Args, dir: &Path) {
    let sessions_cache = scanners::sessions::Cache::new();
    let codex_cache = scanners::codex::Cache::new();
    let mut live = Publisher::new(dir.join(node_wire::LIVE_FILE));
    let mut sessions = Publisher::new(dir.join(node_wire::SESSIONS_FILE));
    let mut next_sessions = Instant::now();

    loop {
        let src = sources();
        let data = collect_live(src, args);
        // A process's runtime and memory change on every scan; leave them
        // out of the comparison so an idle machine isn't rewritten each tick.
        // The heartbeat still refreshes them.
        live.publish(
            args,
            &data,
            node_wire::live_fingerprint(&data),
            Some(HEARTBEAT),
        );
        if Instant::now() >= next_sessions {
            let data = collect_sessions(src, args, &sessions_cache, &codex_cache);
            let fingerprint = serde_json::to_vec(&data).unwrap_or_default();
            sessions.publish(args, &data, fingerprint, None);
            next_sessions = Instant::now() + args.sessions_interval;
        }
        if args.once {
            return;
        }
        std::thread::sleep(args.interval);
    }
}

/// Re-read each tick so toggling an agent in the app takes effect without
/// restarting the node. Settings the app hasn't migrated yet
/// (`initialized: false`, e.g. an old install's `codex: false` default) count
/// as all-on, the same as the app's own loader decides.
fn sources() -> Sources {
    lunopeak_core::statusline::app_dir()
        .and_then(|d| std::fs::read(d.join("settings.json")).ok())
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|v| serde_json::from_value::<AgentSources>(v.get("agents")?.clone()).ok())
        .filter(|a| a.initialized)
        .map(|a| Sources::from(&a))
        .unwrap_or(Sources::ALL)
}

fn collect_live(src: Sources, args: &Args) -> LiveData {
    let mut data = LiveData {
        activity: feeds::live_activity(src, 40),
        contexts: feeds::live_contexts(src),
        processes: feeds::active_processes(src),
    };
    if !args.share_prompts {
        node_wire::redact_live(&mut data);
    }
    node_wire::stamp_live(&mut data, &args.host);
    data
}

fn collect_sessions(
    src: Sources,
    args: &Args,
    cache: &scanners::sessions::Cache,
    codex_cache: &scanners::codex::Cache,
) -> SessionsData {
    let mut all: Vec<(&str, Session)> = Vec::new();
    if src.claude {
        match scanners::sessions::scan_all(cache) {
            Ok(s) => all.extend(s.into_iter().map(|s| ("claude", s))),
            Err(e) => lunopeak_core::elog!(error, "node", "claude session scan failed: {e:#}"),
        }
    }
    if src.codex {
        match scanners::codex::scan_all(codex_cache) {
            Ok(s) => all.extend(s.into_iter().map(|s| ("codex", s))),
            Err(e) => lunopeak_core::elog!(error, "node", "codex session scan failed: {e:#}"),
        }
    }
    // Newest first, ties broken by id, so an unchanged history serializes to
    // the same bytes and isn't rewritten.
    all.sort_by(|(_, a), (_, b)| b.end_ts.cmp(&a.end_ts).then_with(|| a.id.cmp(&b.id)));
    let sessions = all
        .into_iter()
        .map(|(agent, mut s)| {
            if !args.share_prompts {
                node_wire::redact_session(&mut s);
            }
            s.host = Some(args.host.clone());
            RemoteSession::new(agent, s)
        })
        .collect();
    SessionsData { sessions }
}

/// Writes one snapshot file, skipping writes whose data hasn't changed so a
/// sync tool isn't asked to ship the same bytes every few seconds.
struct Publisher {
    path: PathBuf,
    /// Fingerprint of the last data written.
    last_fingerprint: Option<Vec<u8>>,
    last_write: Option<Instant>,
}

impl Publisher {
    fn new(path: PathBuf) -> Self {
        Publisher {
            path,
            last_fingerprint: None,
            last_write: None,
        }
    }

    /// Write `data` unless its `fingerprint` matches the last write's.
    /// `heartbeat`: also rewrite unchanged data once this much time passes.
    fn publish<T: Serialize>(
        &mut self,
        args: &Args,
        data: &T,
        fingerprint: Vec<u8>,
        heartbeat: Option<Duration>,
    ) {
        if !self.should_write(&fingerprint, heartbeat, Instant::now()) {
            return;
        }
        let envelope = Envelope {
            schema: node_wire::SCHEMA,
            host: args.host.clone(),
            node_version: lunopeak_core::VERSION.to_string(),
            os: std::env::consts::OS.to_string(),
            generated_at: now_ms(),
            includes_prompts: args.share_prompts,
            data,
        };
        match write_atomic(&self.path, &envelope) {
            Ok(()) => {
                self.last_fingerprint = Some(fingerprint);
                self.last_write = Some(Instant::now());
            }
            Err(e) => {
                eprintln!("lunopeak-node: writing {} failed: {e}", self.path.display());
                lunopeak_core::elog!(error, "node", "writing {} failed: {e}", self.path.display());
            }
        }
    }
}

impl Publisher {
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
fn write_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
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

/// `Ok(None)` means help or version was printed and there's nothing to run.
fn parse_args(raw: Vec<String>) -> Result<Option<Args>, String> {
    let mut out = None;
    let mut host = None;
    let mut interval = 5;
    let mut sessions_interval = 60;
    let mut share_prompts = false;
    let mut once = false;

    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| {
            inline
                .clone()
                .or_else(|| it.next())
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match flag.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("lunopeak-node {}", lunopeak_core::VERSION);
                return Ok(None);
            }
            "--out" => out = Some(PathBuf::from(value("--out")?)),
            "--host" => host = Some(value("--host")?),
            "--interval" => interval = secs(&value("--interval")?, "--interval")?,
            "--sessions-interval" => {
                sessions_interval = secs(&value("--sessions-interval")?, "--sessions-interval")?
            }
            "--share-prompts" => share_prompts = true,
            "--once" => once = true,
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    let out = out.ok_or("--out <DIR> is required")?;
    let host = match host {
        Some(h) => node_wire::sanitize_host(&h)
            .ok_or_else(|| format!("host name {h:?} has no usable characters"))?,
        None => {
            node_wire::local_host().ok_or("couldn't read this machine's host name; pass --host")?
        }
    };
    Ok(Some(Args {
        out,
        host,
        interval: Duration::from_secs(interval),
        sessions_interval: Duration::from_secs(sessions_interval),
        share_prompts,
        once,
    }))
}

fn secs(v: &str, name: &str) -> Result<u64, String> {
    match v.parse::<u64>() {
        Ok(n) if n > 0 => Ok(n),
        _ => Err(format!("{name} must be a whole number of seconds above 0")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_only_on_change_or_heartbeat() {
        let mut p = Publisher::new(PathBuf::from("unused"));
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
}
