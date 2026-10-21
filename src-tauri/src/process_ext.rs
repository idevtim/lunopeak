use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Command {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Command {
        self
    }
}

/// Augment `$PATH` so subprocesses can find user-installed CLIs (gh, git from
/// Homebrew/scoop/etc.) regardless of how the app was launched. GUI launches
/// don't always inherit the same PATH as a terminal shell:
/// - macOS Finder/Launchpad: minimal launchd PATH, no `/opt/homebrew/bin`.
/// - Linux desktop entries: usually inherit the user session PATH, but snap
///   and flatpak install dirs aren't always there.
/// - Windows Explorer: usually fine, but scoop/chocolatey/winget shim dirs
///   live under the user profile and aren't always propagated.
///
/// Must run once before any subprocess is spawned. Idempotent: already-present
/// dirs are skipped, so calling on a dev build (where the shell PATH is fine)
/// is harmless.
pub fn augment_path() {
    use std::path::PathBuf;

    let candidates = platform_path_candidates();
    let current = std::env::var_os("PATH").unwrap_or_default();
    let existing: Vec<PathBuf> = std::env::split_paths(&current).collect();
    let to_prepend: Vec<PathBuf> = candidates
        .into_iter()
        .filter(|p| p.is_dir() && !existing.contains(p))
        .collect();
    if to_prepend.is_empty() {
        return;
    }
    let merged: Vec<PathBuf> = to_prepend.into_iter().chain(existing).collect();
    if let Ok(joined) = std::env::join_paths(merged) {
        // SAFETY: called once at startup, before any threads are spawned.
        unsafe {
            std::env::set_var("PATH", joined);
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_path_candidates() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut v = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        v.push(home.join(".cargo/bin"));
        v.push(home.join(".local/bin"));
    }
    v
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_path_candidates() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut v = vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/snap/bin"),
        PathBuf::from("/var/lib/flatpak/exports/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        v.push(home.join(".cargo/bin"));
        v.push(home.join(".local/bin"));
        v.push(home.join(".local/share/flatpak/exports/bin"));
        v.push(home.join(".linuxbrew/bin"));
    }
    v
}

#[cfg(windows)]
fn platform_path_candidates() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut v: Vec<PathBuf> = Vec::new();

    // Per-machine installs (gh MSI, winget, chocolatey).
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        v.push(PathBuf::from(&pf).join("GitHub CLI"));
        v.push(PathBuf::from(&pf).join("Git\\cmd"));
    }
    if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
        v.push(PathBuf::from(&pf86).join("GitHub CLI"));
    }
    if let Some(pd) = std::env::var_os("ProgramData") {
        v.push(PathBuf::from(pd).join("chocolatey\\bin"));
    }

    // Per-user installs (scoop, winget links, cargo).
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(profile);
        v.push(p.join("scoop\\shims"));
        v.push(p.join(".cargo\\bin"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let l = PathBuf::from(local);
        v.push(l.join("Microsoft\\WinGet\\Links"));
        v.push(l.join("Programs\\GitHub CLI"));
    }

    v
}
