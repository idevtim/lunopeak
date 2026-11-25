//! Direct connections between machines, without a shared folder.
//!
//! A machine that shares (a `lunopeak-node --listen`, later the app itself)
//! serves the same `live.json` / `sessions.json` snapshots a node writes to a
//! shared folder, over TLS, to hubs it has paired with. A hub fetches them
//! into a local cache folder laid out like a shared folder, so
//! [`crate::hub::Hub`] reads and checks them exactly as it does synced files.
//!
//! ## Trust
//!
//! Each machine has a self-signed certificate (made once, kept in its state
//! folder next to `machine-id`). Nothing is trusted until the two machines
//! pair:
//!
//! 1. The sharing machine opens a pairing window ([`open_pairing`]): a
//!    6-digit code, good for 10 minutes and [`PAIR_ATTEMPTS`] tries.
//! 2. The hub runs SPAKE2 with that code over TLS. SPAKE2 means a recorded
//!    exchange gives no way to test guesses offline: each guess costs one
//!    live attempt.
//! 3. Each side proves it derived the same key by MACing the certificate
//!    fingerprint *it* saw. A device in the middle presents its own
//!    certificate, so the fingerprints differ and pairing fails.
//! 4. Both derive a bearer token from the key. The sharing machine keeps only
//!    its hash; the hub keeps the token and pins the certificate.
//!
//! After that every request carries the token over a connection whose
//! certificate must match the pinned fingerprint.
//!
//! ## Wire
//!
//! Minimal HTTP/1.1, one request per connection (`Connection: close`):
//!
//! - `GET  /v1/hello`: id, name, version. No token.
//! - `POST /v1/pair/start`, `POST /v1/pair/finish`: pairing. No token.
//! - `GET  /v1/files/live.json`, `/v1/files/sessions.json`: snapshots, with
//!   `ETag` / `If-None-Match` so an unchanged file costs one round trip.
//! - `DELETE /v1/pair`: the hub unpairs itself.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use hmac::{Hmac, Mac};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring as ring_provider, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity as SpakeId, Password, Spake2};

use crate::node_wire::{self, LIVE_FILE, SESSIONS_FILE};

/// Port a sharing machine listens on unless told otherwise.
pub const DEFAULT_PORT: u16 = 47390;
/// Wrong codes allowed per pairing window before it closes.
pub const PAIR_ATTEMPTS: u32 = 5;
/// How long a pairing window stays open.
pub const PAIR_WINDOW: Duration = Duration::from_secs(10 * 60);

const PAIRING_FILE: &str = "pairing.json";
const PAIRED_HUBS_FILE: &str = "paired-hubs.json";
/// Largest request head or pairing body accepted.
const MAX_HEAD: usize = 16 * 1024;
const MAX_REQUEST_BODY: usize = 4 * 1024;
/// Largest response body a hub accepts (matches the hub's file cap).
const MAX_RESPONSE_BODY: u64 = 64 * 1024 * 1024;
/// Connections served at once; more are dropped.
const MAX_CONNECTIONS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A started pairing must finish within this long.
const PENDING_TTL: Duration = Duration::from_secs(60);

const SPAKE_HUB: &[u8] = b"lunopeak hub";
const SPAKE_SHARER: &[u8] = b"lunopeak sharer";

type HmacSha256 = Hmac<Sha256>;

// ── Identity ────────────────────────────────────────────────────────────

/// This machine's certificate and key, for serving.
pub struct Identity {
    pub machine_id: String,
    cert: CertificateDer<'static>,
    key: Vec<u8>,
    /// Hex SHA-256 of the certificate.
    pub fingerprint: String,
}

/// Load the certificate for `machine_id` from `state_dir`, or make one. Files
/// are named by machine id, so a new id (moved hardware) gets a new key.
pub fn identity(state_dir: &Path, machine_id: &str) -> std::io::Result<Identity> {
    let cert_path = state_dir.join(format!("tls-{machine_id}.crt"));
    let key_path = state_dir.join(format!("tls-{machine_id}.key"));
    let (cert, key) = match (std::fs::read(&cert_path), std::fs::read(&key_path)) {
        (Ok(c), Ok(k)) if !c.is_empty() && !k.is_empty() => (c, k),
        _ => {
            let made = rcgen::generate_simple_self_signed(vec![format!("lunopeak-{machine_id}")])
                .map_err(|e| std::io::Error::other(format!("couldn't make a certificate: {e}")))?;
            let cert = made.cert.der().to_vec();
            let key = made.key_pair.serialize_der();
            std::fs::create_dir_all(state_dir)?;
            write_private(&key_path, &key)?;
            node_wire::replace_file(&cert_path, &cert)?;
            (cert, key)
        }
    };
    Ok(Identity {
        machine_id: machine_id.to_string(),
        fingerprint: fingerprint(&cert),
        cert: CertificateDer::from(cert),
        key,
    })
}

