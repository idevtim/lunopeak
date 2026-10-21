//! Background update check for the menu bar.
//!
//! The main window checks for updates from JS (`src/lib/updates.ts`), but on
//! macOS the tray lives in a separate menu-bar agent process that may be the
//! only part of the app running (login launch, window closed). So the
//! tray-owning process runs its own quiet check here: a hit badges the menu
//! bar icon and lets the popover offer "Restart to update".

use crate::models::Settings;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Let launch finish (and the window's own boot-time check go first) before
/// hitting the update server.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// Releases are rare; a few checks a day is plenty for a badge.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// How often the loop wakes to see whether `CHECK_INTERVAL` has passed. Tokio
/// sleeps on the monotonic clock, which stops while the Mac sleeps, so a
/// single 6h sleep could stretch to days on a laptop that's often closed.
/// Waking often and measuring wall-clock time keeps an app that's left open
/// for weeks checking on schedule.
const POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// The update the last check found, kept so "Restart to update" can install
/// it without a second round-trip to the update server.
static PENDING: Mutex<Option<Update>> = Mutex::new(None);

/// Version of the update waiting to be installed, if any.
pub fn available_version() -> Option<String> {
    PENDING.lock().unwrap().as_ref().map(|u| u.version.clone())
}

/// Start the periodic check. Called once from `tray::install` — whether or
/// not the tray is shown — so only the tray-owning process runs it.
pub fn spawn_check_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        let mut last_check: Option<SystemTime> = None;
        loop {
            // Only a check that reached the server counts, so being offline
            // retries on the next poll instead of waiting out the interval.
            if check_enabled(&app)
                && due(last_check, SystemTime::now())
                && check(&app).await.is_ok()
            {
                last_check = Some(SystemTime::now());
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

/// Whether a check is due. A clock that moved backwards counts as due rather
/// than stalling checks until it catches up.
fn due(last_check: Option<SystemTime>, now: SystemTime) -> bool {
    match last_check {
        None => true,
        Some(last) => now
            .duration_since(last)
            .map_or(true, |d| d >= CHECK_INTERVAL),
    }
}

/// Honors Settings → "Check for updates" — the same switch that gates the
/// window's boot-time check.
fn check_enabled(app: &AppHandle) -> bool {
    let settings: Settings = crate::tray::current_settings(app);
    settings.general.check_updates
}

/// Ask the update server once; `Ok` carries the new version, if any. Quiet on
/// failure (offline, no updater config in dev): the badge just stays as it was.
async fn check(app: &AppHandle) -> Result<Option<String>, ()> {
    let updater = app.updater().map_err(|err| {
        crate::elog!(warn, "updates", "updater unavailable: {err}");
    })?;
    let found = updater.check().await.map_err(|err| {
        crate::elog!(warn, "updates", "check failed: {err}");
    })?;
    let version = found.as_ref().map(|u| u.version.clone());
    let changed = available_version() != version;
    *PENDING.lock().unwrap() = found;
    if changed {
        if let Some(v) = &version {
            crate::elog!(info, "updates", "update available: {v}");
        }
        crate::tray::retitle(app);
        let _ = app.emit("update://available", version.clone());
    }
    Ok(version)
}

/// Download and install the pending update (re-checking if the badge came
/// from an earlier run), then relaunch. Only returns on failure.
pub async fn install_and_restart(app: AppHandle) -> Result<(), String> {
    let pending = PENDING.lock().unwrap().clone();
    let update = match pending {
        Some(update) => update,
        None => {
            check(&app)
                .await
                .ok()
                .flatten()
                .ok_or("No update is available")?;
            PENDING
                .lock()
                .unwrap()
                .clone()
                .ok_or("No update is available")?
        }
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|err| {
            crate::elog!(error, "updates", "install failed: {err}");
            err.to_string()
        })?;
    crate::commands::restart_all(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_by_wall_clock_interval() {
        let now = SystemTime::now();
        assert!(due(None, now));
        assert!(!due(Some(now - Duration::from_secs(60)), now));
        assert!(due(Some(now - CHECK_INTERVAL), now));
        // Clock set back: check rather than wait it out.
        assert!(due(Some(now + Duration::from_secs(60)), now));
    }
}
