//! Keeps directly paired machines' snapshots fresh in the window process.
//!
//! Every few seconds (or right away when woken), each paired machine's
//! `live.json` / `sessions.json` are fetched into `<app dir>/remote-cache/`
//! with `lunopeak_core::direct::sync`. The hub then reads that folder like a
//! shared folder, so pulled data goes through the same checks as synced data.
//! Only the window process runs this: the menu bar never shows other machines.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use lunopeak_core::direct::{self, PairedMachine};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::SettingsCache;

/// How often to fetch when nothing wakes the loop early. Unchanged files
/// cost one small round trip (`If-None-Match`).
const POLL: Duration = Duration::from_secs(5);

/// Last fetch result per paired machine, for Settings.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    /// Epoch ms of the last successful fetch.
    pub last_ok: Option<i64>,
    /// Why the last fetch failed, in words for the user.
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    status: HashMap<String, LinkStatus>,
    wake: bool,
    /// Machines with a fetch in flight.
    busy: std::collections::HashSet<String>,
    /// Per machine, the ETag of each file last fetched.
    etags: HashMap<String, HashMap<String, String>>,
}

/// Managed state: fetch status plus a way to wake the loop.
#[derive(Default, Clone)]
pub struct DirectLinks {
    inner: Arc<(Mutex<Inner>, Condvar)>,
}

impl DirectLinks {
    pub fn status(&self) -> HashMap<String, LinkStatus> {
        self.inner.0.lock().map(|i| i.status.clone()).unwrap_or_default()
    }

    /// Fetch now instead of waiting for the next poll.
    pub fn wake(&self) {
        if let Ok(mut i) = self.inner.0.lock() {
            i.wake = true;
            self.inner.1.notify_all();
        }
    }

    fn set(&self, id: &str, name: &str, result: Result<(), String>) {
        if let Ok(mut i) = self.inner.0.lock() {
            let s = i.status.entry(id.to_string()).or_default();
            // Log changes of state, not every poll, so a machine that's off
            // overnight leaves two lines, not ten thousand.
            match (&s.error, &result) {
                (Some(_), Ok(())) => crate::elog!(info, "direct", "{name}: connected again"),
                (None, Err(e)) => crate::elog!(warn, "direct", "{name}: {e}"),
                (Some(was), Err(e)) if was != e => crate::elog!(warn, "direct", "{name}: {e}"),
                _ => {}
            }
            match result {
                Ok(()) => {
                    s.last_ok = Some(now_ms());
                    s.error = None;
                }
                Err(e) => s.error = Some(e),
            }
        }
    }

    /// Claim `id` for a fetch; false when one is already running for it.
    fn start_fetch(&self, id: &str) -> bool {
        self.inner.0.lock().is_ok_and(|mut i| i.busy.insert(id.to_string()))
    }

    fn end_fetch(&self, id: &str) {
        if let Ok(mut i) = self.inner.0.lock() {
            i.busy.remove(id);
        }
    }

    fn forget_others(&self, keep: &[PairedMachine]) {
        if let Ok(mut i) = self.inner.0.lock() {
            i.status.retain(|id, _| keep.iter().any(|m| &m.machine_id == id));
        }
    }

    fn sleep(&self) {
        let (lock, cvar) = &*self.inner;
        let Ok(guard) = lock.lock() else { return };
        let Ok((mut guard, _)) = cvar.wait_timeout_while(guard, POLL, |i| !i.wake) else {
            return;
        };
        guard.wake = false;
    }
}

pub fn app_dir() -> Option<PathBuf> {
    crate::statusline::app_dir()
}

pub fn cache_root() -> Option<PathBuf> {
    Some(app_dir()?.join(direct::CACHE_DIR))
}

/// Start the fetch loop. Call once, from the window process.
pub fn start(app: AppHandle) {
    let links = app.state::<DirectLinks>().inner().clone();
    let _ = std::thread::Builder::new()
        .name("lunopeak-direct".into())
        .spawn(move || loop {
            let enabled = app
                .state::<SettingsCache>()
                .load(&app)
                .map(|s| s.remote.enabled)
                .unwrap_or(false);
            if enabled {
                sync_all(&links, &app.state::<Discovery>());
            }
            links.sleep();
        });
}