pub fn fingerprint(cert_der: &[u8]) -> String {
    hex(&Sha256::digest(cert_der))
}

/// Write a file only this user can read.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring_provider::default_provider())
}

// ── Pairing window and paired hubs (sharing side) ───────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingWindow {
    code: String,
    expires_ms: i64,
    attempts_left: u32,
}

/// Open a pairing window and return its 6-digit code. Replaces any open one.
pub fn open_pairing(state_dir: &Path) -> std::io::Result<String> {
    let n = u32::from_le_bytes(random_bytes::<4>()) % 1_000_000;
    let code = format!("{n:06}");
    let window = PairingWindow {
        code: code.clone(),
        expires_ms: now_ms() + PAIR_WINDOW.as_millis() as i64,
        attempts_left: PAIR_ATTEMPTS,
    };
    std::fs::create_dir_all(state_dir)?;
    write_private(&state_dir.join(PAIRING_FILE), &serde_json::to_vec(&window)?)?;
    Ok(code)
}

/// Close the pairing window, if one is open.
pub fn close_pairing(state_dir: &Path) {
    let _ = std::fs::remove_file(state_dir.join(PAIRING_FILE));
}

/// Whether a pairing window is open (unexpired, tries left).
pub fn pairing_open(state_dir: &Path) -> bool {
    read_window(state_dir).is_some()
}

fn read_window(state_dir: &Path) -> Option<PairingWindow> {
    let raw = std::fs::read(state_dir.join(PAIRING_FILE)).ok()?;
    let w: PairingWindow = serde_json::from_slice(&raw).ok()?;
    (w.expires_ms > now_ms() && w.attempts_left > 0).then_some(w)
}

/// Use up one try of the open window and return its code.
fn take_attempt(state_dir: &Path) -> Option<String> {
    let mut w = read_window(state_dir)?;
    w.attempts_left -= 1;
    let path = state_dir.join(PAIRING_FILE);
    if w.attempts_left == 0 {
        let _ = std::fs::remove_file(&path);
    } else {
        write_private(&path, &serde_json::to_vec(&w).ok()?).ok()?;
    }
    Some(w.code)
}

/// A hub this machine shares with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedHub {
    pub hub_id: String,
    pub hub_name: String,
    /// Hex SHA-256 of the bearer token; the token itself isn't kept here.
    pub token_sha256: String,
    pub paired_at: i64,
}

