//! Keeps directly paired machines' snapshots fresh in the window process.
//!
//! Every few seconds (or right away when woken), each paired machine's
//! `live.json` / `sessions.json` are fetched into `<app dir>/remote-cache/`
//! with `lunopeak_core::direct::sync`. The hub then reads that folder like a
//! shared folder, so pulled data goes through the same checks as synced data.
//! Only the window process runs this: the menu bar never shows other machines.

use std::collections::HashMap;
use std::path::PathBuf;
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

    fn set(&self, id: &str, result: Result<(), String>) {
        if let Ok(mut i) = self.inner.0.lock() {
            let s = i.status.entry(id.to_string()).or_default();
            match result {
                Ok(()) => {
                    s.last_ok = Some(now_ms());
                    s.error = None;
                }
                Err(e) => s.error = Some(e),
            }
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
                sync_all(&links);
            }
            links.sleep();
        });
}

/// Fetch every paired machine at once, so one that's off (a 5s connect
/// timeout) doesn't hold up the rest.
fn sync_all(links: &DirectLinks) {
    let (Some(dir), Some(cache)) = (app_dir(), cache_root()) else {
        return;
    };
    let machines = direct::paired_machines(&dir);
    links.forget_others(&machines);
    remove_unpaired_caches(&cache, &machines);
    static ETAGS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
    let results: Vec<(String, Result<(), String>, HashMap<String, String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = machines
            .iter()
            .map(|m| {
                let mut etags = ETAGS
                    .lock()
                    .ok()
                    .and_then(|e| e.clone())
                    .unwrap_or_default();
                let cache = &cache;
                scope.spawn(move || {
                    let r = direct::sync(m, cache, &mut etags).map_err(|e| e.to_string());
                    (m.machine_id.clone(), r, etags)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut merged = HashMap::new();
    for (id, r, etags) in results {
        links.set(&id, r);
        merged.extend(etags.into_iter().filter(|(k, _)| k.starts_with(&id)));
    }
    if let Ok(mut e) = ETAGS.lock() {
        *e = Some(merged);
    }
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
