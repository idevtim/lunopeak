//! Cursor web-API usage. Cursor doesn't persist billing state locally — the
//! SQLite scan in `usage::cursor_usage` can surface a per-composer context %
//! and the cached membership type, but the real "plan utilization" lives only
//! on cursor.com. This module reads session cookies from any installed
//! browser (via the `rookie` crate), hits `/api/usage-summary` with the same
//! session the user's logged-in browser tab uses, and returns plan + on-demand
//! spend ready to plug into a `ProviderUsage`.
//!
//! Cookie reading triggers an OS keychain prompt on macOS for Chromium-based
//! browsers (cookies are AES-encrypted with a Keychain-stored key). The
//! `AgentSources::cursor_web` opt-in toggle exists so we don't fire that
//! prompt unprompted — only after the user explicitly enables this source.
//!
//! On macOS only the menu-bar agent reads cookies. The window process is a
//! separate Keychain identity, so letting it read too meant a second prompt
//! for the same secret; it serves the agent's last snapshot from disk instead.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Domains rookie should filter cookies by. Cursor's auth funnel touches
/// multiple hostnames; the session token can live on any of them depending on
/// when the user signed in.
const CURSOR_DOMAINS: &[&str] = &[
    "cursor.com",
    "www.cursor.com",
    "cursor.sh",
    "authenticator.cursor.sh",
];

/// Cookie names that carry a usable Cursor session, in roughly descending
/// preference order. The list spans WorkOS sessions (Cursor's current auth
/// provider) and the older Auth.js / next-auth tokens so logins predating the
/// WorkOS migration still work.
const SESSION_COOKIE_NAMES: &[&str] = &[
    "WorkosCursorSessionToken",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "wos-session",
    "__Secure-wos-session",
    "authjs.session-token",
    "__Secure-authjs.session-token",
];

const SUCCESS_TTL: Duration = Duration::from_secs(15 * 60);
const BACKOFF_TTL: Duration = Duration::from_secs(15 * 60);
/// Oldest agent snapshot the macOS window will still show. The agent refetches
/// every `SUCCESS_TTL`, so anything older means it isn't running.
#[cfg(target_os = "macos")]
const SHARED_MAX_AGE_SECS: i64 = 60 * 60;

/// Parsed view of cursor.com's `/api/usage-summary` response. Only the fields
/// the dashboard surfaces are kept; everything else is dropped at parse time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorWebSnapshot {
    /// Overall plan utilization in percent (0-100), or `None` for unlimited
    /// plans / accounts whose billing block is absent.
    pub plan_pct: Option<f64>,
    /// Cents spent against the plan allowance in the current billing cycle.
    pub plan_used_cents: u64,
    /// Cents spent on on-demand (overage) usage in the current cycle.
    pub on_demand_used_cents: u64,
    /// User-configured spend cap, in cents. `None` for "no limit set".
    pub on_demand_limit_cents: Option<u64>,
    /// Billing-cycle end as Unix seconds. Used as the "resets at" countdown.
    pub billing_cycle_end_unix: Option<i64>,
    /// Membership tier ("pro", "hobby", "team", "enterprise", …). Replaces
    /// the SQLite-derived `stripeMembershipType` value when present.
    pub membership_type: Option<String>,
}

struct CacheEntry {
    fetched_at: Instant,
    value: Option<CursorWebSnapshot>,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// On-disk copy of the last fetch, written by whichever process reads cookies
/// and read by the macOS window process (see the module docs).
#[derive(Serialize, Deserialize)]
struct SharedEntry {
    fetched_unix: i64,
    value: Option<CursorWebSnapshot>,
}

/// Returns the cached snapshot if fresh; otherwise reads cookies, calls
/// cursor.com, and caches the outcome. `None` means either no usable session
/// cookie was found or the API call failed — the caller should fall back to
/// the local SQLite signal in either case.
pub fn fetch() -> Option<CursorWebSnapshot> {
    #[cfg(target_os = "macos")]
    if !crate::is_menubar_agent() {
        return read_shared()
            .filter(|e| Utc::now().timestamp() - e.fetched_unix < SHARED_MAX_AGE_SECS)
            .and_then(|e| e.value);
    }
    if let Ok(guard) = CACHE.lock() {
        if let Some(entry) = guard.as_ref() {
            let ttl = if entry.value.is_some() {
                SUCCESS_TTL
            } else {
                BACKOFF_TTL
            };
            if entry.fetched_at.elapsed() < ttl {
                return entry.value.clone();
            }
        }
    }
    let snapshot = fetch_inner();
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(CacheEntry {
            fetched_at: Instant::now(),
            value: snapshot.clone(),
        });
    }
    write_shared(&SharedEntry {
        fetched_unix: Utc::now().timestamp(),
        value: snapshot.clone(),
    });
    snapshot
}

/// Why the macOS window has no web snapshot to show, when that's because the
/// menu-bar agent (the only cookie reader) hasn't written a fresh one. None
/// elsewhere, and when the agent's last attempt simply found no session.
pub fn missing_snapshot_notice() -> Option<crate::models::UsageNotice> {
    #[cfg(target_os = "macos")]
    if !crate::is_menubar_agent() {
        let fresh = read_shared()
            .is_some_and(|e| Utc::now().timestamp() - e.fetched_unix < SHARED_MAX_AGE_SECS);
        if !fresh {
            return Some(crate::models::UsageNotice {
                kind: "staleSource".into(),
                message: "Plan usage is read by LunoPeak's menu bar, which hasn't reported in over an hour. Showing Cursor's local data until it's running again.".into(),
                retry_at: None,
            });
        }
    }
    None
}

