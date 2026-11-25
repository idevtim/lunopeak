//! Codex plan utilization from ChatGPT's backend. Codex 0.163 stopped
//! leaving its `codex.rate_limits` payloads in `logs_2.sqlite` (only the
//! event name is logged now), and rollouts only carry a `rate_limits` block
//! for turns that ran locally — so between sessions there's no local copy of
//! the live numbers. This asks the same endpoint the Codex CLI reads for its
//! `/status` view, with the ChatGPT sign-in Codex already keeps in
//! `~/.codex/auth.json`.
//!
//! The token is only ever read, never refreshed: refresh tokens rotate, and
//! spending one here would sign the user's Codex out. When the access token
//! has lapsed (Codex refreshes it on its next run) the call 401s, we back
//! off, and `usage::codex_usage` falls back to the local sources.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

const SUCCESS_TTL: Duration = Duration::from_secs(3 * 60);
/// Signed out, token lapsed, or rate-limited — nothing changes until Codex
/// runs again, so don't keep knocking.
const BACKOFF_TTL: Duration = Duration::from_secs(15 * 60);
/// Network blip or a 5xx — worth another try on a later tick.
const TRANSIENT_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
pub struct CodexWebSnapshot {
    pub plan_type: Option<String>,
    pub primary: Option<CodexWindow>,
    pub secondary: Option<CodexWindow>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CodexWindow {
    pub used_percent: f64,
    pub window_seconds: Option<u32>,
    /// Unix seconds.
    pub resets_at: Option<i64>,
}

struct CacheEntry {
    fetched_at: Instant,
    ttl: Duration,
    value: Option<CodexWebSnapshot>,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// Cached for `SUCCESS_TTL`; `None` when signed out of ChatGPT in Codex
/// (API-key users have no plan limits) or when the call fails.
pub fn fetch() -> Option<CodexWebSnapshot> {
    if let Ok(guard) = CACHE.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < entry.ttl {
                return entry.value.clone();
            }
        }
    }
    let (value, ttl) = match fetch_inner() {
        Ok(snap) => (Some(snap), SUCCESS_TTL),
        Err(ttl) => (None, ttl),
    };
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(CacheEntry {
            fetched_at: Instant::now(),
            ttl,
            value: value.clone(),
        });
    }
    value
}

/// `Err` carries how long to wait before asking again.
fn fetch_inner() -> Result<CodexWebSnapshot, Duration> {
    let auth = read_auth().ok_or(BACKOFF_TTL)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("LunoPeak")
        .build()
        .map_err(|_| TRANSIENT_TTL)?;
    let mut req = client
        .get(USAGE_URL)
        .bearer_auth(&auth.access_token)
        .header("Accept", "application/json");
    if let Some(account) = &auth.account_id {
        req = req.header("ChatGPT-Account-Id", account);
    }
    let resp = req.send().map_err(|e| {
        crate::elog!(error, "codex_web", "request failed: {e}");
        TRANSIENT_TTL
    })?;
    let status = resp.status();
    if !status.is_success() {
        crate::elog!(error, "codex_web", "wham/usage returned {status}");
        return Err(if status.is_server_error() {
            TRANSIENT_TTL
        } else {
            BACKOFF_TTL
        });
    }
    let body: UsageResponse = resp.json().map_err(|e| {
        crate::elog!(error, "codex_web", "wham/usage parse failed: {e}");
        BACKOFF_TTL
    })?;
    Ok(map_response(body))
}

struct Auth {
    access_token: String,
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct AuthFile {
    tokens: Option<AuthTokens>,
}

#[derive(Deserialize)]
struct AuthTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

fn read_auth() -> Option<Auth> {
    let path = dirs::home_dir()?.join(".codex").join("auth.json");
    parse_auth(&std::fs::read_to_string(path).ok()?)
}

/// Only a ChatGPT sign-in has plan limits; an API-key-only file has no
/// `tokens` block and yields `None`.
fn parse_auth(raw: &str) -> Option<Auth> {
    let tokens = serde_json::from_str::<AuthFile>(raw).ok()?.tokens?;
    let access_token = tokens.access_token.filter(|t| !t.is_empty())?;
    Some(Auth {
        access_token,
        account_id: tokens.account_id.filter(|a| !a.is_empty()),
    })
}

#[derive(Debug, Deserialize)]
struct UsageResponse {
    plan_type: Option<String>,
    rate_limit: Option<RateLimit>,
}

#[derive(Debug, Deserialize)]
struct RateLimit {
    primary_window: Option<WindowSnapshot>,
    secondary_window: Option<WindowSnapshot>,
}

#[derive(Debug, Deserialize)]
struct WindowSnapshot {
    used_percent: f64,
    limit_window_seconds: Option<u32>,
    reset_after_seconds: Option<i64>,
    reset_at: Option<i64>,
}

fn map_response(body: UsageResponse) -> CodexWebSnapshot {
    let now = chrono::Utc::now().timestamp();
    let window = |w: WindowSnapshot| CodexWindow {
        used_percent: w.used_percent,
        window_seconds: w.limit_window_seconds,
        resets_at: w.reset_at.or(w.reset_after_seconds.map(|s| now + s)),
    };
    let (primary, secondary) = match body.rate_limit {
        Some(r) => (r.primary_window.map(window), r.secondary_window.map(window)),
        None => (None, None),
    };
    CodexWebSnapshot {
        plan_type: body.plan_type,
        primary,
        secondary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chatgpt_sign_in() {
        let a = parse_auth(
            r#"{"OPENAI_API_KEY":null,"tokens":{"id_token":"i","access_token":"tok","refresh_token":"r","account_id":"acct"},"last_refresh":"2026-10-12T23:10:00Z"}"#,
        )
        .unwrap();
        assert_eq!(a.access_token, "tok");
        assert_eq!(a.account_id.as_deref(), Some("acct"));
    }

    #[test]
    fn api_key_sign_in_has_no_plan_limits() {
        assert!(parse_auth(r#"{"OPENAI_API_KEY":"sk-test","tokens":null}"#).is_none());
        assert!(parse_auth(r#"{"OPENAI_API_KEY":"sk-test"}"#).is_none());
    }

    #[test]
    fn maps_both_windows() {
        let body: UsageResponse = serde_json::from_str(
            r#"{"plan_type":"plus","rate_limit":{"allowed":true,"limit_reached":false,
                "primary_window":{"used_percent":12,"limit_window_seconds":18000,"reset_after_seconds":600,"reset_at":1792170000},
                "secondary_window":{"used_percent":4.5,"limit_window_seconds":604800,"reset_after_seconds":86400}},
                "credits":{"has_credits":false,"unlimited":false,"balance":"0"}}"#,
        )
        .unwrap();
        let s = map_response(body);
        assert_eq!(s.plan_type.as_deref(), Some("plus"));
        let p = s.primary.unwrap();
        assert_eq!(p.used_percent, 12.0);
        assert_eq!(p.window_seconds, Some(18_000));
        assert_eq!(p.resets_at, Some(1_792_170_000));
        // No absolute reset — derived from the relative one.
        let w = s.secondary.unwrap();
        assert!(w.resets_at.unwrap() > chrono::Utc::now().timestamp());
    }

    #[test]
    fn missing_rate_limit_block_is_empty_not_an_error() {
        let body: UsageResponse = serde_json::from_str(r#"{"plan_type":"free"}"#).unwrap();
        let s = map_response(body);
        assert!(s.primary.is_none() && s.secondary.is_none());
    }
}