pub fn paired_hubs(state_dir: &Path) -> Vec<PairedHub> {
    std::fs::read(state_dir.join(PAIRED_HUBS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_paired_hubs(state_dir: &Path, hubs: &[PairedHub]) -> std::io::Result<()> {
    write_private(&state_dir.join(PAIRED_HUBS_FILE), &serde_json::to_vec_pretty(hubs)?)
}

/// Stop sharing with `hub_id`. Returns whether it was paired.
pub fn unpair_hub(state_dir: &Path, hub_id: &str) -> std::io::Result<bool> {
    let mut hubs = paired_hubs(state_dir);
    let before = hubs.len();
    hubs.retain(|h| h.hub_id != hub_id);
    if hubs.len() == before {
        return Ok(false);
    }
    save_paired_hubs(state_dir, &hubs)?;
    Ok(true)
}

// ── Server ──────────────────────────────────────────────────────────────

pub struct ServeConfig {
    pub bind: SocketAddr,
    /// Holds `machine-id`, the certificate, the pairing window and the paired
    /// hubs.
    pub state_dir: PathBuf,
    /// Folder holding the `live.json` / `sessions.json` to serve, written by
    /// the same publisher that writes a shared folder.
    pub outbox: PathBuf,
    pub name: String,
}

/// A running server. Dropping it doesn't stop it; call [`Server::stop`].
pub struct Server {
    pub addr: SocketAddr,
    pub fingerprint: String,
    stop: Arc<AtomicBool>,
}

impl Server {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop.
        let _ = TcpStream::connect_timeout(&self.addr, Duration::from_millis(200));
    }
}

struct Pending {
    key: Vec<u8>,
    hub_id: String,
    hub_name: String,
    expires: SystemTime,
}

struct ServerState {
    cfg: ServeConfig,
    machine_id: String,
    fingerprint: String,
    tls: Arc<rustls::ServerConfig>,
    pending: Mutex<HashMap<String, Pending>>,
    open: AtomicUsize,
}

/// Start serving on `cfg.bind` in background threads.
pub fn serve(cfg: ServeConfig) -> std::io::Result<Server> {
    let machine_id = node_wire::machine_id(&cfg.state_dir)?;
    let id = identity(&cfg.state_dir, &machine_id)?;
    let tls = rustls::ServerConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(std::io::Error::other)?
        .with_no_client_auth()
        .with_single_cert(
            vec![id.cert.clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key.clone())),
        )
        .map_err(std::io::Error::other)?;
    let listener = TcpListener::bind(cfg.bind)?;
    let addr = listener.local_addr()?;
    let stop = Arc::new(AtomicBool::new(false));
    let state = Arc::new(ServerState {
        cfg,
        machine_id,
        fingerprint: id.fingerprint.clone(),
        tls: Arc::new(tls),
        pending: Mutex::new(HashMap::new()),
        open: AtomicUsize::new(0),
    });
    let stop_flag = stop.clone();
    std::thread::Builder::new()
        .name("lunopeak-share".into())
        .spawn(move || {
            for conn in listener.incoming() {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = conn else { continue };
                if state.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    state.open.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let state = state.clone();
                let _ = std::thread::Builder::new()
                    .name("lunopeak-share-conn".into())
                    .spawn(move || {
                        let _ = handle(&state, stream);
                        state.open.fetch_sub(1, Ordering::SeqCst);
                    });
            }
        })?;
    Ok(Server {
        addr,
        fingerprint: id.fingerprint,
        stop,
    })
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct Response {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

impl Response {
    fn json<T: Serialize>(status: u16, value: &T) -> Self {
        Response {
            status,
            headers: vec![("Content-Type", "application/json".into())],
            body: serde_json::to_vec(value).unwrap_or_default(),
        }
    }

    fn error(status: u16, message: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": message }))
    }
}

fn handle(state: &ServerState, stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    let conn = rustls::ServerConnection::new(state.tls.clone()).map_err(std::io::Error::other)?;
    let mut tls = rustls::StreamOwned::new(conn, stream);
    let resp = match read_request(&mut tls) {
        Ok(req) => route(state, &req),
        Err(_) => Response::error(400, "Bad request"),
    };
    write_response(&mut tls, &resp)?;
    tls.conn.send_close_notify();
    let _ = tls.flush();
    Ok(())
}

fn route(state: &ServerState, req: &Request) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/hello") => Response::json(
            200,
            &Hello {
                machine_id: state.machine_id.clone(),
                name: state.cfg.name.clone(),
                version: crate::VERSION.to_string(),
                schema: node_wire::SCHEMA,
                pairing_open: pairing_open(&state.cfg.state_dir),
            },
        ),
        ("POST", "/v1/pair/start") => pair_start(state, &req.body),
        ("POST", "/v1/pair/finish") => pair_finish(state, &req.body),
        ("DELETE", "/v1/pair") => match authorized(state, req) {
            Some(hub) => match unpair_hub(&state.cfg.state_dir, &hub.hub_id) {
                Ok(_) => Response::json(200, &serde_json::json!({})),
                Err(_) => Response::error(500, "Couldn't save"),
            },
            None => Response::error(401, "Not paired"),
        },
        ("GET", path) if path.starts_with("/v1/files/") => {
            let name = &path["/v1/files/".len()..];
            if name != LIVE_FILE && name != SESSIONS_FILE {
                return Response::error(404, "No such file");
            }
            if authorized(state, req).is_none() {
                return Response::error(401, "Not paired");
            }
            serve_file(&state.cfg.outbox.join(name), req.headers.get("if-none-match"))
        }
        _ => Response::error(404, "Not found"),
    }
}

/// The paired hub whose token the request carries.
fn authorized(state: &ServerState, req: &Request) -> Option<PairedHub> {
    let token = req.headers.get("authorization")?.strip_prefix("Bearer ")?;
    let hash = hex(&Sha256::digest(token.trim().as_bytes()));
    paired_hubs(&state.cfg.state_dir)
        .into_iter()
        .find(|h| constant_eq(h.token_sha256.as_bytes(), hash.as_bytes()))
}

