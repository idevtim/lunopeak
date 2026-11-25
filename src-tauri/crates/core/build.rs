//! Expose the app's release version as `LUNOPEAK_VERSION`. The release
//! scripts read the first `version = ` line of `src-tauri/Cargo.toml`, so that
//! stays the single place a version is bumped.
use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = std::fs::read_to_string(&manifest).expect("read src-tauri/Cargo.toml");
    let version = text
        .lines()
        .find_map(|l| {
            let rest = l
                .trim()
                .strip_prefix("version")?
                .trim_start()
                .strip_prefix('=')?;
            Some(rest.trim().trim_matches('"').to_string())
        })
        .expect("version line in src-tauri/Cargo.toml");
    println!("cargo:rustc-env=LUNOPEAK_VERSION={version}");
}
