//! `lunopeak-node install` / `uninstall` / `status`: keep the node running
//! in the background, started at login, without a terminal open.
//!
//! The binary is first copied into the state dir (`bin/`), so the service
//! keeps working after the downloaded copy is deleted and a later `install`
//! upgrades it in place. Then, per platform, as the current user (never
//! root, since the node reads that user's agent folders):
//!
//! - macOS: a LaunchAgent, `~/Library/LaunchAgents/com.lunopeak.node.plist`,
//!   loaded with `launchctl bootstrap gui/<uid>`.
//! - Linux: a systemd user unit, `~/.config/systemd/user/lunopeak-node.service`,
//!   enabled with `systemctl --user enable --now`. A server with nobody logged
//!   in also needs `loginctl enable-linger`, which `install` suggests.
//! - Windows: a Task Scheduler task at logon, run through
//!   `conhost.exe --headless` so no console window opens.

use std::path::{Path, PathBuf};
use std::process::Command;

// Each platform uses one of these.
#[allow(dead_code)]
pub const LABEL: &str = "com.lunopeak.node";
#[allow(dead_code)]
const UNIT: &str = "lunopeak-node.service";
#[allow(dead_code)]
const TASK: &str = "LunoPeak node";

/// Copy this executable into `<state>/bin/` and return the copy's path.
fn install_binary(state_dir: &Path) -> Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|e| format!("can't find this program: {e}"))?;
    let bin = state_dir.join("bin");
    std::fs::create_dir_all(&bin).map_err(|e| format!("can't create {}: {e}", bin.display()))?;
    let name = if cfg!(windows) { "lunopeak-node.exe" } else { "lunopeak-node" };
    let dest = bin.join(name);
    if same_file(&me, &dest) {
        return Ok(dest);
    }
    // Copy beside, then rename over, so a running copy isn't half-written
    // (on Windows a running .exe can't be replaced, so stop it first).
    #[cfg(windows)]
    let _ = run("schtasks", &["/End", "/TN", TASK]);
    let tmp = bin.join(format!(".{name}.new"));
    std::fs::copy(&me, &tmp).map_err(|e| format!("can't copy to {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("can't replace {}: {e}", dest.display()))?;
    Ok(dest)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn run(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("couldn't run {cmd}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = if err.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { err };
        Err(format!("{cmd} {}: {}", args.join(" "), err.trim()))
    }
}

/// Install (or upgrade) the background service running with `args`, the
/// same flags `lunopeak-node` itself takes (minus `install`). Returns notes
/// for the user.
pub fn install(state_dir: &Path, args: &[String]) -> Result<Vec<String>, String> {
    let exe = install_binary(state_dir)?;
    let logs = state_dir.join("node-logs");
    let _ = std::fs::create_dir_all(&logs);
    let mut notes = vec![format!("Installed to {}", exe.display())];
    notes.extend(platform::install(&exe, args, &logs)?);
    // The service manager starts it asynchronously; give it a moment before
    // saying whether it's up.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let running = loop {
        if platform::status().1 == Some(true) {
            break true;
        }
        if std::time::Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    };
    notes.push(if running {
        "Running now.".to_string()
    } else {
        format!(
            "It hasn't started yet. If `lunopeak-node status` still says not running, see {}",
            logs.join("service.log").display()
        )
    });
    Ok(notes)
}

/// Where `install` puts the binary.
pub fn installed_path(state_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "lunopeak-node.exe" } else { "lunopeak-node" };
    state_dir.join("bin").join(name)
}

pub fn uninstall() -> Result<(), String> {
    platform::uninstall()
}