/// Start a fetch for every paired machine that doesn't have one running.
/// Each runs on its own thread and reports as soon as it's done, so a machine
/// that's off (a 5s connect timeout per address tried) never delays the
/// others' live data, and a reconnect clears its error right away.
fn sync_all(links: &DirectLinks, discovery: &Discovery) {
    let (Some(dir), Some(cache)) = (app_dir(), cache_root()) else {
        return;
    };
    let machines = direct::paired_machines(&dir);
    links.forget_others(&machines);
    remove_unpaired_caches(&cache, &machines);
    if machines.is_empty() {
        return;
    }
    // Where each machine is advertised now, in case its address changed
    // (a new DHCP lease) since it was paired.
    let seen: HashMap<String, Vec<String>> = discovery
        .machines()
        .unwrap_or_default()
        .into_iter()
        .map(|d| (d.machine_id, d.addrs))
        .collect();
    for m in machines {
        if !links.start_fetch(&m.machine_id) {
            continue;
        }
        let alternates = seen.get(&m.machine_id).cloned().unwrap_or_default();
        let (links, dir, cache) = (links.clone(), dir.clone(), cache.clone());
        let _ = std::thread::Builder::new()
            .name("lunopeak-direct-fetch".into())
            .spawn(move || {
                fetch_one(&links, &dir, &cache, &m, &alternates);
                links.end_fetch(&m.machine_id);
            });
    }
}

/// Fetch one machine now and record the result. Also used right after
/// pairing, so the new machine shows up without waiting for the next poll.
pub fn fetch_one(links: &DirectLinks, dir: &Path, cache: &Path, m: &PairedMachine, alternates: &[String]) {
    let mut etags = links
        .inner
        .0
        .lock()
        .ok()
        .and_then(|i| i.etags.get(&m.machine_id).cloned())
        .unwrap_or_default();
    let result = direct::sync_any(m, alternates, cache, &mut etags).map_err(|e| e.to_string());
    if let Ok(mut i) = links.inner.0.lock() {
        i.etags.insert(m.machine_id.clone(), etags);
    }
    if let Ok(Some(addr)) = &result {
        // Re-read, so a pairing saved meanwhile isn't lost.
        let mut all = direct::paired_machines(dir);
        if let Some(saved) = all.iter_mut().find(|x| x.machine_id == m.machine_id) {
            crate::elog!(info, "direct", "{} moved to {addr}", m.name);
            saved.addr = addr.clone();
            let _ = direct::save_paired_machines(dir, &all);
        }
    }
    links.set(&m.machine_id, &m.name, result.map(|_| ()));
}

/// A machine that was unpaired shouldn't keep showing from old fetches.
fn remove_unpaired_caches(cache: &std::path::Path, machines: &[PairedMachine]) {
    let Ok(read) = std::fs::read_dir(cache.join(lunopeak_core::node_wire::NODES_DIR)) else {
        return;
    };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if lunopeak_core::node_wire::is_machine_id(&name) && !machines.iter().any(|m| m.machine_id == name) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Browses the local network for sharing machines, started the first time
/// Settings asks (so macOS's Local Network prompt appears only when someone
/// is adding a machine), and kept for the life of the window process.
#[derive(Default)]
pub struct Discovery {
    browser: Mutex<Option<lunopeak_core::discovery::Browser>>,
}

impl Discovery {
    pub fn machines(&self) -> Result<Vec<lunopeak_core::discovery::Discovered>, String> {
        let mut guard = self.browser.lock().map_err(|_| "discovery is busy".to_string())?;
        if guard.is_none() {
            *guard = Some(lunopeak_core::discovery::Browser::start()?);
        }
        let me = lunopeak_core::node_wire::local_machine_id();
        Ok(guard
            .as_ref()
            .map(|b| b.machines())
            .unwrap_or_default()
            .into_iter()
            .filter(|d| Some(&d.machine_id) != me.as_ref())
            .collect())
    }
}
