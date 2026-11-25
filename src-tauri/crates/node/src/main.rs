//! `lunopeak-node`: runs LunoPeak's provider scanners on this machine and
//! publishes what they find for a LunoPeak hub on another machine to show.
//!
//! Two ways to reach the hub, usable together:
//!
//! - `--out DIR`: write `DIR/nodes/<machine id>/live.json` and
//!   `sessions.json` (see `lunopeak_core::node_wire`) into a folder that
//!   Syncthing, iCloud Drive, Dropbox or a network share keeps in sync.
//! - `--listen`: serve the same files directly over TLS to hubs paired with
//!   `lunopeak-node pair` (see `lunopeak_core::direct`).
//!
//! No GUI, no outbound network calls, no credentials: it only reads the
//! agents' local files, the same way the desktop app does.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use lunopeak_core::direct;
use lunopeak_core::feeds::{self, Sources};
use lunopeak_core::models::{AgentSources, Session};
use lunopeak_core::node_wire::{self, Envelope, LiveData, RemoteSession, SessionsData};
use lunopeak_core::scanners;
use serde::Serialize;

const USAGE: &str = "\
lunopeak-node: publish this machine's coding-agent sessions to a LunoPeak hub

USAGE:
    lunopeak-node [--listen] [--out <DIR>] [OPTIONS]
    lunopeak-node pair             Show a code to pair a LunoPeak app with
    lunopeak-node hubs             List the apps this machine shares with
    lunopeak-node unpair <NAME>    Stop sharing with one of them

WHERE TO PUBLISH (one or both):
    --listen                  Share directly with paired LunoPeak apps over an
                              encrypted connection, on port 47390
    --bind <ADDR[:PORT]>      Address to listen on [default: 0.0.0.0:47390].
                              On a server with a public address, use a private
                              one (e.g. your Tailscale address).
    --out <DIR>               Also write to a shared folder (Syncthing, iCloud,
                              a network share...), under DIR/nodes/<machine id>/

