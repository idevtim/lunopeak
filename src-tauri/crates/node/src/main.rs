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
use std::time::Duration;

mod service;

use lunopeak_core::direct;
use lunopeak_core::feeds::Sources;
use lunopeak_core::models::AgentSources;
use lunopeak_core::node_wire;
use lunopeak_core::share::{Caches, Publishers, ShareConfig};

const USAGE: &str = "\
lunopeak-node: publish this machine's coding-agent sessions to a LunoPeak hub

USAGE:
    lunopeak-node [--listen] [--out <DIR>] [OPTIONS]
    lunopeak-node pair             Show a code to pair a LunoPeak app with
    lunopeak-node hubs             List the apps this machine shares with
    lunopeak-node unpair <NAME>    Stop sharing with one of them
    lunopeak-node install [OPTIONS]
                                   Keep it running in the background, started
                                   at login (shares directly unless --out is
                                   given; takes the same options as below)
    lunopeak-node uninstall        Remove that background service
    lunopeak-node status           Show the service, machine id and pairings

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

/// Folder under the state dir holding what `--listen` serves.
const OUTBOX: &str = "outbox";

enum Command {
    Run(Args),
    Pair { state_dir: Option<PathBuf> },
    Hubs { state_dir: Option<PathBuf> },
    Unpair { state_dir: Option<PathBuf>, who: String },
    /// Register `lunopeak-node <args>` to run in the background at login.
    Install { state_dir: Option<PathBuf>, args: Vec<String> },
    Uninstall,
    Status { state_dir: Option<PathBuf> },
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
        Command::Install { state_dir, args } => install(&state_dir_or_exit(state_dir), &args),
        Command::Uninstall => match service::uninstall() {
            Ok(()) => println!("Removed the background service. Pairings are kept; `lunopeak-node install` brings it back."),
            Err(e) => fail(&e),
        },
        Command::Status { state_dir } => status(&state_dir_or_exit(state_dir)),
    }
}

fn install(state_dir: &Path, args: &[String]) {
    match service::install(state_dir, args) {
        Ok(notes) => {
            println!("Installed: lunopeak-node {} now runs in the background.", args.join(" "));
            for n in notes {
                println!("  {n}");
            }
            if direct::paired_hubs(state_dir).is_empty() && args.iter().any(|a| a == "--listen" || a.starts_with("--bind")) {
                println!(
                    "\nNext, pair it: run `{} pair` and enter the code in LunoPeak on your other computer.",
                    service::installed_path(state_dir).display()
                );
            }
        }
        Err(e) => fail(&format!("install failed: {e}")),
    }
}

fn status(state_dir: &Path) {
    let (installed, running) = service::status();
    println!(
        "Background service: {}",
        match (installed, running) {
            (false, _) => "not installed (run `lunopeak-node install`)",
            (true, Some(true)) => "installed, running",
            (true, Some(false)) => "installed, not running",
            (true, None) => "installed",
        }
    );
    match node_wire::machine_id(state_dir) {
        Ok(id) => println!("Machine id: {id}"),
        Err(e) => println!("Machine id: unreadable ({e})"),
    }
    let hubs = direct::paired_hubs(state_dir);
    println!("Paired apps: {}", if hubs.is_empty() { "none".to_string() } else { hubs.len().to_string() });
    for h in hubs {
        println!("  {}", h.hub_name);
    }
    if direct::pairing_open(state_dir) {
        println!("A pairing code is open.");
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
    let cfg = ShareConfig {
        machine_id: args.machine_id.clone(),
        name: args.name.clone(),
        share_prompts: args.share_prompts,
    };
    let mut publishers = Publishers::new(&dirs, args.sessions_interval);
    let caches = Caches::default();
    let tick = |p: &mut Publishers| {
        for e in p.tick(&cfg, sources(), &caches) {
            eprintln!("lunopeak-node: {e}");
        }
    };
    tick(&mut publishers);
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
        // Advertise on the local network only when listening on it: a
        // server bound to one private address (say Tailscale) is reached by
        // that address instead.
        let advert = if bind.ip().is_unspecified() {
            match lunopeak_core::discovery::advertise(&args.machine_id, &args.name, server.addr.port()) {
                Ok(a) => Some(a),
                Err(e) => {
                    eprintln!("  couldn't advertise on the local network ({e}); pair by address instead");
                    None
                }
            }
        } else {
            None
        };
        (server, advert)
    });
    loop {
        std::thread::sleep(args.interval);
        tick(&mut publishers);
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

/// `Ok(None)` means help or version was printed and there's nothing to run.
fn parse_args(raw: Vec<String>) -> Result<Option<Command>, String> {
    // Service commands come first on the line.
    match raw.first().map(String::as_str) {
        Some("install") => {
            let mut args: Vec<String> = raw[1..].to_vec();
            let shares = args
                .iter()
                .any(|a| a == "--listen" || a == "--out" || a.starts_with("--bind") || a.starts_with("--out="));
            if !shares {
                // Installing with no target means sharing directly.
                args.insert(0, "--listen".into());
            }
            if args.iter().any(|a| a == "--once") {
                return Err("install runs the node continuously; drop --once".into());
            }
            // Check the flags now, not when the service fails to start.
            let Some(Command::Run(run)) = parse_args(args.clone())? else {
                return Err("install takes the same options as running the node".into());
            };
            return Ok(Some(Command::Install {
                state_dir: run.state_dir,
                args,
            }));
        }
        Some("uninstall") if raw.len() == 1 => return Ok(Some(Command::Uninstall)),
        _ => {}
    }
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
        Some("status") if words.len() == 1 => return Ok(Some(Command::Status { state_dir })),
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
    fn parses_commands_and_bind_addresses() {
        let p = |a: &[&str]| parse_args(a.iter().map(|s| s.to_string()).collect());
        assert!(matches!(p(&["pair"]), Ok(Some(Command::Pair { .. }))));
        assert!(matches!(p(&["unpair", "My Mac"]), Ok(Some(Command::Unpair { .. }))));
        let Ok(Some(Command::Install { args, .. })) = p(&["install", "--name", "Build box"]) else { panic!() };
        assert_eq!(args, ["--listen", "--name", "Build box"]);
        let Ok(Some(Command::Install { args, .. })) = p(&["install", "--out", "/srv/sync"]) else { panic!() };
        assert_eq!(args, ["--out", "/srv/sync"]);
        assert!(p(&["install", "--once"]).is_err());
        assert!(p(&["install", "--bogus"]).is_err());
        assert!(matches!(p(&["status"]), Ok(Some(Command::Status { .. }))));
        assert!(p(&["--name", "x"]).is_err(), "needs --listen or --out");
        let Ok(Some(Command::Run(a))) = p(&["--listen", "--name", "x"]) else { panic!() };
        assert_eq!(a.listen, Some(SocketAddr::from(([0, 0, 0, 0], direct::DEFAULT_PORT))));
        assert_eq!(parse_bind("100.64.1.2").unwrap().to_string(), "100.64.1.2:47390");
        assert_eq!(parse_bind(":9000").unwrap().port(), 9000);
        assert_eq!(parse_bind("[::1]:9000").unwrap().to_string(), "[::1]:9000");
        assert!(parse_bind("example.com").is_err());
    }
}