fn serve_file(path: &Path, if_none_match: Option<&String>) -> Response {
    let Ok(meta) = std::fs::metadata(path) else {
        return Response::error(404, "Not published yet");
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let etag = format!("\"{}-{mtime}\"", meta.len());
    if if_none_match.is_some_and(|v| *v == etag) {
        return Response {
            status: 304,
            headers: vec![("ETag", etag)],
            body: Vec::new(),
        };
    }
    match std::fs::read(path) {
        Ok(body) => Response {
            status: 200,
            headers: vec![("Content-Type", "application/json".into()), ("ETag", etag)],
            body,
        },
        Err(_) => Response::error(500, "Couldn't read"),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub machine_id: String,
    pub name: String,
    pub version: String,
    pub schema: u32,
    pub pairing_open: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStart {
    hub_id: String,
    hub_name: String,
    msg: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairStarted {
    pair_id: String,
    msg: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairFinish {
    pair_id: String,
    confirm: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairFinished {
    confirm: String,
    machine_id: String,
    name: String,
}

fn pair_start(state: &ServerState, body: &[u8]) -> Response {
    let Ok(req) = serde_json::from_slice::<PairStart>(body) else {
        return Response::error(400, "Bad request");
    };
    if !node_wire::is_machine_id(&req.hub_id) {
        return Response::error(400, "Bad request");
    }
    let Ok(their_msg) = b64().decode(&req.msg) else {
        return Response::error(400, "Bad request");
    };
    let Some(code) = take_attempt(&state.cfg.state_dir) else {
        return Response::error(
            403,
            "Pairing isn't open on that machine, or it ran out of tries. Start pairing there again.",
        );
    };
    let (spake, msg) = Spake2::<Ed25519Group>::start_b(
        &Password::new(code.as_bytes()),
        &SpakeId::new(SPAKE_HUB),
        &SpakeId::new(SPAKE_SHARER),
    );
    let Ok(key) = spake.finish(&their_msg) else {
        return Response::error(400, "Bad request");
    };
    let pair_id = hex(&random_bytes::<16>());
    let Ok(mut pending) = state.pending.lock() else {
        return Response::error(500, "Busy");
    };
    let now = SystemTime::now();
    pending.retain(|_, p| p.expires > now);
    if pending.len() >= 8 {
        return Response::error(429, "Too many pairings at once");
    }
    pending.insert(
        pair_id.clone(),
        Pending {
            key,
            hub_id: req.hub_id,
            hub_name: node_wire::clean_name(&req.hub_name).unwrap_or_else(|| "Unnamed".into()),
            expires: now + PENDING_TTL,
        },
    );
    Response::json(
        200,
        &PairStarted {
            pair_id,
            msg: b64().encode(msg),
        },
    )
}

fn pair_finish(state: &ServerState, body: &[u8]) -> Response {
    let Ok(req) = serde_json::from_slice::<PairFinish>(body) else {
        return Response::error(400, "Bad request");
    };
    let pending = state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&req.pair_id))
        .filter(|p| p.expires > SystemTime::now());
    let Some(p) = pending else {
        return Response::error(403, "Pairing timed out. Try again.");
    };
    let Ok(confirm) = b64().decode(&req.confirm) else {
        return Response::error(400, "Bad request");
    };
    let mut mac = keyed(&p.key, b"hub-confirm");
    mac.update(state.fingerprint.as_bytes());
    mac.update(p.hub_id.as_bytes());
    if mac.verify_slice(&confirm).is_err() {
        // Wrong code, or a device in the middle with its own certificate.
        return Response::error(403, "Wrong code.");
    }
    let token = token_from(&p.key);
    let mut hubs = paired_hubs(&state.cfg.state_dir);
    hubs.retain(|h| h.hub_id != p.hub_id);
    hubs.push(PairedHub {
        hub_id: p.hub_id.clone(),
        hub_name: p.hub_name,
        token_sha256: hex(&Sha256::digest(token.as_bytes())),
        paired_at: now_ms(),
    });
    if save_paired_hubs(&state.cfg.state_dir, &hubs).is_err() {
        return Response::error(500, "Couldn't save the pairing");
    }
    close_pairing(&state.cfg.state_dir);
    let mut mac = keyed(&p.key, b"sharer-confirm");
    mac.update(state.fingerprint.as_bytes());
    mac.update(p.hub_id.as_bytes());
    Response::json(
        200,
        &PairFinished {
            confirm: b64().encode(mac.finalize().into_bytes()),
            machine_id: state.machine_id.clone(),
            name: state.cfg.name.clone(),
        },
    )
}

fn keyed(key: &[u8], label: &[u8]) -> HmacSha256 {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(label);
    mac
}

fn token_from(key: &[u8]) -> String {
    hex(&keyed(key, b"token").finalize().into_bytes())
}

// ── Client (hub side) ───────────────────────────────────────────────────

/// A machine this hub has paired with.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PairedMachine {
    pub machine_id: String,
    pub name: String,
    /// `host:port` it was reached at.
    pub addr: String,
    /// Pinned certificate fingerprint.
    pub fingerprint: String,
    pub token: String,
    pub paired_at: i64,
}

#[derive(Debug)]
pub enum DirectError {
    /// Couldn't connect, or the connection dropped.
    Unreachable(String),
    /// It answered with a certificate other than the pinned one.
    CertificateChanged,
    /// It no longer knows this hub's token.
    NotPaired,
    /// Anything else it said, in its words.
    Refused(String),
}

impl std::fmt::Display for DirectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DirectError::Unreachable(e) => write!(f, "Can't reach it: {e}"),
            DirectError::CertificateChanged => write!(
                f,
                "It answered with a different certificate. If it was reinstalled, pair it again."
            ),
            DirectError::NotPaired => write!(f, "It no longer shares with this machine. Pair it again."),
            DirectError::Refused(e) => write!(f, "{e}"),
        }
    }
}

