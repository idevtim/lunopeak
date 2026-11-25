//! "Share this machine": the app doing what `lunopeak-node --listen` does,
//! so a computer with LunoPeak installed can be paired without a terminal.
//!
//! Runs in the process that's always up: the menu-bar agent on macOS (the
//! window process comes and goes), the single process on Windows and Linux.
//! Settings lives in the window process, so the two talk through files in the
//! app dir: settings.json (read through `SettingsCache`), the pairing window
//! and paired hubs (`lunopeak_core::direct`), and `sharing-status.json`,
//! which this loop writes so Settings can say whether sharing is running.

use std::path::PathBuf;
use std::time::Duration;

use lunopeak_core::direct::{self, Server};
use lunopeak_core::discovery::Advertiser;
use lunopeak_core::feeds::Sources;
use lunopeak_core::node_wire;
use lunopeak_core::share::{Caches, Publishers, ShareConfig};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::scanners::codex::Cache as CodexCache;
use crate::scanners::sessions::Cache as SessionsCache;
use crate::SettingsCache;

const TICK: Duration = Duration::from_secs(5);
/// Same cadence as the node's default `--sessions-interval`.
const SESSIONS_EVERY: Duration = Duration::from_secs(60);
const STATUS_FILE: &str = "sharing-status.json";
/// Settings treats an older status as "not running" (the sharing process is
/// gone without saying so).
pub const STATUS_STALE_MS: i64 = 20_000;

/// What the sharing loop last did, for Settings.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub running: bool,
    pub name: Option<String>,
    pub port: Option<u16>,
    /// Advertised on the local network.
    pub discoverable: bool,
    pub error: Option<String>,
    /// Epoch ms this was written.
    pub updated_at: i64,
}

/// Start the loop. Call once, from the always-running process.
pub fn start(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("lunopeak-sharing".into())
        .spawn(move || {
            let mut state = Running::default();
            loop {
                state.step(&app);
                std::thread::sleep(TICK);
            }
        });
}

#[derive(Default)]
struct Running {
    server: Option<(Server, String)>,
    advert: Option<Advertiser>,
    publishers: Option<(Vec<PathBuf>, Publishers)>,
    last_error: Option<String>,
}

impl Running {
    fn step(&mut self, app: &AppHandle) {
        let Ok(settings) = app.state::<SettingsCache>().load(app) else {
            return;
        };
        let Some(dir) = crate::statusline::app_dir() else {
            return;
        };
        if !settings.share.enabled {
            if self.server.is_some() || self.publishers.is_some() {
                self.stop();
                direct::close_pairing(&dir);
            }
            write_status(&dir, &ShareStatus::default());
            return;
        }
        let Some(machine_id) = node_wire::local_machine_id() else {
            self.fail(&dir, "Couldn't read this machine's id".into());
            return;
        };
        let name = settings
            .share
            .name
            .as_deref()
            .and_then(node_wire::clean_name)
            .or_else(node_wire::default_name)
            .unwrap_or_else(|| "LunoPeak".into());
        let cfg = ShareConfig {
            machine_id: machine_id.clone(),
            name: name.clone(),
            share_prompts: settings.share.share_prompts,
        };

        // Where to write: the outbox the server reads, and the shared folder
        // too when one is set, so folder-only machines see this one as well.
        let mut dirs = vec![dir.join(OUTBOX)];
        if let Some(folder) = settings.remote.folder.as_deref().filter(|f| !f.trim().is_empty()) {
            dirs.push(PathBuf::from(folder).join(node_wire::NODES_DIR).join(&machine_id));
        }
        if self.publishers.as_ref().is_none_or(|(d, _)| *d != dirs) {
            for d in &dirs {
                let _ = std::fs::create_dir_all(d);
            }
            self.publishers = Some((dirs.clone(), Publishers::new(&dirs, SESSIONS_EVERY)));
        }

        // (Re)start the server when it isn't running or the name changed
        // (`/v1/hello` and the advertisement carry it).
        if self.server.as_ref().is_none_or(|(_, n)| *n != name) {
            self.stop_server();
            let bind = std::net::SocketAddr::from(([0, 0, 0, 0], direct::DEFAULT_PORT));
            match direct::serve(direct::ServeConfig {
                bind,
                state_dir: dir.clone(),
                outbox: dir.join(OUTBOX),
                name: name.clone(),
            }) {
                Ok(server) => {
                    self.advert = lunopeak_core::discovery::advertise(&machine_id, &name, server.addr.port())
                        .inspect_err(|e| crate::elog!(warn, "sharing", "advertise: {e}"))
                        .ok();
                    crate::elog!(info, "sharing", "sharing as {name:?} on {}", server.addr);
                    self.server = Some((server, name.clone()));
                    self.last_error = None;
                }
                Err(e) => {
                    let msg = if e.kind() == std::io::ErrorKind::AddrInUse {
                        format!(
                            "Port {} is in use. Is lunopeak-node --listen running on this machine? Stop it to share from the app.",
                            direct::DEFAULT_PORT
                        )
                    } else {
                        format!("Couldn't start sharing: {e}")
                    };
                    self.fail(&dir, msg);
                    return;
                }
            }
        }

        let src = Sources::from(&settings.agents);
        let caches = Caches {
            sessions: app.state::<SessionsCache>().inner().clone(),
            codex: app.state::<CodexCache>().inner().clone(),
        };
        let errors = match self.publishers.as_mut() {
            Some((_, p)) => p.tick(&cfg, src, &caches),
            None => Vec::new(),
        };
        write_status(
            &dir,
            &ShareStatus {
                running: true,
                name: Some(name),
                port: self.server.as_ref().map(|(s, _)| s.addr.port()),
                discoverable: self.advert.is_some(),
                error: errors.into_iter().next().or_else(|| self.last_error.clone()),
                updated_at: now_ms(),
            },
        );
    }

    fn fail(&mut self, dir: &std::path::Path, msg: String) {
        if self.last_error.as_deref() != Some(&msg) {
            crate::elog!(warn, "sharing", "{msg}");
        }
        self.last_error = Some(msg.clone());
        write_status(
            dir,
            &ShareStatus {
                error: Some(msg),
                updated_at: now_ms(),
                ..Default::default()
            },
        );
    }

    fn stop_server(&mut self) {
        self.advert = None;
        if let Some((server, _)) = self.server.take() {
            server.stop();
        }
    }

    fn stop(&mut self) {
        self.stop_server();
        self.publishers = None;
        self.last_error = None;
    }
}

/// Folder under the app dir holding what sharing serves. The node's default
/// `--state-dir` is the same app dir, so the two never run at once (the port
/// tells them apart: the second one can't bind).
const OUTBOX: &str = "outbox";

fn write_status(dir: &std::path::Path, status: &ShareStatus) {
    if let Ok(bytes) = serde_json::to_vec(status) {
        let _ = node_wire::replace_file(&dir.join(STATUS_FILE), &bytes);
    }
}

/// What the sharing process last wrote. `running` is false when it's stale.
pub fn read_status() -> ShareStatus {
    let Some(dir) = crate::statusline::app_dir() else {
        return ShareStatus::default();
    };
    let mut s: ShareStatus = std::fs::read(dir.join(STATUS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    if now_ms() - s.updated_at > STATUS_STALE_MS {
        s.running = false;
    }
    s
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}
