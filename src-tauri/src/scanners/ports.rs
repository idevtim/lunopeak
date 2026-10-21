use crate::models::ListeningPort;
#[cfg(not(target_os = "windows"))]
use std::process::Command;
#[cfg(not(target_os = "windows"))]
use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

/// Scan listening TCP ports. Uses `lsof` on macOS/Linux. Returns an empty
/// list on Windows for now (netstat parsing lands later).
pub fn scan() -> Vec<ListeningPort> {
    #[cfg(target_os = "windows")]
    {
        return Vec::new();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("lsof")
            .args(["-nP", "+c0", "-iTCP", "-sTCP:LISTEN"])
            .output();
        let Ok(out) = output else { return Vec::new() };
        if !out.status.success() {
            return Vec::new();
        }
        let raw = String::from_utf8_lossy(&out.stdout);
        let mut ports = parse_lsof(&raw);

        // Enrich with cwd from sysinfo
        let mut sys = System::new_with_specifics(
            RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
        );
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::everything(),
        );
        for port in &mut ports {
            if let Some(proc_) = sys.process(Pid::from_u32(port.pid)) {
                if let Some(cwd) = proc_.cwd() {
                    port.cwd = Some(cwd.to_string_lossy().into_owned());
                }
            }
        }

        ports.sort_by_key(|p| p.port);
        ports.dedup_by(|a, b| a.pid == b.pid && a.port == b.port);
        ports
    }
}

#[cfg(not(target_os = "windows"))]
fn parse_lsof(raw: &str) -> Vec<ListeningPort> {
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        if i == 0 {
            continue; // header
        }
        // Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        let mut parts = line.split_whitespace();
        let Some(command) = parts.next() else {
            continue;
        };
        let Some(pid_s) = parts.next() else { continue };
        let Ok(pid) = pid_s.parse::<u32>() else {
            continue;
        };
        // Skip USER FD TYPE DEVICE SIZE/OFF NODE
        for _ in 0..6 {
            if parts.next().is_none() {
                break;
            }
        }
        let Some(name) = parts.next() else { continue };
        // name looks like *:3000 or 127.0.0.1:5173 or [::1]:8080
        let (address, port_part) = match name.rfind(':') {
            Some(idx) => (&name[..idx], &name[idx + 1..]),
            None => continue,
        };
        let Ok(port) = port_part.parse::<u16>() else {
            continue;
        };
        out.push(ListeningPort {
            pid,
            port,
            address: address.trim_matches(|c| c == '[' || c == ']').to_string(),
            process: unescape_lsof(command),
            cwd: None,
        });
    }
    out
}

/// `lsof` encodes non-printable bytes (including spaces) in the COMMAND column
/// as `\xNN`. Decode them so callers see "Code Helper" instead of "Code\x20H".
#[cfg(not(target_os = "windows"))]
fn unescape_lsof(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1] == b'x' {
            let hi = (bytes[i + 2] as char).to_digit(16);
            let lo = (bytes[i + 3] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push(((hi << 4) | lo) as u8 as char);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}