/// Pins the certificate fingerprint (or, while pairing, records the one it
/// saw). Signatures are still checked, so the other end must hold the key.
#[derive(Debug)]
struct PinnedCert {
    want: Option<String>,
    seen: Mutex<Option<String>>,
    algs: WebPkiSupportedAlgorithms,
}

impl PinnedCert {
    fn new(want: Option<String>) -> Arc<Self> {
        Arc::new(PinnedCert {
            want,
            seen: Mutex::new(None),
            algs: ring_provider::default_provider().signature_verification_algorithms,
        })
    }
}

impl ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fp.clone());
        }
        match &self.want {
            Some(want) if !constant_eq(want.as_bytes(), fp.as_bytes()) => {
                Err(rustls::Error::General("certificate changed".into()))
            }
            _ => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

/// One request over a fresh TLS connection checked by `verifier`.
fn request(
    addr: &str,
    verifier: &Arc<PinnedCert>,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<Reply, DirectError> {
    let unreachable = |e: &dyn std::fmt::Display| DirectError::Unreachable(e.to_string());
    let sock = addr
        .to_socket_addrs()
        .map_err(|e| unreachable(&e))?
        .next()
        .ok_or_else(|| DirectError::Unreachable(format!("{addr} doesn't resolve")))?;
    let stream = TcpStream::connect_timeout(&sock, CONNECT_TIMEOUT).map_err(|e| unreachable(&e))?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(|e| unreachable(&e))?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(|e| unreachable(&e))?;
    let config = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| unreachable(&e))?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    // The name only fills SNI; the verifier ignores it.
    let name = ServerName::try_from("lunopeak.invalid").expect("static name is valid");
    let conn = rustls::ClientConnection::new(Arc::new(config), name).map_err(|e| unreachable(&e))?;
    let mut tls = rustls::StreamOwned::new(conn, stream);

    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    let sent = tls
        .write_all(head.as_bytes())
        .and_then(|_| tls.write_all(body))
        .and_then(|_| tls.flush());
    if let Err(e) = sent {
        return Err(tls_error(verifier, e));
    }
    let reply = read_reply(&mut tls).map_err(|e| tls_error(verifier, e))?;
    match reply.status {
        401 => Err(DirectError::NotPaired),
        200 | 304 => Ok(reply),
        _ => {
            let msg = serde_json::from_slice::<serde_json::Value>(&reply.body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("It answered {}", reply.status));
            Err(DirectError::Refused(msg))
        }
    }
}

fn tls_error(verifier: &PinnedCert, e: std::io::Error) -> DirectError {
    let changed = verifier.want.is_some()
        && verifier
            .seen
            .lock()
            .ok()
            .and_then(|s| s.clone())
            .is_some_and(|seen| Some(&seen) != verifier.want.as_ref());
    if changed {
        DirectError::CertificateChanged
    } else {
        DirectError::Unreachable(e.to_string())
    }
}

/// Ask a machine at `addr` who it is. Not authenticated: use it to show what
/// will be paired, never to trust it.
pub fn hello(addr: &str) -> Result<Hello, DirectError> {
    let reply = request(addr, &PinnedCert::new(None), "GET", "/v1/hello", &[], &[])?;
    serde_json::from_slice(&reply.body).map_err(|e| DirectError::Refused(e.to_string()))
}

/// Pair with the machine at `addr` using the code it shows.
pub fn pair(addr: &str, code: &str, hub_id: &str, hub_name: &str) -> Result<PairedMachine, DirectError> {
    let code: String = code.chars().filter(char::is_ascii_digit).collect();
    if code.len() != 6 {
        return Err(DirectError::Refused("The code is 6 digits.".into()));
    }
    let verifier = PinnedCert::new(None);
    let (spake, msg) = Spake2::<Ed25519Group>::start_a(
        &Password::new(code.as_bytes()),
        &SpakeId::new(SPAKE_HUB),
        &SpakeId::new(SPAKE_SHARER),
    );
    let start = serde_json::to_vec(&PairStart {
        hub_id: hub_id.to_string(),
        hub_name: hub_name.to_string(),
        msg: b64().encode(msg),
    })
    .unwrap_or_default();
    let reply = request(addr, &verifier, "POST", "/v1/pair/start", &[], &start)?;
    let fp = verifier
        .seen
        .lock()
        .ok()
        .and_then(|s| s.clone())
        .ok_or_else(|| DirectError::Unreachable("no certificate".into()))?;
    let started: PairStarted =
        serde_json::from_slice(&reply.body).map_err(|e| DirectError::Refused(e.to_string()))?;
    let their_msg = b64()
        .decode(&started.msg)
        .map_err(|e| DirectError::Refused(e.to_string()))?;
    let key = spake
        .finish(&their_msg)
        .map_err(|_| DirectError::Refused("It sent a bad pairing message.".into()))?;

    let mut mac = keyed(&key, b"hub-confirm");
    mac.update(fp.as_bytes());
    mac.update(hub_id.as_bytes());
    let finish = serde_json::to_vec(&PairFinish {
        pair_id: started.pair_id,
        confirm: b64().encode(mac.finalize().into_bytes()),
    })
    .unwrap_or_default();
    // Same certificate as the first request, or someone swapped in between.
    let pinned = PinnedCert::new(Some(fp.clone()));
    let reply = request(addr, &pinned, "POST", "/v1/pair/finish", &[], &finish)?;
    let finished: PairFinished =
        serde_json::from_slice(&reply.body).map_err(|e| DirectError::Refused(e.to_string()))?;
    let confirm = b64()
        .decode(&finished.confirm)
        .map_err(|e| DirectError::Refused(e.to_string()))?;
    let mut mac = keyed(&key, b"sharer-confirm");
    mac.update(fp.as_bytes());
    mac.update(hub_id.as_bytes());
    if mac.verify_slice(&confirm).is_err() {
        return Err(DirectError::Refused(
            "That machine couldn't prove it knows the code.".into(),
        ));
    }
    if !node_wire::is_machine_id(&finished.machine_id) {
        return Err(DirectError::Refused("It sent a bad machine id.".into()));
    }
    Ok(PairedMachine {
        machine_id: finished.machine_id,
        name: node_wire::clean_name(&finished.name).unwrap_or_else(|| "Unnamed machine".into()),
        addr: addr.to_string(),
        fingerprint: fp,
        token: token_from(&key),
        paired_at: now_ms(),
    })
}

/// Tell `machine` to forget this hub. Best effort: it may be off.
pub fn unpair(machine: &PairedMachine) -> Result<(), DirectError> {
    let auth = format!("Bearer {}", machine.token);
    request(
        &machine.addr,
        &PinnedCert::new(Some(machine.fingerprint.clone())),
        "DELETE",
        "/v1/pair",
        &[("Authorization", &auth)],
        &[],
    )
    .map(|_| ())
}

/// Bring `cache_root/nodes/<id>/` up to date with what `machine` serves,
/// writing a file only when it changed. `etags` remembers what was fetched,
/// per file, across calls.
pub fn sync(
    machine: &PairedMachine,
    cache_root: &Path,
    etags: &mut HashMap<String, String>,
) -> Result<(), DirectError> {
    if !node_wire::is_machine_id(&machine.machine_id) {
        return Err(DirectError::Refused("Bad machine id".into()));
    }
    let dir = cache_root.join(node_wire::NODES_DIR).join(&machine.machine_id);
    let verifier = PinnedCert::new(Some(machine.fingerprint.clone()));
    let auth = format!("Bearer {}", machine.token);
    for file in [LIVE_FILE, SESSIONS_FILE] {
        let key = format!("{}/{file}", machine.machine_id);
        let path = dir.join(file);
        // Only trust the etag while the cached copy is still there.
        let etag = etags.get(&key).filter(|_| path.exists()).cloned();
        let mut headers = vec![("Authorization", auth.as_str())];
        if let Some(e) = etag.as_deref() {
            headers.push(("If-None-Match", e));
        }
        let reply = match request(&machine.addr, &verifier, "GET", &format!("/v1/files/{file}"), &headers, &[]) {
            Ok(r) => r,
            // Not published yet (sessions are scanned after live data).
            Err(DirectError::Refused(_)) => continue,
            Err(e) => return Err(e),
        };
        if reply.status == 304 {
            continue;
        }
        std::fs::create_dir_all(&dir).map_err(|e| DirectError::Unreachable(e.to_string()))?;
        node_wire::replace_file(&path, &reply.body).map_err(|e| DirectError::Unreachable(e.to_string()))?;
        if let Some(tag) = reply.headers.get("etag") {
            etags.insert(key, tag.clone());
        }
    }
    Ok(())
}

// ── Paired machines (hub side) ──────────────────────────────────────────

const PAIRED_MACHINES_FILE: &str = "paired-machines.json";
/// Folder under the hub's app dir that direct fetches land in, laid out like
/// a shared folder (`nodes/<machine id>/`).
pub const CACHE_DIR: &str = "remote-cache";

/// Machines this hub has paired with. Holds their tokens, so it lives in its
/// own owner-only file rather than in settings.json.
pub fn paired_machines(app_dir: &Path) -> Vec<PairedMachine> {
    std::fs::read(app_dir.join(PAIRED_MACHINES_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Vec<PairedMachine>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|m| node_wire::is_machine_id(&m.machine_id))
        .collect()
}

pub fn save_paired_machines(app_dir: &Path, machines: &[PairedMachine]) -> std::io::Result<()> {
    std::fs::create_dir_all(app_dir)?;
    write_private(
        &app_dir.join(PAIRED_MACHINES_FILE),
        &serde_json::to_vec_pretty(machines)?,
    )
}

/// `host`, `host:port`, `ip`, `ip:port`, `[v6]` or `[v6]:port`, with
/// [`DEFAULT_PORT`] filled in. `None` when it can't be an address.
pub fn normalize_addr(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let s = s.strip_prefix("https://").unwrap_or(s);
    if s.is_empty() || s.contains(char::is_whitespace) || s.contains('/') {
        return None;
    }
    if s.parse::<SocketAddr>().is_ok() {
        return Some(s.to_string());
    }
    if let Ok(ip) = s.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        return Some(SocketAddr::new(ip, DEFAULT_PORT).to_string());
    }
    // A host name, maybe with a port.
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()?),
        None => (s, DEFAULT_PORT),
    };
    let ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_');
    ok.then(|| format!("{host}:{port}"))
}

