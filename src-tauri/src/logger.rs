//! The runtime log lives in `lunopeak_core::logger` (shared with the node);
//! this wrapper only resolves the app's config dir from Tauri.

pub use lunopeak_core::logger::*;
use tauri::{AppHandle, Manager};

/// Point the log at `{app_config_dir}/logs/diagnostics.jsonl`.
pub fn init(app: &AppHandle) {
    if let Ok(config_dir) = app.path().app_config_dir() {
        init_at(&config_dir.join("logs"), "LunoPeak");
    }
}