OPTIONS:
    --name <NAME>             Name shown in the app [default: this machine's
                              host name]. --host is accepted too.
    --interval <SECS>         How often to read live activity [default: 5]
    --sessions-interval <SECS>
                              How often to re-scan session history [default: 60]
    --share-prompts           Include prompt and chat text. Off by default:
                              session opening prompts and Cursor chat messages
                              are dropped before anything is written or served.
    --state-dir <DIR>         Where this machine's id, certificate and pairings
                              live [default: LunoPeak's settings folder]
    --once                    Write one snapshot of each kind and exit
    -h, --help                Print this help
    -V, --version             Print the version

Which agents are read follows the LunoPeak app's settings on this machine
when it's installed; otherwise Claude Code, Codex and Cursor are all read.";

/// A live snapshot is rewritten at least this often even when nothing
/// changed, so the hub can tell an idle node from one that's gone.
const HEARTBEAT: Duration = Duration::from_secs(60);

/// Folder under the state dir holding what `--listen` serves.
const OUTBOX: &str = "outbox";

enum Command {
    Run(Args),
    Pair { state_dir: Option<PathBuf> },
    Hubs { state_dir: Option<PathBuf> },
    Unpair { state_dir: Option<PathBuf>, who: String },
}

struct Args {
    out: Option<PathBuf>,
    listen: Option<SocketAddr>,
    name: String,
    interval: Duration,
    sessions_interval: Duration,
    share_prompts: bool,
    state_dir: Option<PathBuf>,
    /// Filled in by `main` from the state dir, so parsing stays side-effect free.
    machine_id: String,
    once: bool,
}

fn main() {
    let cmd = match parse_args(std::env::args().skip(1).collect()) {
        Ok(Some(c)) => c,
        Ok(None) => return,
        Err(msg) => {
            eprintln!("lunopeak-node: {msg}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    match cmd {
        Command::Run(args) => start(args),
        Command::Pair { state_dir } => pair(&state_dir_or_exit(state_dir)),
        Command::Hubs { state_dir } => hubs(&state_dir_or_exit(state_dir)),
        Command::Unpair { state_dir, who } => unpair(&state_dir_or_exit(state_dir), &who),
    }
}

fn state_dir_or_exit(given: Option<PathBuf>) -> PathBuf {
    given
        .or_else(lunopeak_core::statusline::app_dir)
        .unwrap_or_else(|| fail("couldn't find a settings folder; pass --state-dir"))
}

fn fail(msg: &str) -> ! {
    eprintln!("lunopeak-node: {msg}");
    std::process::exit(1);
}

fn start(mut args: Args) {
    let state_dir = state_dir_or_exit(args.state_dir.clone());
    lunopeak_core::logger::init_at(&state_dir.join("node-logs"), "LunoPeak node");
    args.machine_id = node_wire::machine_id(&state_dir)
        .unwrap_or_else(|e| fail(&format!("couldn't read or create this machine's id: {e}")));

    let mut dirs = Vec::new();
    if let Some(out) = &args.out {
        dirs.push(out.join(node_wire::NODES_DIR).join(&args.machine_id));
    }
    let outbox = state_dir.join(OUTBOX);
    if args.listen.is_some() {
        dirs.push(outbox.clone());
    }
    for d in &dirs {
        if let Err(e) = std::fs::create_dir_all(d) {
            fail(&format!("can't create {}: {e}", d.display()));
        }
    }
    let prompts = if args.share_prompts { " (with prompt text)" } else { "" };
    eprintln!(
        "lunopeak-node {}: sharing as \"{}\"{prompts}",
        lunopeak_core::VERSION,
        args.name
    );
    if let Some(out) = &args.out {
        eprintln!("  writing to {}", out.join(node_wire::NODES_DIR).join(&args.machine_id).display());
    }
    // Publish once before serving, so a hub's first fetch finds data.
    let mut publishers = Publishers::new(&dirs);
    let caches = Caches::default();
    publishers.tick(&args, &caches);
    if args.once {
        return;
    }
    let _server = args.listen.map(|bind| {
        let server = direct::serve(direct::ServeConfig {
            bind,
            state_dir: state_dir.clone(),
            outbox,
            name: args.name.clone(),
        })
        .unwrap_or_else(|e| fail(&format!("can't listen on {bind}: {e}")));
        eprintln!("  listening on {} (certificate {})", server.addr, &server.fingerprint[..16]);
        let paired = direct::paired_hubs(&state_dir).len();
        if paired == 0 {
            eprintln!("  no apps paired yet: run `lunopeak-node pair` to pair one");
        } else {
            eprintln!("  shared with {paired} app(s)");
        }
        server
    });
    loop {
        std::thread::sleep(args.interval);
        publishers.tick(&args, &caches);
    }
}

#[derive(Default)]
struct Caches {
    sessions: scanners::sessions::Cache,
    codex: scanners::codex::Cache,
}

struct Publishers {
    live: Publisher,
    sessions: Publisher,
    next_sessions: Instant,
}

impl Publishers {
    fn new(dirs: &[PathBuf]) -> Self {
        let files = |name: &str| dirs.iter().map(|d| d.join(name)).collect();
        Publishers {
            live: Publisher::new(files(node_wire::LIVE_FILE)),
            sessions: Publisher::new(files(node_wire::SESSIONS_FILE)),
            next_sessions: Instant::now(),
        }
    }

    fn tick(&mut self, args: &Args, caches: &Caches) {
        let src = sources();
        let data = collect_live(src, args);
        // A process's runtime and memory change on every scan; leave them
        // out of the comparison so an idle machine isn't rewritten each tick.
        // The heartbeat still refreshes them.
        self.live
            .publish(args, &data, node_wire::live_fingerprint(&data), Some(HEARTBEAT));
        if Instant::now() >= self.next_sessions {
            let data = collect_sessions(src, args, &caches.sessions, &caches.codex);
            let fingerprint = serde_json::to_vec(&data).unwrap_or_default();
            self.sessions.publish(args, &data, fingerprint, None);
            self.next_sessions = Instant::now() + args.sessions_interval;
        }
    }
}

/// Open a pairing window and wait until an app pairs or it closes.
fn pair(state_dir: &Path) {
    let before = direct::paired_hubs(state_dir);
    let code = direct::open_pairing(state_dir)
        .unwrap_or_else(|e| fail(&format!("couldn't open pairing: {e}")));
    println!(
        "Pairing code: {} {}\n\nIn LunoPeak on your other computer, open Settings → Other machines,\n\
         pick this machine and enter the code. It works once, for {} minutes.\n\
         `lunopeak-node --listen` must be running on this machine.",
        &code[..3],
        &code[3..],
        direct::PAIR_WINDOW.as_secs() / 60
    );
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let now = direct::paired_hubs(state_dir);
        if let Some(h) = now.iter().find(|h| !before.contains(h)) {
            println!("\nPaired with \"{}\".", h.hub_name);
            return;
        }
        if !direct::pairing_open(state_dir) {
            println!("\nPairing closed (timed out or too many wrong codes). Run `lunopeak-node pair` again.");
            std::process::exit(1);
        }
    }
}

fn hubs(state_dir: &Path) {
    let hubs = direct::paired_hubs(state_dir);
    if hubs.is_empty() {
        println!("Not shared with any app yet. Run `lunopeak-node pair` to pair one.");
    }
    for h in hubs {
        println!("{}  ({})", h.hub_name, &h.hub_id[..8]);
    }
}

fn unpair(state_dir: &Path, who: &str) {
    let hubs = direct::paired_hubs(state_dir);
    let matches: Vec<_> = hubs
        .iter()
        .filter(|h| h.hub_name.eq_ignore_ascii_case(who) || h.hub_id.starts_with(&who.to_lowercase()))
        .collect();
    match matches.as_slice() {
        [h] => match direct::unpair_hub(state_dir, &h.hub_id) {
            Ok(_) => println!("Stopped sharing with \"{}\".", h.hub_name),
            Err(e) => fail(&format!("couldn't save: {e}")),
        },
        [] => fail(&format!("no paired app called {who:?}; see `lunopeak-node hubs`")),
        _ => fail(&format!("more than one app matches {who:?}; use the id from `lunopeak-node hubs`")),
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
    node_wire::stamp_live(&mut data, &args.name);
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
            s.host = Some(args.name.clone());
            RemoteSession::new(agent, s)
        })
        .collect();
    SessionsData { sessions }
}

/// Writes one snapshot to each of its paths (the shared folder, the outbox
/// `--listen` serves), skipping writes whose data hasn't changed so a sync
/// tool isn't asked to ship the same bytes every few seconds.
struct Publisher {
    paths: Vec<PathBuf>,
    /// Fingerprint of the last data written.
    last_fingerprint: Option<Vec<u8>>,
    last_write: Option<Instant>,
}

impl Publisher {
    fn new(paths: Vec<PathBuf>) -> Self {
        Publisher {
            paths,
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
            machine_id: args.machine_id.clone(),
            name: args.name.clone(),
            node_version: lunopeak_core::VERSION.to_string(),
            os: std::env::consts::OS.to_string(),
            generated_at: now_ms(),
            includes_prompts: args.share_prompts,
            data,
        };
        let mut ok = true;
        for path in &self.paths {
            if let Err(e) = write_atomic(path, &envelope) {
                ok = false;
                eprintln!("lunopeak-node: writing {} failed: {e}", path.display());
                lunopeak_core::elog!(error, "node", "writing {} failed: {e}", path.display());
            }
        }
        if ok {
            self.last_fingerprint = Some(fingerprint);
            self.last_write = Some(Instant::now());
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
fn parse_args(raw: Vec<String>) -> Result<Option<Command>, String> {
    let mut out = None;
    let mut listen = false;
    let mut bind: Option<String> = None;
    let mut name = None;
    let mut interval = 5;
    let mut sessions_interval = 60;
    let mut share_prompts = false;
    let mut state_dir = None;
    let mut once = false;
    let mut words: Vec<String> = Vec::new();

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
            "--listen" => listen = true,
            "--bind" => {
                bind = Some(value("--bind")?);
                listen = true;
            }
            "--name" | "--host" => name = Some(value(&flag)?),
            "--interval" => interval = secs(&value("--interval")?, "--interval")?,
            "--sessions-interval" => {
                sessions_interval = secs(&value("--sessions-interval")?, "--sessions-interval")?
            }
            "--share-prompts" => share_prompts = true,
            "--state-dir" => state_dir = Some(PathBuf::from(value("--state-dir")?)),
            "--once" => once = true,
            other if !other.starts_with('-') => words.push(other.to_string()),
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    match words.first().map(String::as_str) {
        Some("pair") if words.len() == 1 => return Ok(Some(Command::Pair { state_dir })),
        Some("hubs") if words.len() == 1 => return Ok(Some(Command::Hubs { state_dir })),
        Some("unpair") if words.len() == 2 => {
            return Ok(Some(Command::Unpair {
                state_dir,
                who: words[1].clone(),
            }))
        }
        Some("unpair") => return Err("unpair needs the app's name or id".into()),
        Some(other) => return Err(format!("unknown command: {other}")),
        None => {}
    }

    if out.is_none() && !listen {
        return Err("pass --listen, --out <DIR>, or both".into());
    }
    let listen = match (listen, bind) {
        (false, _) => None,
        (true, None) => Some(SocketAddr::from(([0, 0, 0, 0], direct::DEFAULT_PORT))),
        (true, Some(b)) => Some(parse_bind(&b)?),
    };
    let name = match name {
        Some(n) => node_wire::clean_name(&n).ok_or_else(|| format!("name {n:?} is empty"))?,
        None => node_wire::default_name().ok_or("couldn't read this machine's host name; pass --name")?,
    };
    Ok(Some(Command::Run(Args {
        out,
        listen,
        name,
        interval: Duration::from_secs(interval),
        sessions_interval: Duration::from_secs(sessions_interval),
        share_prompts,
        state_dir,
        machine_id: String::new(),
        once,
    })))
}

/// `ADDR`, `ADDR:PORT` or `:PORT`, with IPv6 in brackets.
fn parse_bind(v: &str) -> Result<SocketAddr, String> {
    if let Ok(a) = v.parse::<SocketAddr>() {
        return Ok(a);
    }
    if let Some(port) = v.strip_prefix(':') {
        let port: u16 = port.parse().map_err(|_| format!("bad port in --bind {v:?}"))?;
        return Ok(SocketAddr::from(([0, 0, 0, 0], port)));
    }
    let ip: std::net::IpAddr = v
        .trim_matches(|c| c == '[' || c == ']')
        .parse()
        .map_err(|_| format!("--bind takes an IP address, optionally with :PORT (got {v:?})"))?;
    Ok(SocketAddr::new(ip, direct::DEFAULT_PORT))
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
    fn parses_commands_and_bind_addresses() {
        let p = |a: &[&str]| parse_args(a.iter().map(|s| s.to_string()).collect());
        assert!(matches!(p(&["pair"]), Ok(Some(Command::Pair { .. }))));
        assert!(matches!(p(&["unpair", "My Mac"]), Ok(Some(Command::Unpair { .. }))));
        assert!(p(&["--name", "x"]).is_err(), "needs --listen or --out");
        let Ok(Some(Command::Run(a))) = p(&["--listen", "--name", "x"]) else { panic!() };
        assert_eq!(a.listen, Some(SocketAddr::from(([0, 0, 0, 0], direct::DEFAULT_PORT))));
        assert_eq!(parse_bind("100.64.1.2").unwrap().to_string(), "100.64.1.2:47390");
        assert_eq!(parse_bind(":9000").unwrap().port(), 9000);
        assert_eq!(parse_bind("[::1]:9000").unwrap().to_string(), "[::1]:9000");
        assert!(parse_bind("example.com").is_err());
    }
}