// ── HTTP plumbing ───────────────────────────────────────────────────────

/// Read a request head and body, refusing anything oversized.
fn read_request(stream: &mut impl Read) -> std::io::Result<Request> {
    let mut reader = BufReader::new(stream.take((MAX_HEAD + MAX_REQUEST_BODY) as u64));
    let (first, headers) = read_head(&mut reader)?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_REQUEST_BODY {
        return Err(std::io::Error::other("body too large"));
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

fn read_reply(stream: &mut impl Read) -> std::io::Result<Reply> {
    let mut reader = BufReader::new(stream.take(MAX_HEAD as u64 + MAX_RESPONSE_BODY));
    let (first, headers) = read_head(&mut reader)?;
    let status: u16 = first
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::other("bad status line"))?;
    let len: Option<u64> = headers.get("content-length").and_then(|v| v.parse().ok());
    let mut body = Vec::new();
    match len {
        Some(n) if n > MAX_RESPONSE_BODY => return Err(std::io::Error::other("reply too large")),
        Some(n) => {
            body.resize(n as usize, 0);
            reader.read_exact(&mut body)?;
        }
        None => {
            reader.read_to_end(&mut body)?;
        }
    }
    Ok(Reply {
        status,
        headers,
        body,
    })
}

/// The first line and the headers (names lowercased).
fn read_head(reader: &mut impl BufRead) -> std::io::Result<(String, HashMap<String, String>)> {
    let mut total = 0;
    let mut line = String::new();
    let mut next = |line: &mut String| -> std::io::Result<()> {
        line.clear();
        let n = reader.read_line(line)?;
        total += n;
        if n == 0 || total > MAX_HEAD {
            return Err(std::io::Error::other("bad head"));
        }
        Ok(())
    };
    next(&mut line)?;
    let first = line.trim_end().to_string();
    let mut headers = HashMap::new();
    loop {
        next(&mut line)?;
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Ok((first, headers))
}

fn write_response(stream: &mut impl Write, resp: &Response) -> std::io::Result<()> {
    let reason = match resp.status {
        200 => "OK",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let mut head = format!(
        "HTTP/1.1 {} {reason}\r\nConnection: close\r\nContent-Length: {}\r\n",
        resp.status,
        resp.body.len()
    );
    for (k, v) in &resp.headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&resp.body)?;
    stream.flush()
}

// ── Small helpers ───────────────────────────────────────────────────────

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let mut filled = 0;
    while filled < N {
        // v4 UUIDs are 122 random bits from the OS generator.
        let chunk = *uuid::Uuid::new_v4().as_bytes();
        let n = (N - filled).min(8);
        out[filled..filled + n].copy_from_slice(&chunk[..n]);
        filled += n;
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sharer {
        server: Server,
        state: tempfile::TempDir,
        outbox: tempfile::TempDir,
    }

    fn sharer() -> Sharer {
        let state = tempfile::tempdir().unwrap();
        let outbox = tempfile::tempdir().unwrap();
        std::fs::write(outbox.path().join(LIVE_FILE), br#"{"live":1}"#).unwrap();
        std::fs::write(outbox.path().join(SESSIONS_FILE), br#"{"sessions":1}"#).unwrap();
        let server = serve(ServeConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            state_dir: state.path().to_path_buf(),
            outbox: outbox.path().to_path_buf(),
            name: "Build box".into(),
        })
        .unwrap();
        Sharer { server, state, outbox }
    }

    const HUB: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn pairs_with_the_code_then_syncs_only_what_changed() {
        let s = sharer();
        let addr = s.server.addr.to_string();
        assert!(!hello(&addr).unwrap().pairing_open);
        let code = open_pairing(s.state.path()).unwrap();
        assert!(hello(&addr).unwrap().pairing_open);

        let m = pair(&addr, &code, HUB, "My Mac").unwrap();
        assert_eq!(m.name, "Build box");
        assert_eq!(m.fingerprint, s.server.fingerprint);
        assert!(!pairing_open(s.state.path()), "a used code closes the window");
        let hubs = paired_hubs(s.state.path());
        assert_eq!(hubs.len(), 1);
        assert_eq!(hubs[0].hub_name, "My Mac");
        assert_ne!(hubs[0].token_sha256, m.token, "only the hash is kept");

        let cache = tempfile::tempdir().unwrap();
        let mut etags = HashMap::new();
        sync(&m, cache.path(), &mut etags).unwrap();
        let live = cache.path().join("nodes").join(&m.machine_id).join(LIVE_FILE);
        assert_eq!(std::fs::read(&live).unwrap(), br#"{"live":1}"#);
        let before = std::fs::metadata(&live).unwrap().modified().unwrap();

        // Unchanged: not rewritten.
        std::thread::sleep(Duration::from_millis(20));
        sync(&m, cache.path(), &mut etags).unwrap();
        assert_eq!(std::fs::metadata(&live).unwrap().modified().unwrap(), before);

        // Changed: fetched again.
        std::fs::write(s.outbox.path().join(LIVE_FILE), br#"{"live":2}"#).unwrap();
        sync(&m, cache.path(), &mut etags).unwrap();
        assert_eq!(std::fs::read(&live).unwrap(), br#"{"live":2}"#);

        unpair(&m).unwrap();
        assert!(matches!(sync(&m, cache.path(), &mut HashMap::new()), Err(DirectError::NotPaired)));
        s.server.stop();
    }

    #[test]
    fn wrong_codes_fail_and_use_up_the_window() {
        let s = sharer();
        let addr = s.server.addr.to_string();
        let code = open_pairing(s.state.path()).unwrap();
        let wrong = if code == "000000" { "111111" } else { "000000" };
        for _ in 0..PAIR_ATTEMPTS {
            assert!(pair(&addr, wrong, HUB, "Mallory").is_err());
        }
        // Out of tries: even the right code is refused now.
        let err = pair(&addr, &code, HUB, "Me").unwrap_err();
        assert!(err.to_string().contains("isn't open"), "{err}");
        assert!(paired_hubs(s.state.path()).is_empty());
        s.server.stop();
    }

    #[test]
    fn files_need_a_token_and_the_pinned_certificate() {
        let s = sharer();
        let addr = s.server.addr.to_string();
        let code = open_pairing(s.state.path()).unwrap();
        let m = pair(&addr, &code, HUB, "Me").unwrap();
        let cache = tempfile::tempdir().unwrap();

        let forged = PairedMachine {
            token: "f".repeat(64),
            ..m.clone()
        };
        assert!(matches!(sync(&forged, cache.path(), &mut HashMap::new()), Err(DirectError::NotPaired)));

        let other_cert = PairedMachine {
            fingerprint: "0".repeat(64),
            ..m.clone()
        };
        assert!(matches!(
            sync(&other_cert, cache.path(), &mut HashMap::new()),
            Err(DirectError::CertificateChanged)
        ));

        // Only the two snapshot files are served.
        let reply = request(
            &addr,
            &PinnedCert::new(Some(m.fingerprint.clone())),
            "GET",
            "/v1/files/..%2Fpaired-hubs.json",
            &[("Authorization", &format!("Bearer {}", m.token))],
            &[],
        );
        assert!(reply.is_err());
        s.server.stop();
    }

    #[test]
    fn normalizes_addresses() {
        assert_eq!(normalize_addr("192.168.1.5").as_deref(), Some("192.168.1.5:47390"));
        assert_eq!(normalize_addr(" 10.0.0.2:9000 ").as_deref(), Some("10.0.0.2:9000"));
        assert_eq!(normalize_addr("build-box.local").as_deref(), Some("build-box.local:47390"));
        assert_eq!(normalize_addr("box.tail1234.ts.net:8000").as_deref(), Some("box.tail1234.ts.net:8000"));
        assert_eq!(normalize_addr("fe80::1").as_deref(), Some("[fe80::1]:47390"));
        assert_eq!(normalize_addr("[::1]:9").as_deref(), Some("[::1]:9"));
        assert_eq!(normalize_addr("bad host"), None);
        assert_eq!(normalize_addr("host:port"), None);
        assert_eq!(normalize_addr(""), None);
    }

    #[test]
    fn identity_is_stable_per_machine_id() {
        let dir = tempfile::tempdir().unwrap();
        let a = identity(dir.path(), HUB).unwrap();
        let again = identity(dir.path(), HUB).unwrap();
        assert_eq!(a.fingerprint, again.fingerprint);
        let other = identity(dir.path(), &"f".repeat(32)).unwrap();
        assert_ne!(a.fingerprint, other.fingerprint);
    }
}
