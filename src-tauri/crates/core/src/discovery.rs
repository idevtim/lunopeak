//! Finding sharing machines on the local network with mDNS (Bonjour).
//!
//! A machine that listens on all interfaces advertises `_lunopeak._tcp` with
//! its machine id and name in the TXT record. A hub browses for it and lists
//! what it finds in Settings, so pairing starts from a pick instead of a
//! typed address. An advertisement is only a hint: nothing here is trusted
//! until pairing pins the machine's certificate.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;

use crate::node_wire;

pub const SERVICE: &str = "_lunopeak._tcp.local.";

/// Keeps a machine advertised until dropped.
pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// This machine's addresses another computer could use to reach it, most
/// likely first (the same ranking discovery uses).
pub fn local_addresses() -> Vec<IpAddr> {
    let addrs = if_addrs::get_if_addrs().unwrap_or_default();
    rank_addresses(addrs.into_iter().map(|i| i.ip()))
}

/// Advertise this machine on `port` under every local address.
pub fn advertise(machine_id: &str, name: &str, port: u16) -> Result<Advertiser, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let host = format!("lunopeak-{}.local.", &machine_id[..12.min(machine_id.len())]);
    let props = [
        ("id", machine_id),
        ("name", name),
        ("v", crate::VERSION),
    ];
    // The instance name must be unique on the network; the id is.
    let info = ServiceInfo::new(SERVICE, machine_id, &host, "", port, &props[..])
        .map_err(|e| e.to_string())?
        .enable_addr_auto();
    let fullname = info.get_fullname().to_string();
    daemon.register(info).map_err(|e| e.to_string())?;
    Ok(Advertiser { daemon, fullname })
}

/// A machine seen on the network.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    pub machine_id: String,
    pub name: String,
    /// `ip:port` to try, most likely first. A machine with a VM or container
    /// network has addresses other computers can't reach, so the app tries
    /// them in turn.
    pub addrs: Vec<String>,
    pub version: Option<String>,
}

/// Browses in the background and keeps what it has seen, until dropped.
pub struct Browser {
    daemon: ServiceDaemon,
    seen: Arc<Mutex<HashMap<String, Discovered>>>,
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.daemon.stop_browse(SERVICE);
        let _ = self.daemon.shutdown();
    }
}

impl Browser {
    pub fn start() -> Result<Self, String> {
        let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
        let rx = daemon.browse(SERVICE).map_err(|e| e.to_string())?;
        let seen: Arc<Mutex<HashMap<String, Discovered>>> = Arc::default();
        let sink = seen.clone();
        std::thread::Builder::new()
            .name("lunopeak-discovery".into())
            .spawn(move || {
                // Ends when the daemon shuts down and drops the sender.
                while let Ok(event) = rx.recv() {
                    let Ok(mut seen) = sink.lock() else { break };
                    match event {
                        ServiceEvent::ServiceResolved(info) => {
                            if let Some(d) = from_info(&info) {
                                seen.insert(info.get_fullname().to_string(), d);
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            seen.remove(&fullname);
                        }
                        _ => {}
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Browser { daemon, seen })
    }

    /// Machines currently advertised, by name.
    pub fn machines(&self) -> Vec<Discovered> {
        let mut out: Vec<Discovered> = self
            .seen
            .lock()
            .map(|s| s.values().cloned().collect())
            .unwrap_or_default();
        out.sort_by_key(|d| (d.name.to_lowercase(), d.machine_id.clone()));
        out.dedup_by(|a, b| a.machine_id == b.machine_id);
        out
    }
}

fn from_info(info: &ServiceInfo) -> Option<Discovered> {
    let id = info.get_property_val_str("id")?.to_string();
    if !node_wire::is_machine_id(&id) {
        return None;
    }
    let port = info.get_port();
    let addrs: Vec<String> = rank_addresses(info.get_addresses().iter().copied())
        .into_iter()
        .map(|ip| match ip {
            IpAddr::V4(v4) => format!("{v4}:{port}"),
            IpAddr::V6(v6) => format!("[{v6}]:{port}"),
        })
        .collect();
    if addrs.is_empty() {
        return None;
    }
    Some(Discovered {
        name: info
            .get_property_val_str("name")
            .and_then(node_wire::clean_name)
            .unwrap_or_else(|| "Unnamed machine".into()),
        machine_id: id,
        addrs,
        version: info.get_property_val_str("v").map(str::to_string),
    })
}

/// Usable addresses, most likely reachable first: home networks
/// (192.168/16), then other private ranges (10/8, then 172.16/12, where
/// Docker and VM adapters usually live), then any other IPv4, then global
/// IPv6. Loopback and link-local addresses are dropped.
pub fn rank_addresses(addrs: impl Iterator<Item = IpAddr>) -> Vec<IpAddr> {
    let rank = |a: &IpAddr| -> Option<u8> {
        if a.is_loopback() || a.is_unspecified() {
            return None;
        }
        match a {
            IpAddr::V4(v4) if v4.is_link_local() => None,
            IpAddr::V4(v4) if v4.octets()[..2] == [192, 168] => Some(0),
            IpAddr::V4(v4) if v4.octets()[0] == 10 => Some(1),
            IpAddr::V4(v4) if v4.is_private() => Some(2),
            IpAddr::V4(_) => Some(3),
            IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => None,
            IpAddr::V6(_) => Some(4),
        }
    };
    let mut ranked: Vec<(u8, IpAddr)> = addrs.filter_map(|a| Some((rank(&a)?, a))).collect();
    ranked.sort();
    ranked.dedup();
    ranked.into_iter().map(|(_, a)| a).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_home_networks_first_and_drops_unusable() {
        let a = |s: &str| s.parse::<IpAddr>().unwrap();
        let got = rank_addresses(
            [a("fe80::1"), a("2001:db8::5"), a("172.17.0.1"), a("10.37.129.2"), a("192.168.1.9"), a("127.0.0.1")]
                .into_iter(),
        );
        assert_eq!(got, [a("192.168.1.9"), a("10.37.129.2"), a("172.17.0.1"), a("2001:db8::5")]);
        assert!(rank_addresses([a("fe80::1"), a("169.254.0.3")].into_iter()).is_empty());
    }

    /// Advertise a fake machine and find it again over real mDNS:
    /// `cargo test -p lunopeak-core discovery_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn discovery_live() {
        let id = "feedfacefeedfacefeedfacefeedface";
        let _ad = advertise(id, "Discovery test", 47399).unwrap();
        let browser = Browser::start().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        loop {
            let all = browser.machines();
            if let Some(d) = all.iter().find(|d| d.machine_id == id) {
                println!("found {d:?} (and {} others)", all.len() - 1);
                break;
            }
            assert!(std::time::Instant::now() < deadline, "not found; saw {all:?}");
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
}