/// Same directory as `usage-cache.json` (Tauri's `app_config_dir()` for our
/// bundle identifier), derived because this module has no `AppHandle`.
fn shared_file() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("com.lunopeak.app")
            .join("cursor-web-cache.json"),
    )
}

#[cfg(target_os = "macos")]
fn read_shared() -> Option<SharedEntry> {
    let raw = std::fs::read_to_string(shared_file()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Write-then-rename so the window never reads a half-written file.
fn write_shared(entry: &SharedEntry) {
    let Some(path) = shared_file() else { return };
    let Ok(raw) = serde_json::to_string(entry) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn fetch_inner() -> Option<CursorWebSnapshot> {
    let cookie_header = build_cookie_header()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("LunoPeak")
        .build()
        .ok()?;
    let resp = match client
        .get("https://cursor.com/api/usage-summary")
        .header("Cookie", &cookie_header)
        .header("Accept", "application/json")
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            crate::elog!(error, "cursor_web", "request failed: {e}");
            return None;
        }
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        crate::elog!(
            error,
            "cursor_web",
            "cursor.com returned {status}: {}",
            body.chars().take(200).collect::<String>()
        );
        return None;
    }
    let body: UsageSummaryResponse = match resp.json() {
        Ok(v) => v,
        Err(e) => {
            crate::elog!(error, "cursor_web", "usage-summary parse failed: {e}");
            return None;
        }
    };
    Some(map_response(body))
}

/// Collects session cookies from every installed browser, keeps only the
/// names we know carry a Cursor session, and joins them into a Cookie header.
/// Returns `None` when no usable cookie is found.
///
/// `rookie::load` is forgiving — each per-browser read is `unwrap_or(vec![])`,
/// so a denied Keychain prompt or a locked browser DB just contributes zero
/// cookies rather than failing the whole call.
fn build_cookie_header() -> Option<String> {
    let domains: Vec<String> = CURSOR_DOMAINS.iter().map(|s| (*s).to_string()).collect();
    let cookies = match rookie::load(Some(domains)) {
        Ok(c) => c,
        Err(e) => {
            crate::elog!(error, "cursor_web", "cookie load failed: {e}");
            return None;
        }
    };

    // De-dupe by name: a user signed in across several browsers may have
    // multiple cookies with the same name but different values. Take the
    // first one we see — every value is a valid session, picking any is
    // fine. (If one is stale, the API will 401 and the cache will retry.)
    let mut chosen: HashMap<&str, String> = HashMap::new();
    for c in &cookies {
        if let Some(&name) = SESSION_COOKIE_NAMES.iter().find(|&&n| n == c.name) {
            chosen.entry(name).or_insert_with(|| c.value.clone());
        }
    }
    if chosen.is_empty() {
        return None;
    }

    let header = chosen
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");
    Some(header)
}

#[derive(Debug, Deserialize)]
struct UsageSummaryResponse {
    billing_cycle_end: Option<String>,
    membership_type: Option<String>,
    individual_usage: Option<IndividualUsage>,
}

#[derive(Debug, Deserialize)]
struct IndividualUsage {
    plan: Option<PlanUsage>,
    on_demand: Option<OnDemandUsage>,
}

#[derive(Debug, Deserialize)]
struct PlanUsage {
    used: Option<u64>,
    limit: Option<u64>,
    total_percent_used: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct OnDemandUsage {
    used: Option<u64>,
    limit: Option<u64>,
}

fn map_response(body: UsageSummaryResponse) -> CursorWebSnapshot {
    let individual = body.individual_usage;
    let plan = individual.as_ref().and_then(|i| i.plan.as_ref());
    let on_demand = individual.as_ref().and_then(|i| i.on_demand.as_ref());

    // Prefer the server-supplied percent. Fall back to `used / limit * 100`
    // when only the cent counts are present (older account shapes).
    let plan_pct = plan.and_then(|p| {
        p.total_percent_used.or_else(|| {
            let used = p.used?;
            let limit = p.limit?;
            if limit == 0 {
                None
            } else {
                Some((used as f64 / limit as f64) * 100.0)
            }
        })
    });

    CursorWebSnapshot {
        plan_pct,
        plan_used_cents: plan.and_then(|p| p.used).unwrap_or(0),
        on_demand_used_cents: on_demand.and_then(|o| o.used).unwrap_or(0),
        on_demand_limit_cents: on_demand.and_then(|o| o.limit),
        billing_cycle_end_unix: body.billing_cycle_end.as_deref().and_then(parse_iso_secs),
        membership_type: body.membership_type,
    }
}

fn parse_iso_secs(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

/// Seconds remaining in the current billing cycle, for use as `window_seconds`
/// in a `UsageWindow`. Falls back to 30 days when the cycle end isn't known.
pub fn window_seconds_for(end_unix: Option<i64>) -> u32 {
    const THIRTY_DAYS: u32 = 30 * 24 * 60 * 60;
    let Some(end) = end_unix else {
        return THIRTY_DAYS;
    };
    let remaining = end - Utc::now().timestamp();
    if remaining <= 0 {
        THIRTY_DAYS
    } else {
        remaining.min(THIRTY_DAYS as i64) as u32
    }
}