/// Whether the service is registered, and whether the OS says it's running.
pub fn status() -> (bool, Option<bool>) {
    platform::status()
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn plist_path() -> Result<PathBuf, String> {
        Ok(dirs::home_dir()
            .ok_or("no home folder")?
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")))
    }

    fn domain() -> String {
        // SAFETY: getuid has no preconditions and can't fail.
        let uid = unsafe { libc_getuid() };
        format!("gui/{uid}")
    }

    extern "C" {
        #[link_name = "getuid"]
        fn libc_getuid() -> u32;
    }

    pub fn install(exe: &Path, args: &[String], logs: &Path) -> Result<Vec<String>, String> {
        let mut program = vec![exe.display().to_string()];
        program.extend(args.iter().cloned());
        let items: String = program
            .iter()
            .map(|a| format!("\t\t<string>{}</string>\n", xml_escape(a)))
            .collect();
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
{items}	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>{out}</string>
	<key>StandardErrorPath</key>
	<string>{out}</string>
</dict>
</plist>
"#,
            out = xml_escape(&logs.join("service.log").display().to_string()),
        );
        let path = plist_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Unload an older install first; fine if there isn't one.
        let _ = run("launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
        std::fs::write(&path, plist).map_err(|e| format!("can't write {}: {e}", path.display()))?;
        run("launchctl", &["bootstrap", &domain(), &path.display().to_string()])?;
        Ok(vec![format!("Starts at login (LaunchAgent {LABEL}).")])
    }

    pub fn uninstall() -> Result<(), String> {
        let _ = run("launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
        let path = plist_path()?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn status() -> (bool, Option<bool>) {
        let installed = plist_path().is_ok_and(|p| p.exists());
        let running = run("launchctl", &["print", &format!("{}/{LABEL}", domain())])
            .ok()
            .map(|out| out.contains("state = running"));
        (installed, running.or(Some(false)).filter(|_| installed))
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    fn unit_path() -> Result<PathBuf, String> {
        Ok(dirs::config_dir()
            .ok_or("no config folder")?
            .join("systemd/user")
            .join(UNIT))
    }

    /// systemd's quoting: wrap in double quotes, escape `\`, `"`, `%`, `$`.
    fn quote(arg: &str) -> String {
        let escaped = arg
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$");
        format!("\"{escaped}\"")
    }

    pub fn install(exe: &Path, args: &[String], _logs: &Path) -> Result<Vec<String>, String> {
        let mut cmd = vec![quote(&exe.display().to_string())];
        cmd.extend(args.iter().map(|a| quote(a)));
        let unit = format!(
            "[Unit]\nDescription=LunoPeak node: shares this machine's coding sessions\nAfter=network-online.target\n\n\
             [Service]\nExecStart={}\nRestart=on-failure\nRestartSec=10\n\n\
             [Install]\nWantedBy=default.target\n",
            cmd.join(" ")
        );
        let path = unit_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, unit).map_err(|e| format!("can't write {}: {e}", path.display()))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", UNIT])?;
        run("systemctl", &["--user", "restart", UNIT])?;
        let mut notes = vec![format!("Runs as a systemd user service ({UNIT}). Logs: journalctl --user -u {UNIT}")];
        let user = std::env::var("USER").unwrap_or_default();
        let lingering = run("loginctl", &["show-user", &user, "--property=Linger"])
            .is_ok_and(|o| o.trim() == "Linger=yes");
        if !lingering {
            notes.push(format!(
                "To keep it running while you're logged out (a server), run once: sudo loginctl enable-linger {user}"
            ));
        }
        Ok(notes)
    }

    pub fn uninstall() -> Result<(), String> {
        let _ = run("systemctl", &["--user", "disable", "--now", UNIT]);
        let path = unit_path()?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        let _ = run("systemctl", &["--user", "daemon-reload"]);
        Ok(())
    }

    pub fn status() -> (bool, Option<bool>) {
        let installed = unit_path().is_ok_and(|p| p.exists());
        let running = run("systemctl", &["--user", "is-active", UNIT])
            .map(|o| o.trim() == "active")
            .unwrap_or(false);
        (installed, installed.then_some(running))
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    /// Windows command-line quoting for one argument.
    fn quote(arg: &str) -> String {
        if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
            return arg.to_string();
        }
        format!("\"{}\"", arg.replace('"', "\\\""))
    }

    pub fn install(exe: &Path, args: &[String], _logs: &Path) -> Result<Vec<String>, String> {
        // conhost --headless runs a console program with no window.
        let mut line = vec![quote(&exe.display().to_string())];
        line.extend(args.iter().map(|a| quote(a)));
        let task = format!("conhost.exe --headless {}", line.join(" "));
        let _ = run("schtasks", &["/End", "/TN", TASK]);
        run("schtasks", &["/Create", "/TN", TASK, "/TR", &task, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"])?;
        run("schtasks", &["/Run", "/TN", TASK])?;
        Ok(vec![format!("Starts at sign-in (Task Scheduler: \"{TASK}\").")])
    }

    pub fn uninstall() -> Result<(), String> {
        let _ = run("schtasks", &["/End", "/TN", TASK]);
        if run("schtasks", &["/Query", "/TN", TASK]).is_ok() {
            run("schtasks", &["/Delete", "/TN", TASK, "/F"])?;
        }
        Ok(())
    }

    pub fn status() -> (bool, Option<bool>) {
        match run("schtasks", &["/Query", "/TN", TASK, "/FO", "LIST"]) {
            Ok(out) => (true, Some(out.contains("Running"))),
            Err(_) => (false, None),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod platform {
    use super::*;

    pub fn install(_: &Path, _: &[String], _: &Path) -> Result<Vec<String>, String> {
        Err("install isn't supported on this system; run lunopeak-node from your own service manager".into())
    }
    pub fn uninstall() -> Result<(), String> {
        Ok(())
    }
    pub fn status() -> (bool, Option<bool>) {
        (false, None)
    }
}
