//! LunoPeak's scanners, models and pricing, with no GUI dependencies.
//!
//! The desktop app (`src-tauri`) and the headless `lunopeak-node` both build
//! on this crate, so every provider scanner is written once and works on any
//! machine — locally in the app, or on a remote box reporting to it.

#[macro_use]
pub mod logger;
pub mod feeds;
pub mod hub;
pub mod models;
pub mod node_wire;
pub mod pricing;
pub mod process_ext;
pub mod scanners;
pub mod statusline;

/// The app's release version (the `[package] version` of `src-tauri/Cargo.toml`,
/// read by `build.rs`). Not `CARGO_PKG_VERSION`: that would be this crate's own
/// version, and the session disk cache keys on the app's.
pub const VERSION: &str = env!("LUNOPEAK_VERSION");

static MENUBAR_AGENT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Set once at startup in the macOS menu-bar agent process. Each process's
/// Keychain reads prompt separately (the agent is its own bundle identity),
/// so secrets are split by owner: the window reads the API keys, the agent
/// reads the browser cookies. Always false on Windows/Linux, where one
/// process does everything, and in the node.
pub fn set_menubar_agent(on: bool) {
    MENUBAR_AGENT.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn is_menubar_agent() -> bool {
    MENUBAR_AGENT.load(std::sync::atomic::Ordering::Relaxed)
}
