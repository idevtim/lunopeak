//! Rolling-window usage for Claude Code and Codex, used by the Dashboard's
//! "Rate limits" card.
//!
//! - **Claude**: no rate-limit metadata is persisted to disk, so we compute
//!   actual token + cost spend in the trailing 5h / 7d windows by walking
//!   message timestamps in ~/.claude/projects/**/*.jsonl. We skip files
//!   whose mtime is older than 7 days — they cannot contribute.
//! - **Codex**: live primary (5h) and secondary (weekly) `used_percent` +
//!   reset from ChatGPT's backend (`codex_web`), falling back to the last
//!   `rate_limits` block Codex wrote locally — `logs_2.sqlite` on older
//!   builds, else the most recent rollout.

use crate::models::{
    AgentSources, ModelLimit, ProviderUsage, UsageLimits, UsageNotice, UsageWindow,
};
use crate::pricing;
use crate::scanners::codex_web::{self, CodexWindow};
use crate::scanners::cursor_web;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const FIVE_HOURS_MS: i64 = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// `force` bypasses the in-process remote cache for an explicit user-driven
/// refresh (the "retry" button), so a transient failure — a network blip while
/// offline, a parse hiccup — doesn't lock the % bar behind the backoff window
/// until the next poll. Background callers (tray tick, dashboard poll) pass
/// `false` and ride the cache. A genuine 429 is still honored even under
/// `force` — see `claude_remote_usage`.
pub fn collect(agents: &AgentSources, force: bool) -> UsageLimits {
    // Demo mode: skip the live OAuth + JSONL scans entirely so screenshot
    // builds don't hit Anthropic's API and don't leak the real user's
    // session counts. Mirrors the frontend's `VITE_DEMO_MODE` switch in
    // `src/lib/tauri.ts` — the tray refreshes on its own clock, so it
    // needs an independent gate.
    if std::env::var("LUNOPEAK_DEMO").ok().as_deref() == Some("1") {
        return demo_usage_limits();
    }
    let mut providers = Vec::new();
    // Each provider is gated on its own toggle *before* any request, so turning
    // an agent off stops its sign-in leaving the machine — not just hides the
    // row. The privacy page promises exactly this.
    if agents.claude_code {
        if let Some(p) = claude_usage(force) {
            providers.push(p);
        }
    }
    if let Some(p) = codex_usage(agents.codex) {
        providers.push(p);
    }
    // `cursor_web` is gated separately from `cursor` because the cookie read
    // triggers an OS Keychain prompt on macOS Chromium browsers — we don't
    // want that firing unprompted just because Cursor is installed. It also
    // requires `cursor` itself: the Settings switch greys out when Cursor is
    // off but keeps its stored value, so honor both here.
    if let Some(p) = cursor_usage(agents.cursor && agents.cursor_web) {
        providers.push(p);
    }
    UsageLimits { providers }
}

fn demo_usage_limits() -> UsageLimits {
    let now = Utc::now().timestamp();
    let five_h = 5 * 60 * 60;
    let week = 7 * 24 * 60 * 60;
    UsageLimits {
        providers: vec![
            ProviderUsage {
                provider: "claude".into(),
                plan: Some("max".into()),
                five_hour: UsageWindow {
                    used_percent: Some(41.0),
                    tokens: 1_240_000,
                    cost_usd: 8.42,
                    message_count: 96,
                    resets_at: Some(now + 2 * 60 * 60 + 18 * 60),
                    window_seconds: five_h,
                },
                weekly: UsageWindow {
                    used_percent: Some(28.0),
                    tokens: 18_400_000,
                    cost_usd: 142.10,
                    message_count: 1_812,
                    resets_at: Some(now + 4 * 24 * 60 * 60),
                    window_seconds: week,
                },
                notice: None,
                model_limits: vec![ModelLimit {
                    model: "Fable".into(),
                    window: UsageWindow {
                        used_percent: Some(63.0),
                        tokens: 4_600_000,
                        cost_usd: 63.10,
                        message_count: 212,
                        resets_at: Some(now + 4 * 24 * 60 * 60),
                        window_seconds: week,
                    },
                    is_active: false,
                }],
            },
            ProviderUsage {
                provider: "codex".into(),
                plan: Some("plus".into()),
                five_hour: UsageWindow {
                    used_percent: Some(17.0),
                    tokens: 240_000,
                    cost_usd: 0.0,
                    message_count: 24,
                    resets_at: Some(now + 3 * 60 * 60 + 4 * 60),
                    window_seconds: five_h,
                },
                weekly: UsageWindow {
                    used_percent: Some(22.0),
                    tokens: 3_100_000,
                    cost_usd: 0.0,
                    message_count: 318,
                    resets_at: Some(now + 5 * 24 * 60 * 60),
                    window_seconds: week,
                },
                notice: None,
                model_limits: Vec::new(),
            },
        ],
    }
}

// ── Claude ─────────────────────────────────────────────────────────────

fn claude_usage(force: bool) -> Option<ProviderUsage> {
    let root = dirs::home_dir()?.join(".claude").join("projects");
    if !root.is_dir() {
        return None;
    }

    let now_ms = Utc::now().timestamp_millis();
    let cutoff_5h = now_ms - FIVE_HOURS_MS;
    let cutoff_7d = now_ms - SEVEN_DAYS_MS;
    let mtime_cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(7 * 24 * 60 * 60))
        .unwrap_or(UNIX_EPOCH);

    let mut acc_5h = WindowAcc::default();
    let mut acc_7d = WindowAcc::default();
    // 7-day spend split by model id, so a per-model cap (Fable) can show its
    // own cost and message count next to the API's percentage.
    let mut acc_7d_by_model: HashMap<String, WindowAcc> = HashMap::new();
    // Newest mtime among in-window JSONL files. Fed into `claude_remote_usage`
    // so the cache layer can skip the API call when no new local activity has
    // occurred since the last successful fetch.
    let mut newest_mtime: Option<SystemTime> = None;

    for project in fs::read_dir(&root).ok()?.flatten() {
        let pdir = project.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&pdir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            if mtime < mtime_cutoff {
                continue;
            }
            newest_mtime = Some(newest_mtime.map_or(mtime, |prev| prev.max(mtime)));
            scan_claude_file(
                &path,
                cutoff_5h,
                cutoff_7d,
                &mut acc_5h,
                &mut acc_7d,
                &mut acc_7d_by_model,
            );
        }
    }

    // The real utilization % comes from Anthropic's OAuth API — they don't
    // persist it locally and there's no token-budget formula we can
    // confidently derive from raw spend (it's per-tier, opaque, and
    // changes). The local jsonl scan still feeds the supplementary detail
    // line (cost + message count) so the row stays informative if the API
    // call fails or the user is offline.
    let creds = claude_oauth_creds();
    let plan_label = creds.as_ref().and_then(|(_, plan)| plan.clone());
    let fetch = creds
        .as_ref()
        .map(|(token, _)| claude_remote_usage(token, newest_mtime, force))
        .unwrap_or_default();

    let (pct_5h, reset_5h) = fetch
        .usage
        .as_ref()
        .map(|r| (Some(r.five_hour_pct), r.five_hour_reset))
        .unwrap_or((None, None));
    let (pct_7d, reset_7d) = fetch
        .usage
        .as_ref()
        .map(|r| (Some(r.seven_day_pct), r.seven_day_reset))
        .unwrap_or((None, None));

    // Only surface a notice when the user has creds (otherwise there's
    // nothing actionable — they're just running Claude Code without an
    // OAuth login).
    let notice = if creds.is_some() {
        fetch.failure.map(|f| f.to_notice(fetch.retry_at))
    } else {
        None
    };

    let five_hour = UsageWindow {
        used_percent: pct_5h,
        tokens: acc_5h.tokens(),
        cost_usd: acc_5h.cost,
        message_count: acc_5h.messages,
        // Prefer the API-reported reset (authoritative). Fall back to a
        // synthetic estimate from the oldest in-window message so we still
        // show *something* useful when offline.
        resets_at: reset_5h.or_else(|| acc_5h.oldest_ts.map(|ts| (ts + FIVE_HOURS_MS) / 1000)),
        window_seconds: (FIVE_HOURS_MS / 1000) as u32,
    };
    let weekly = UsageWindow {
        used_percent: pct_7d,
        tokens: acc_7d.tokens(),
        cost_usd: acc_7d.cost,
        message_count: acc_7d.messages,
        resets_at: reset_7d.or_else(|| acc_7d.oldest_ts.map(|ts| (ts + SEVEN_DAYS_MS) / 1000)),
        window_seconds: (SEVEN_DAYS_MS / 1000) as u32,
    };

    let model_limits = fetch
        .usage
        .as_ref()
        .map(|r| {
            r.scoped
                .iter()
                .map(|l| scoped_model_limit(l, &acc_7d_by_model))
                .collect()
        })
        .unwrap_or_default();

    Some(ProviderUsage {
        provider: "claude".into(),
        plan: plan_label,
        five_hour,
        weekly,
        notice,
        model_limits,
    })
}

/// Pair an API-reported per-model cap with the local 7-day spend for every
/// model id in that family ("Fable" covers claude-fable-5 and -5-1).
fn scoped_model_limit(l: &RemoteScopedLimit, by_model: &HashMap<String, WindowAcc>) -> ModelLimit {
    let family = l.model.to_ascii_lowercase();
    let mut tokens = 0;
    let mut cost = 0.0;
    let mut messages = 0;
    let mut oldest: Option<i64> = None;
    for (id, acc) in by_model {
        if family.is_empty() || !id.to_ascii_lowercase().contains(&family) {
            continue;
        }
        tokens += acc.tokens();
        cost += acc.cost;
        messages += acc.messages;
        if let Some(ts) = acc.oldest_ts {
            oldest = Some(oldest.map_or(ts, |o| o.min(ts)));
        }
    }
    ModelLimit {
        model: l.model.clone(),
        window: UsageWindow {
            used_percent: Some(l.pct),
            tokens,
            cost_usd: cost,
            message_count: messages,
            resets_at: l
                .reset
                .or_else(|| oldest.map(|ts| (ts + SEVEN_DAYS_MS) / 1000)),
            window_seconds: (SEVEN_DAYS_MS / 1000) as u32,
        },
        is_active: l.is_active,
    }
}

// ── Claude OAuth → live utilization ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteUsage {
    five_hour_pct: f64,
    five_hour_reset: Option<i64>,
    seven_day_pct: f64,
    seven_day_reset: Option<i64>,
    /// Per-model weekly caps from the response's `limits` array. Defaulted
    /// so disk caches written before this field existed still load.
    #[serde(default)]
    scoped: Vec<RemoteScopedLimit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteScopedLimit {
    model: String,
    pct: f64,
    reset: Option<i64>,
    is_active: bool,
}

// Public Claude Code OAuth client and token endpoint, both extracted from
// the official `claude` CLI binary. Refresh-token grants are accepted
// without a client secret (PKCE-style public client).
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ClaudeCreds {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: ClaudeOauth,
    // Preserve sibling blocks (e.g. mcpOAuth) so we don't drop them when
    // writing the rotated credentials back.
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct ClaudeOauth {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken", skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    /// Milliseconds since the Unix epoch — matches the shape Claude Code writes.
    #[serde(rename = "expiresAt", skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(rename = "subscriptionType", skip_serializing_if = "Option::is_none")]
    subscription_type: Option<String>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct UsageResponse {
    five_hour: UsageBucket,
    seven_day: UsageBucket,
    /// Newer, richer view of the same caps. Per-model weekly limits (Fable)
    /// are reported *only* here — the legacy `seven_day_opus` /
    /// `seven_day_sonnet` fields now come back null. Kept as raw JSON and
    /// parsed leniently so a shape change here can't fail the whole fetch.
    #[serde(default)]
    limits: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct UsageBucket {
    utilization: f64,
    resets_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
    refresh_token: Option<String>,
    /// Lifetime of the new access token in seconds.
    expires_in: Option<i64>,
}

/// Returns (access_token, subscription_label). Plan is surfaced even when
/// the API call later fails so the UI can still show "max plan" etc.
///
/// If the stored access token has expired (or expires within 60 seconds),
/// we mint a fresh one via `/v1/oauth/token` using the refresh token, then
/// write the rotated credentials back to the OS-native store so Claude
/// Code itself stays in sync — Anthropic rotates refresh tokens on every
/// grant, so failing to persist would invalidate Claude Code's copy.
fn claude_oauth_creds() -> Option<(String, Option<String>)> {
    let mut creds = read_claude_creds()?;

    if needs_refresh(&creds.claude_ai_oauth) {
        if let Some(rt) = creds.claude_ai_oauth.refresh_token.clone() {
            if let Some(refreshed) = refresh_claude_token(&rt) {
                let now_ms = Utc::now().timestamp_millis();
                creds.claude_ai_oauth.access_token = refreshed.access_token;
                if let Some(new_rt) = refreshed.refresh_token {
                    creds.claude_ai_oauth.refresh_token = Some(new_rt);
                }
                if let Some(expires_in) = refreshed.expires_in {
                    creds.claude_ai_oauth.expires_at = Some(now_ms + expires_in * 1000);
                }
                if let Err(e) = write_claude_creds(&creds) {
                    crate::elog!(error, "usage", "credential writeback failed: {e}");
                }
            }
        }
    }

    Some((
        creds.claude_ai_oauth.access_token,
        creds.claude_ai_oauth.subscription_type,
    ))
}

fn needs_refresh(o: &ClaudeOauth) -> bool {
    let Some(expires_at) = o.expires_at else {
        return false;
    };
    let now_ms = Utc::now().timestamp_millis();
    expires_at <= now_ms + 60_000
}

fn refresh_claude_token(refresh_token: &str) -> Option<RefreshResponse> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("LunoPeak")
        .build()
        .ok()?;
    // Claude Code itself posts JSON to this endpoint (Content-Type:
    // application/json), not form-encoded. Match that to avoid surprises.
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_OAUTH_CLIENT_ID,
    });
    let resp = match client.post(CLAUDE_TOKEN_URL).json(&body).send() {
        Ok(r) => r,
        Err(e) => {
            crate::elog!(error, "usage", "refresh request failed: {e}");
            return None;
        }
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        crate::elog!(
            error,
            "usage",
            "refresh returned {status}: {}",
            body.chars().take(200).collect::<String>()
        );
        return None;
    }
    match resp.json::<RefreshResponse>() {
        Ok(v) => Some(v),
        Err(e) => {
            crate::elog!(error, "usage", "refresh response parse failed: {e}");
            None
        }
    }
}

// We shell out to `security` rather than using the `keyring` crate
// because the entry was created by the Claude CLI under its own binary
// identity — `keyring`'s direct Security-framework call gets denied
// silently in unsigned dev builds, while `security` triggers the
// standard macOS "Allow / Always Allow / Deny" prompt the first time.
#[cfg(target_os = "macos")]
fn read_claude_creds() -> Option<ClaudeCreds> {
    use std::process::Command;
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        crate::elog!(
            error,
            "usage",
            "keychain lookup failed: status={:?} stderr={}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    let secret = String::from_utf8(out.stdout).ok()?;
    match serde_json::from_str(secret.trim()) {
        Ok(v) => Some(v),
        Err(e) => {
            crate::elog!(error, "usage", "keychain payload parse failed: {e}");
            None
        }
    }
}

/// Writes the renewed credentials back through `security -i`, which reads the
/// command from stdin. Passing the JSON as a `-w <payload>` argument would put
/// the tokens in the process table, where any local process could read them.
/// `/usr/bin/security` is kept (rather than the Security framework) because
/// Claude Code's keychain item already trusts it, so no access prompt appears.
#[cfg(target_os = "macos")]
fn write_claude_creds(creds: &ClaudeCreds) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let account = keychain_account().ok_or_else(|| "no acct on keychain entry".to_string())?;
    let payload = serde_json::to_string(creds).map_err(|e| e.to_string())?;
    let line = format!(
        "add-generic-password -U -s {} -a {} -w {}\n",
        security_quote("Claude Code-credentials"),
        security_quote(&account),
        security_quote(&payload),
    );
    let mut child = Command::new("security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| "security stdin unavailable".to_string())?
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    // Interactive mode exits 0 even when the command fails; it reports the
    // failure as "<command>: returned <code>" instead.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() || !stderr.trim().is_empty() || stdout.contains(": returned ") {
        return Err(format!(
            "status={:?} output={}",
            out.status.code(),
            format!("{} {}", stdout.trim(), stderr.trim()).trim()
        ));
    }
    Ok(())
}

/// Quotes one argument for `security -i`'s command line: wrapped in double
/// quotes, with backslashes and double quotes backslash-escaped.
#[cfg(target_os = "macos")]
fn security_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn keychain_account() -> Option<String> {
    use std::process::Command;
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let line = line.trim();
        let prefix = "\"acct\"<blob>=\"";
        if let Some(rest) = line.strip_prefix(prefix) {
            if let Some(end) = rest.rfind('"') {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn read_claude_creds() -> Option<ClaudeCreds> {
    let path = creds_file_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(not(target_os = "macos"))]
fn write_claude_creds(creds: &ClaudeCreds) -> Result<(), String> {
    let path = creds_file_path().ok_or_else(|| "no home dir".to_string())?;
    let payload = serde_json::to_string_pretty(creds).map_err(|e| e.to_string())?;
    std::fs::write(&path, payload).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn creds_file_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join(".credentials.json"))
}

// The /api/oauth/usage endpoint has aggressive server-side rate limits and
// is shared with Claude Code's own statusline poller using the same OAuth
// token, so we cache and back off hard on 429. What keeps the request volume
// down is the *mtime extension*, not a long success TTL — see below.
//   - Success: SUCCESS_TTL (short — this is the ceiling on how stale the menu
//     bar can be while the user is actively coding, which is the only time the
//     percentage moves)
//   - Rate-limited / failure: 15 min backoff during which we skip the fetch
//     entirely and fall back to the local jsonl scan
//   - Mtime-extension: when the TTL elapses but no new local Claude JSONL
//     has been written since the last successful fetch, the % can't have
//     moved on this machine — keep returning the cached value rather than
//     re-pinging. Capped at MTIME_EXTENSION_CAP_SECS so cross-machine usage
//     eventually surfaces, and bypassed entirely when a reset window passes.
//     An idle machine therefore polls once per cap, not once per TTL.
//   - Cross-process share: on macOS the menu-bar agent and the window are
//     separate processes, each running its own copy of this module. They
//     exchange entries through `cache_file()` so one fetch serves both.
//
// Freshness is tracked in wall-clock unix seconds rather than `Instant`:
// macOS's monotonic clock stops while the machine is asleep, so an
// `Instant`-based TTL would treat an entry written before a three-hour nap
// as seconds old and keep the pre-sleep percentage pinned in the menu bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    /// `CACHE_VERSION` of the build that wrote this entry. Entries written
    /// before the field existed deserialize as 0.
    #[serde(default)]
    version: u32,
    /// Unix seconds when this entry was written.
    fetched_unix: i64,
    /// Unix seconds when this entry expires and we'll re-fetch. Also handed
    /// to the UI so it can say when the next attempt lands.
    expires_unix: i64,
    value: Option<RemoteUsage>,
    /// Set when `value` is None — describes *why* the fetch failed so the UI
    /// can surface a hint instead of silently dropping the % bar.
    failure: Option<FailureKind>,
    /// Newest local Claude JSONL mtime at fetch time, in unix seconds. Used by
    /// subsequent callers to detect that no new local activity has occurred —
    /// in which case the cached % is still authoritative for this machine.
    local_mtime_unix: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum FailureKind {
    RateLimited,
    HttpError(u16),
    Network,
    Parse,
}

impl FailureKind {
    fn to_notice(&self, retry_at: Option<i64>) -> UsageNotice {
        let (kind, message) = match self {
            FailureKind::RateLimited => (
                "rateLimited",
                "Anthropic usage API is rate-limited".to_string(),
            ),
            FailureKind::HttpError(code) => (
                "authError",
                format!("Anthropic usage API returned HTTP {code}"),
            ),
            FailureKind::Network => (
                "networkError",
                "Couldn't reach Anthropic usage API".to_string(),
            ),
            FailureKind::Parse => (
                "parseError",
                "Anthropic usage API returned an unexpected response".to_string(),
            ),
        };
        UsageNotice {
            kind: kind.into(),
            message,
            retry_at,
        }
    }
}

/// Result of a cache hit or live fetch. `usage` is the parsed percentages
/// when we have them, `failure` describes the reason when we don't.
#[derive(Default)]
struct RemoteFetch {
    usage: Option<RemoteUsage>,
    failure: Option<FailureKind>,
    /// Unix seconds when the cached state will expire and we'll re-fetch.
    retry_at: Option<i64>,
}

static REMOTE_CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);
/// Set while an HTTP request to `/api/oauth/usage` is in flight. Concurrent
/// callers (tray refresh tick + dashboard refetch landing in the same
/// second) skip the call and return the cached value rather than firing a
/// duplicate request against the same endpoint.
static FETCH_IN_PROGRESS: AtomicBool = AtomicBool::new(false);
/// How stale the menu-bar percentage may be *while the user is actively
/// coding*. 15 minutes was the original value and was why the tray lagged real
/// usage by a quarter hour; the % only moves when a message is sent, and the
/// mtime extension below suppresses the poll entirely while nothing is being
/// written locally, so a long success TTL bought no headroom during idle
/// periods and cost accuracy during active ones.
///
/// It must nonetheless stay **longer than the tray's `REFRESH_SECS` (60s)**.
/// A TTL below the poll interval means every tick, in every process, always
/// finds the entry expired — the shared cache can only ever return a hit to a
/// caller arriving *within* the TTL, so a sub-tick TTL silently converts the
/// dedupe below into pure overhead and turns each poller into its own request
/// stream. Measured in production at 45s: ~60 requests/hour from the agent
/// alone, ~120 with the dashboard on screen, against ~4–8/hour before — which
/// earned three 429s in an afternoon. This endpoint's quota is account-wide and
/// mostly consumed by Claude Code's own statusline pollers, so LunoPeak has to
/// be the quiet neighbor. At 3 minutes an active session costs ~20 requests an
/// hour and the menu bar is never more than ~4 minutes behind.
const SUCCESS_TTL: Duration = Duration::from_secs(3 * 60);
const BACKOFF_TTL: Duration = Duration::from_secs(15 * 60);
/// Short backoff for *transient* failures (network unreachable, parse hiccup).
/// Unlike a 429, these carry no server-side penalty for retrying — the user was
/// briefly offline. A short TTL lets the 60s poll self-heal soon after they're
/// back online, and a `force` retry bypasses it entirely. The long `BACKOFF_TTL`
/// stays reserved for actual rate-limits / HTTP errors.
const TRANSIENT_TTL: Duration = Duration::from_secs(30);
/// Hard ceiling on how long a successful cache entry can be extended via
/// the no-local-activity skip. After this, we re-fetch even if no JSONL
/// has been written — catches cross-machine usage on the same account, and
/// bounds how stale an idle machine's menu bar can get.
const MTIME_EXTENSION_CAP_SECS: i64 = 15 * 60;

/// Bump whenever `RemoteUsage` gains data an older build can't write. The
/// cache file is shared with the menu-bar agent, which can outlive an app
/// update by weeks; an older agent's entry parses fine (new fields are
/// `#[serde(default)]`) but silently lacks them, and the mtime extension would
/// otherwise keep serving it. 1: per-model weekly limits (`scoped`).
const CACHE_VERSION: u32 = 1;

fn store_cache(
    value: Option<RemoteUsage>,
    failure: Option<FailureKind>,
    ttl: Duration,
    local_mtime_unix: Option<i64>,
) {
    let now = Utc::now().timestamp();
    let entry = keep_live_backoff(
        CacheEntry {
            version: CACHE_VERSION,
            fetched_unix: now,
            expires_unix: now + ttl.as_secs() as i64,
            value,
            failure,
            local_mtime_unix,
        },
        current_entry().as_ref(),
        now,
    );
    write_disk_cache(&entry);
    if let Ok(mut guard) = REMOTE_CACHE.lock() {
        *guard = Some(entry);
    }
}

/// A 429 is a statement about the *account*, not about the process that
/// happened to receive it. A fetch already in flight when the backoff landed —
/// from the other process, or from this one racing its own tick — can come back
/// successful and, being the newer write, would otherwise overwrite the backoff
/// and drop us straight back to `SUCCESS_TTL` polling inside a window the
/// server explicitly closed. That's how one 429 turns into several.
///
/// Keep both halves of the truth: the fresh percentages (they're real data, and
/// the user should see them) and the original retry deadline (the server's
/// instruction, which outlives whichever request got through).
fn keep_live_backoff(mut entry: CacheEntry, prev: Option<&CacheEntry>, now_sec: i64) -> CacheEntry {
    let Some(prev) = prev else { return entry };
    let backoff_live =
        matches!(prev.failure, Some(FailureKind::RateLimited)) && now_sec < prev.expires_unix;
    if backoff_live && entry.failure.is_none() {
        entry.failure = prev.failure.clone();
        entry.expires_unix = prev.expires_unix;
    }
    entry
}

/// Freshest entry we know about: this process's in-memory copy, or the shared
/// on-disk copy if the counterpart process (macOS window ↔ menu-bar agent)
/// fetched more recently than we did.
fn current_entry() -> Option<CacheEntry> {
    let mem = REMOTE_CACHE.lock().ok().and_then(|g| g.clone());
    let disk = read_disk_cache();
    let entry = match (mem, disk) {
        (Some(m), Some(d)) => Some(if d.fetched_unix > m.fetched_unix { d } else { m }),
        (m, d) => m.or(d),
    }?;
    // An entry stamped in the future means the clock moved backwards (NTP
    // correction, timezone-less RTC on a fresh boot). Treat it as unusable
    // rather than letting it pin the UI until wall-clock catches up.
    if entry.fetched_unix > Utc::now().timestamp() + 60 {
        return None;
    }
    Some(entry)
}

/// Shared between the two macOS processes — the window and the `.accessory`
/// menu-bar agent each run their own copy of this module, and without a shared
/// file they'd poll `/api/oauth/usage` independently, doubling the request rate
/// against an endpoint we're already sharing with Claude Code itself. Also
/// means a restarted agent paints the last known % instead of a blank bar
/// while its first fetch is in flight.
///
/// Path is derived rather than taken from an `AppHandle` because this module
/// has no handle to thread through; it matches Tauri's `app_config_dir()` for
/// our bundle identifier on every platform we ship.
fn cache_file() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("com.lunopeak.app")
            .join("usage-cache.json"),
    )
}

/// Seconds since the epoch, or `None` for a pre-1970 timestamp (a filesystem
/// with no mtime, which we treat the same as "unknown").
fn unix_secs(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

/// Companion to `cache_file()`: the lease that makes *the account* — rather
/// than each process — the unit this endpoint is polled on.
fn lease_file() -> Option<PathBuf> {
    Some(cache_file()?.with_file_name("usage-fetch.lock"))
}

/// Longest a lease may be held before another process is entitled to break it.
/// Covers the 5s HTTP timeout plus a token refresh that can precede it, with
/// room to spare — the cost of breaking too early is a duplicate request, the
/// cost of breaking too late is a stuck percentage, so we err long.
const LEASE_TTL_SECS: i64 = 30;

/// Exclusive right to call `/api/oauth/usage` on this account's behalf, held
/// across processes for the duration of one fetch.
///
/// `SUCCESS_TTL` being longer than the poll interval means the shared cache
/// already absorbs almost all duplicate work: whichever process fetches first
/// writes an entry the other one reads instead of fetching. The lease closes
/// the remaining window — two processes on independent 60s timers will
/// occasionally tick in the same second, both find the entry expired, and both
/// fetch. Against a burst-sensitive limit, that simultaneous pair is precisely
/// the shape that earns a 429.
///
/// Releases on drop, including on panic or early return.
struct FetchLease {
    /// `None` when we couldn't resolve or create a lock file. We proceed with
    /// the fetch unleased rather than blocking it — degrading to the previous
    /// (correct, merely chattier) behavior beats never refreshing at all.
    path: Option<PathBuf>,
}

impl FetchLease {
    /// `None` means another process holds a live lease and is fetching right
    /// now — the caller should serve its cached entry instead.
    fn try_acquire() -> Option<Self> {
        let Some(path) = lease_file() else {
            return Some(Self { path: None });
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match Self::claim(&path) {
            Ok(true) => Some(Self { path: Some(path) }),
            Ok(false) => None,
            // Permissions, read-only volume, anything else — don't let a lock
            // we can't manage become a lock we can never release.
            Err(_) => Some(Self { path: None }),
        }
    }

    /// Atomically create the lock file. A lease older than `LEASE_TTL_SECS` is
    /// assumed abandoned — its holder crashed or was killed mid-fetch — and is
    /// broken once, then re-claimed.
    fn claim(path: &std::path::Path) -> std::io::Result<bool> {
        use std::io::ErrorKind;
        match fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() != ErrorKind::AlreadyExists => return Err(e),
            Err(_) => {}
        }
        // `map_or(true, …)` rather than `is_none_or`: the latter needs Rust
        // 1.82 and this crate declares `rust-version = "1.77"`. An unreadable
        // timestamp counts as stale — better a duplicate request than a lease
        // nobody can ever break.
        let stale = fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(unix_secs)
            .map_or(true, |held_since| {
                Utc::now().timestamp() - held_since > LEASE_TTL_SECS
            });
        if !stale {
            return Ok(false);
        }
        let _ = fs::remove_file(path);
        match fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(_) => Ok(true),
            // Lost the race to break it — whoever won is fetching, which is
            // the outcome we wanted anyway.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    }
}

impl Drop for FetchLease {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

fn read_disk_cache() -> Option<CacheEntry> {
    let raw = fs::read_to_string(cache_file()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Best-effort: a failed write just means the counterpart process does its own
/// fetch, which is the pre-existing behavior. Never blocks the usage path.
fn write_disk_cache(entry: &CacheEntry) {
    let Some(path) = cache_file() else {
        return;
    };
    let Ok(payload) = serde_json::to_string(entry) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Write-then-rename so a reader in the other process never sees a
    // half-written file and discards a perfectly good entry. The pid in the
    // temp name keeps the window and agent processes from interleaving writes
    // into a shared scratch file when their poll ticks happen to align.
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    if fs::write(&tmp, payload).is_ok() && fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

/// RAII guard that clears `FETCH_IN_PROGRESS` on drop, so a panic or early
/// return inside the HTTP path can't strand the flag set and lock out all
/// future fetches.
struct FetchGuard;
impl Drop for FetchGuard {
    fn drop(&mut self) {
        FETCH_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Parse the `Retry-After` response header. RFC 9110 allows either a number
/// of seconds or an HTTP-date — Anthropic uses seconds in practice, but we
/// handle both for safety. Returns `None` if the header is absent / unparseable.
fn parse_retry_after(resp: &reqwest::blocking::Response) -> Option<Duration> {
    let raw = resp.headers().get("retry-after")?.to_str().ok()?.trim();
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let dt = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    let delta = dt.timestamp() - Utc::now().timestamp();
    if delta <= 0 {
        return None;
    }
    Some(Duration::from_secs(delta as u64))
}

/// Whether `entry` can answer this call without hitting the network.
///
/// Two ways to say yes:
///   - still inside its TTL, or
///   - the *extension* path: the entry is a success, nothing has been written
///     to the local Claude JSONL since it was fetched (so the percentage
///     cannot have moved on this machine), and we're inside
///     `MTIME_EXTENSION_CAP_SECS` — the ceiling that lets usage from another
///     machine on the same account eventually surface.
///
/// One veto overrides both: once a cached window is past its `resets_at`, the
/// percentages describe the pre-reset window. Serving them would leave the
/// menu bar showing an expired figure (and an elapsed countdown) that the user
/// could only clear by restarting the app.
fn serve_cached(entry: &CacheEntry, now_sec: i64, newest_local_unix: Option<i64>) -> bool {
    // A live rate-limit backoff outranks every other consideration, including
    // the reset-window veto below. The server told us to stop asking; a window
    // rolling over in the meantime is not permission to disobey. This matters
    // because `keep_live_backoff` can leave a successful entry carrying a
    // RateLimited failure, and that entry's own reset timestamps will elapse
    // normally while the backoff is still running.
    if matches!(entry.failure, Some(FailureKind::RateLimited)) && now_sec < entry.expires_unix {
        return true;
    }
    // Written by a build with a different shape: its percentages may be fine,
    // but fields it didn't know about are missing, so refetch. Sits below the
    // backoff check on purpose: a 429 is about the account, whoever wrote it.
    if entry.version != CACHE_VERSION {
        return false;
    }
    let window_elapsed = entry.value.as_ref().is_some_and(|u| {
        u.five_hour_reset.is_some_and(|t| t <= now_sec)
            || u.seven_day_reset.is_some_and(|t| t <= now_sec)
            || u.scoped.iter().any(|l| l.reset.is_some_and(|t| t <= now_sec))
    });
    if window_elapsed {
        return false;
    }
    let within_ttl = now_sec < entry.expires_unix;
    let extension_eligible = entry.failure.is_none()
        && entry.value.is_some()
        && now_sec - entry.fetched_unix < MTIME_EXTENSION_CAP_SECS
        && match (entry.local_mtime_unix, newest_local_unix) {
            (_, None) => true,
            (None, Some(_)) => false,
            (Some(prev), Some(curr)) => curr <= prev,
        };
    within_ttl || extension_eligible
}

/// Answer from a cache entry we've decided not to refresh, or with nothing if
/// we've never had one.
fn serve_or_default(entry: Option<CacheEntry>) -> RemoteFetch {
    match entry {
        Some(e) => RemoteFetch {
            usage: e.value,
            failure: e.failure,
            retry_at: Some(e.expires_unix),
        },
        None => RemoteFetch::default(),
    }
}

fn claude_remote_usage(
    token: &str,
    newest_local_mtime: Option<SystemTime>,
    force: bool,
) -> RemoteFetch {
    // An explicit user retry skips the cache short-circuit so the button
    // actually re-pings — EXCEPT through a live 429, where retrying early just
    // re-arms the server's timer (the very thing BACKOFF_TTL exists to avoid).
    // The frontend already gates the button on rate-limit notices, so in
    // practice `force` only arrives for transient / success states; the guard
    // here is defense in depth.
    let newest_local_unix = newest_local_mtime.and_then(unix_secs);
    let cached = current_entry();
    let force_bypass = force
        && !cached
            .as_ref()
            .is_some_and(|e| matches!(e.failure, Some(FailureKind::RateLimited)));
    if !force_bypass {
        if let Some(entry) = cached.as_ref() {
            if serve_cached(entry, Utc::now().timestamp(), newest_local_unix) {
                return RemoteFetch {
                    usage: entry.value.clone(),
                    failure: entry.failure.clone(),
                    retry_at: Some(entry.expires_unix),
                };
            }
        }
    }

    // In-flight dedupe: only one HTTP call against `/api/oauth/usage` at a
    // time. Concurrent callers (60s tray tick aligning with a dashboard
    // refetch, etc.) bail out with the previous cache value rather than
    // doubling up requests against the same rate-limited endpoint.
    if FETCH_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        if let Some(entry) = cached {
            return RemoteFetch {
                usage: entry.value,
                failure: entry.failure,
                retry_at: Some(entry.expires_unix),
            };
        }
        return RemoteFetch::default();
    }
    let _guard = FetchGuard;

    // Cross-process dedupe. `FETCH_IN_PROGRESS` above only covers threads
    // inside *this* process; on macOS the window and the menu-bar agent are
    // separate processes polling the same account.
    let Some(_lease) = FetchLease::try_acquire() else {
        return serve_or_default(current_entry());
    };
    // Double-check now that we hold the lease: the process we queued behind may
    // have just written a fresh entry, in which case the whole point of waiting
    // was to use it rather than repeat its request.
    if !force_bypass {
        if let Some(entry) = current_entry() {
            if serve_cached(&entry, Utc::now().timestamp(), newest_local_unix) {
                return serve_or_default(Some(entry));
            }
        }
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            crate::elog!(error, "usage", "reqwest client build failed: {e}");
            store_cache(
                None,
                Some(FailureKind::Network),
                TRANSIENT_TTL,
                newest_local_unix,
            );
            return RemoteFetch {
                failure: Some(FailureKind::Network),
                retry_at: Some(Utc::now().timestamp() + TRANSIENT_TTL.as_secs() as i64),
                ..Default::default()
            };
        }
    };
    let resp = match client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            crate::elog!(error, "usage", "anthropic /api/oauth/usage request failed: {e}");
            store_cache(
                None,
                Some(FailureKind::Network),
                TRANSIENT_TTL,
                newest_local_unix,
            );
            return RemoteFetch {
                failure: Some(FailureKind::Network),
                retry_at: Some(Utc::now().timestamp() + TRANSIENT_TTL.as_secs() as i64),
                ..Default::default()
            };
        }
    };
    let status = resp.status();
    if !status.is_success() {
        // Server-side hint about when to retry. Anthropic sets this on 429s.
        // We use max(BACKOFF_TTL, retry_after) so we never undershoot the
        // server's wishes (retrying early just re-arms the same 429 and
        // resets the timer — that's how we'd get stuck before).
        let retry_after = parse_retry_after(&resp);
        let body = resp.text().unwrap_or_default();
        crate::elog!(
            error,
            "usage",
            "anthropic /api/oauth/usage returned {status} (retry-after={:?}): {}",
            retry_after,
            body.chars().take(200).collect::<String>()
        );
        let failure = if status.as_u16() == 429 {
            FailureKind::RateLimited
        } else {
            FailureKind::HttpError(status.as_u16())
        };
        let ttl = retry_after
            .map(|ra| ra.max(BACKOFF_TTL))
            .unwrap_or(BACKOFF_TTL);
        store_cache(None, Some(failure.clone()), ttl, newest_local_unix);
        return RemoteFetch {
            failure: Some(failure),
            retry_at: Some(Utc::now().timestamp() + ttl.as_secs() as i64),
            ..Default::default()
        };
    }
    let body: UsageResponse = match resp.json() {
        Ok(v) => v,
        Err(e) => {
            crate::elog!(error, "usage", "anthropic usage response parse failed: {e}");
            store_cache(
                None,
                Some(FailureKind::Parse),
                TRANSIENT_TTL,
                newest_local_unix,
            );
            return RemoteFetch {
                failure: Some(FailureKind::Parse),
                retry_at: Some(Utc::now().timestamp() + TRANSIENT_TTL.as_secs() as i64),
                ..Default::default()
            };
        }
    };
    let usage = RemoteUsage {
        five_hour_pct: body.five_hour.utilization,
        five_hour_reset: body.five_hour.resets_at.as_deref().and_then(parse_iso_secs),
        seven_day_pct: body.seven_day.utilization,
        seven_day_reset: body.seven_day.resets_at.as_deref().and_then(parse_iso_secs),
        scoped: parse_scoped_limits(&body.limits),
    };

    store_cache(Some(usage.clone()), None, SUCCESS_TTL, newest_local_unix);
    RemoteFetch {
        usage: Some(usage),
        failure: None,
        retry_at: Some(Utc::now().timestamp() + SUCCESS_TTL.as_secs() as i64),
    }
}

/// Pull the per-model weekly caps out of the usage response's `limits`
/// array. An entry looks like:
///
/// ```json
/// { "kind": "weekly_scoped", "group": "weekly", "percent": 43,
///   "severity": "normal", "is_active": false,
///   "resets_at": "2026-09-19T09:00:00Z",
///   "scope": { "model": { "id": null, "display_name": "Fable" } } }
/// ```
///
/// `session` / `weekly_all` entries duplicate `five_hour` / `seven_day` and
/// are skipped. Entries missing a model name or a percentage are dropped
/// rather than guessed at.
fn parse_scoped_limits(limits: &[serde_json::Value]) -> Vec<RemoteScopedLimit> {
    limits
        .iter()
        .filter(|l| l.get("kind").and_then(|k| k.as_str()) == Some("weekly_scoped"))
        .filter_map(|l| {
            let model = l.pointer("/scope/model");
            let name = model
                .and_then(|m| m.get("display_name"))
                .and_then(|v| v.as_str())
                .or_else(|| model.and_then(|m| m.get("id")).and_then(|v| v.as_str()))
                .filter(|s| !s.is_empty())?;
            let pct = l.get("percent").and_then(|v| v.as_f64())?;
            Some(RemoteScopedLimit {
                model: name.to_string(),
                pct,
                reset: l
                    .get("resets_at")
                    .and_then(|v| v.as_str())
                    .and_then(parse_iso_secs),
                is_active: l
                    .get("is_active")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn parse_iso_secs(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

#[derive(Default)]
struct WindowAcc {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    cost: f64,
    messages: u32,
    /// Earliest message timestamp seen inside the window — used to
    /// estimate when the oldest contribution will roll off.
    oldest_ts: Option<i64>,
}

impl WindowAcc {
    /// Total tokens that were billable in any tier — fresh input/output plus
    /// cache reads and writes. The cost calculation already includes all
    /// four; the displayed "tok" count should match that scope.
    fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }

    fn record(&mut self, ts: i64, usage: &ClaudeUsageBlob, model: Option<&str>) {
        let i = usage.input_tokens.unwrap_or(0);
        let o = usage.output_tokens.unwrap_or(0);
        let cr = usage.cache_read_input_tokens.unwrap_or(0);
        let cc = usage.cache_creation_input_tokens.unwrap_or(0);
        let cc_1h = usage
            .cache_creation
            .as_ref()
            .and_then(|c| c.ephemeral_1h_input_tokens)
            .unwrap_or(0);
        self.input += i;
        self.output += o;
        self.cache_read += cr;
        self.cache_creation += cc;
        self.messages += 1;
        if let Some(m) = model {
            self.cost += pricing::cost_of(
                m,
                &crate::models::TokenUsage {
                    input: i,
                    output: o,
                    cache_read: cr,
                    cache_creation: cc,
                    cache_creation_1h: cc_1h,
                },
                Some(ts),
            );
        }
        self.oldest_ts = Some(self.oldest_ts.map_or(ts, |prev| prev.min(ts)));
    }
}

#[derive(Debug, Deserialize)]
struct ClaudeLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    model: Option<String>,
    usage: Option<ClaudeUsageBlob>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsageBlob {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_creation: Option<CacheCreationBlob>,
}

#[derive(Debug, Deserialize)]
struct CacheCreationBlob {
    ephemeral_1h_input_tokens: Option<u64>,
}

fn scan_claude_file(
    path: &PathBuf,
    cutoff_5h: i64,
    cutoff_7d: i64,
    acc_5h: &mut WindowAcc,
    acc_7d: &mut WindowAcc,
    acc_7d_by_model: &mut HashMap<String, WindowAcc>,
) {
    let Ok(file) = File::open(path) else { return };
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(parsed): Result<ClaudeLine, _> = serde_json::from_str(&line) else {
            continue;
        };
        if parsed.kind.as_deref() != Some("assistant") {
            continue;
        }
        let Some(ts) = parsed.timestamp.as_deref().and_then(parse_ts_ms) else {
            continue;
        };
        if ts < cutoff_7d {
            continue;
        }
        let Some(msg) = parsed.message else { continue };
        let Some(usage) = msg.usage else { continue };
        let model = msg.model.as_deref();
        acc_7d.record(ts, &usage, model);
        if let Some(m) = model {
            acc_7d_by_model
                .entry(m.to_string())
                .or_default()
                .record(ts, &usage, model);
        }
        if ts >= cutoff_5h {
            acc_5h.record(ts, &usage, model);
        }
    }
}

fn parse_ts_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

// ── Codex ──────────────────────────────────────────────────────────────

/// `web_enabled` (the Codex agent toggle) gates the network call, so turning
/// Codex off in Settings stops LunoPeak talking to chatgpt.com.
fn codex_usage(web_enabled: bool) -> Option<ProviderUsage> {
    if web_enabled {
        if let Some(snap) = codex_web::fetch() {
            return Some(codex_provider(snap.plan_type, snap.primary, snap.secondary));
        }
    }
    // Codex builds before 0.163 logged every websocket `codex.rate_limits`
    // event to the SQLite log, Codex Desktop included (it doesn't write the
    // rollout `token_count` block). Newer builds log the event name only, so
    // this finds nothing there and the rollout is the last resort.
    if let Some(p) = codex_sqlite_usage() {
        return Some(p);
    }
    codex_rollout_usage()
}

/// Both windows from whichever source answered. A block whose reset has
/// passed reports the prior window — the user hasn't run Codex since it
/// rolled over — so it reads as a fresh window at 0%.
fn codex_provider(
    plan: Option<String>,
    primary: Option<CodexWindow>,
    secondary: Option<CodexWindow>,
) -> ProviderUsage {
    let now_sec = Utc::now().timestamp();
    let window = |w: Option<CodexWindow>, default_ms: i64| {
        let window_seconds = w
            .as_ref()
            .and_then(|w| w.window_seconds)
            .unwrap_or((default_ms / 1000) as u32);
        let fresh = w.filter(|w| w.resets_at.map_or(true, |t| t > now_sec));
        UsageWindow {
            used_percent: Some(fresh.as_ref().map_or(0.0, |w| w.used_percent)),
            tokens: 0,
            cost_usd: 0.0,
            message_count: 0,
            resets_at: fresh.and_then(|w| w.resets_at),
            window_seconds,
        }
    };
    ProviderUsage {
        provider: "codex".into(),
        plan,
        five_hour: window(primary, FIVE_HOURS_MS),
        weekly: window(secondary, SEVEN_DAYS_MS),
        notice: None,
        model_limits: Vec::new(),
    }
}

fn codex_rollout_usage() -> Option<ProviderUsage> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    if !root.is_dir() {
        return None;
    }

    // Walk the tree (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]) and
    // pick the file with the most recent mtime — it holds the freshest
    // rate_limits block.
    let latest = crate::scanners::codex::rollout_files(&root)
        .into_iter()
        .max_by_key(|(_, mt)| *mt)
        .map(|(p, _)| p)?;

    let parsed = parse_codex_file(&latest)?;
    let window = |l: Option<CodexLimit>| {
        l.map(|l| CodexWindow {
            used_percent: l.used_percent,
            window_seconds: l.window_minutes.map(|m| m * 60),
            resets_at: l.resets_at,
        })
    };
    Some(codex_provider(
        parsed.plan_type,
        window(parsed.primary),
        window(parsed.secondary),
    ))
}

#[derive(Debug, Default)]
struct CodexParsed {
    plan_type: Option<String>,
    primary: Option<CodexLimit>,
    secondary: Option<CodexLimit>,
}

#[derive(Debug, Clone, Deserialize)]
struct CodexLimit {
    used_percent: f64,
    window_minutes: Option<u32>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct CodexLine {
    #[serde(rename = "type")]
    kind: Option<String>,
    payload: Option<serde_json::Value>,
}

fn parse_codex_file(path: &PathBuf) -> Option<CodexParsed> {
    let reader = crate::scanners::codex::open_rollout(path)?;
    let mut latest = CodexParsed::default();
    let mut found = false;

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(parsed): Result<CodexLine, _> = serde_json::from_str(&line) else {
            continue;
        };
        if parsed.kind.as_deref() != Some("event_msg") {
            continue;
        }
        let Some(payload) = parsed.payload else {
            continue;
        };
        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(rate) = payload.get("rate_limits") else {
            continue;
        };
        // Take the LAST rate_limits block in the file — that's the most
        // recent state the agent observed.
        if let Some(plan) = rate.get("plan_type").and_then(|v| v.as_str()) {
            latest.plan_type = Some(plan.to_string());
        }
        latest.primary = rate
            .get("primary")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        latest.secondary = rate
            .get("secondary")
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok());
        found = true;
    }

    if found {
        Some(latest)
    } else {
        None
    }
}

/// Open `~/.codex/logs_2.sqlite` and recover the most recent
/// `codex.rate_limits` websocket event. The codex-rs core writes one of these
/// per assistant turn for every frontend (npm `codex-tui`, `Codex Desktop`,
/// extensions, etc.), so when the user is actively running codex this is
/// effectively a live feed of their plan utilization.
fn codex_sqlite_usage() -> Option<ProviderUsage> {
    use rusqlite::{Connection, OpenFlags};
    let db_path = dirs::home_dir()?.join(".codex").join("logs_2.sqlite");
    if !db_path.exists() {
        return None;
    }

    // `mode=ro` (no `immutable=1`) — codex may be actively writing to this DB,
    // and immutable=1 lets SQLite skip locking, which would risk torn reads.
    let uri = format!(
        "file:{}?mode=ro",
        db_path.to_string_lossy().replace('?', "%3F")
    );
    let conn = match Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => {
            crate::elog!(error, "usage", "codex sqlite open failed: {e}");
            return None;
        }
    };

    // Newest log line that contains a codex.rate_limits payload. Filter on
    // both substrings so we skip the noisier `account/rateLimits/read` HTTP
    // trace lines that share the prefix but carry no JSON.
    let body: String = conn
        .query_row(
            "SELECT feedback_log_body FROM logs \
             WHERE feedback_log_body LIKE '%codex.rate_limits%' \
               AND feedback_log_body LIKE '%used_percent%' \
             ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok()?;

    let json_str = extract_rate_limits_json(&body)?;
    let event: CodexRateLimitsEvent = serde_json::from_str(json_str)
        .map_err(|e| {
            crate::elog!(error, "usage", "codex rate_limits parse failed: {e}");
            e
        })
        .ok()?;

    let window = |l: Option<CodexLimitDetail>| {
        l.map(|l| CodexWindow {
            used_percent: l.used_percent,
            window_seconds: l.window_minutes.map(|m| m * 60),
            resets_at: l.reset_at,
        })
    };
    Some(codex_provider(
        event.plan_type,
        window(event.rate_limits.primary),
        window(event.rate_limits.secondary),
    ))
}

#[derive(Debug, Deserialize)]
struct CodexRateLimitsEvent {
    plan_type: Option<String>,
    rate_limits: CodexRateLimitsBlock,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimitsBlock {
    primary: Option<CodexLimitDetail>,
    secondary: Option<CodexLimitDetail>,
}

#[derive(Debug, Deserialize)]
struct CodexLimitDetail {
    used_percent: f64,
    window_minutes: Option<u32>,
    reset_at: Option<i64>,
}

/// Extract the embedded `{"type":"codex.rate_limits", …}` JSON object from a
/// log line. The codex-rs tracing layer wraps the JSON inside a free-form
/// span breadcrumb (`"… websocket event: { … }"`) so we can't just parse the
/// whole body. We locate the marker, then walk forward balancing braces (with
/// string-quote awareness so a `}` inside a JSON string can't unbalance us).
fn extract_rate_limits_json(body: &str) -> Option<&str> {
    let marker = r#"{"type":"codex.rate_limits""#;
    let start = body.find(marker)?;
    let bytes = body.as_bytes();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes[start..].iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match b {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&body[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

// ── Cursor ─────────────────────────────────────────────────────────────

/// Cursor doesn't expose a rate-limit window — its "fast requests" quota
/// lives server-side. What it *does* persist locally (in
/// globalStorage/state.vscdb under `composer.composerHeaders`) is a per-
/// composer `contextUsagePercent`. We surface the highest-utilized active
/// composer in the 24h window as a stand-in headline; weekly is left empty
/// because there's no equivalent weekly metric to compute.
///
/// When `web_enabled` is true and a Cursor session cookie is found in any
/// installed browser, the headline is replaced with the real plan utilization
/// from `cursor.com/api/usage-summary` and the weekly slot is repurposed to
/// show on-demand (overage) spend. SQLite data still provides the chat count.
pub(crate) fn cursor_usage(web_enabled: bool) -> Option<ProviderUsage> {
    use rusqlite::{Connection, OpenFlags};

    // Gate on the actual Cursor app being installed. The state DB can linger
    // in AppData / Application Support after an uninstall, so checking only
    // the DB would keep showing a row for users who no longer have Cursor.
    if !cursor_installed() {
        return None;
    }

    let db_path = cursor_state_db()?;
    if !db_path.exists() {
        return None;
    }

    let uri = format!(
        "file:{}?mode=ro&immutable=1",
        db_path.to_string_lossy().replace('?', "%3F")
    );
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()?;

    let raw: String = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let composers = parsed.get("allComposers")?.as_array()?;

    // 24h window — wide enough to keep the headline live across a full
    // workday gap, narrow enough that stale conversations don't dominate.
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64;
    let cutoff_ms = now_ms - 24 * 60 * 60 * 1000;

    // Walk composers once, tracking:
    //  - active_max_pct: highest contextUsagePercent among non-archived
    //    composers touched in the past 24h. This is the "live" headline.
    //  - active_count: how many composers are in that 24h window (used for
    //    the "X chats" detail line — counts every composer, including stubs
    //    without a context % yet, so the row reflects real activity).
    //  - fallback_pct: most recent non-archived composer that *has* a
    //    contextUsagePercent. Used as the headline when nothing's active in
    //    the last 24h, so the row keeps showing a meaningful number rather
    //    than disappearing between work sessions.
    //
    // When neither an active nor fallback % is available (Cursor is open but
    // hasn't populated context data yet, or every conversation is a stub),
    // we still return Some(...) with a null headline — the frontend renders
    // an explanatory hint in place of the bar so the row stays visible.
    let mut active_max_pct: Option<f64> = None;
    let mut active_count: u32 = 0;
    let mut fallback_pct: Option<f64> = None;
    let mut fallback_ts: i64 = 0;
    for c in composers {
        if c.get("isArchived")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        let last_updated = c
            .get("lastUpdatedAt")
            .and_then(|v| v.as_i64())
            .or_else(|| c.get("createdAt").and_then(|v| v.as_i64()))
            .unwrap_or(0);
        let ctx_pct = c.get("contextUsagePercent").and_then(|v| v.as_f64());

        if let Some(pct) = ctx_pct {
            if last_updated > fallback_ts {
                fallback_ts = last_updated;
                fallback_pct = Some(pct);
            }
            if last_updated >= cutoff_ms {
                active_max_pct = Some(active_max_pct.map_or(pct, |prev| prev.max(pct)));
            }
        }

        if last_updated >= cutoff_ms {
            active_count += 1;
        }
    }

    let headline_pct: Option<f64> = active_max_pct.or(fallback_pct);

    // Cursor's billing tier label, when we can read it. Stored alongside
    // OAuth state in ItemTable as the `cursorAuth/stripeMembershipType` key.
    let plan: Option<String> = conn
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/stripeMembershipType'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .map(|s| s.trim_matches('"').to_string())
        .filter(|s| !s.is_empty() && s != "null");

    // Web snapshot fills in fields the local DB can't see — real plan
    // utilization, billing-cycle reset, on-demand spend. But on free / hobby
    // tiers cursor.com returns no plan allowance (plan_pct = None, no
    // billing_cycle_end), so a blind override would replace the SQLite
    // composer-context % with a literal "no data" row. We adopt the web
    // headline only when it carries an actual `plan_pct`; otherwise we keep
    // the SQLite path and just borrow the web's membership label, which is
    // more authoritative than the cached `cursorAuth/stripeMembershipType`.
    let web = if web_enabled {
        cursor_web::fetch()
    } else {
        None
    };
    let notice = if web_enabled && web.is_none() {
        cursor_web::missing_snapshot_notice()
    } else {
        None
    };

    let (five_hour, weekly, plan) = match web {
        Some(snap) if snap.plan_pct.is_some() => {
            let plan_window = UsageWindow {
                used_percent: snap.plan_pct,
                tokens: 0,
                cost_usd: (snap.plan_used_cents as f64) / 100.0,
                message_count: active_count,
                resets_at: snap.billing_cycle_end_unix,
                window_seconds: cursor_web::window_seconds_for(snap.billing_cycle_end_unix),
            };
            // On-demand spend % only makes sense when a cap is set. With no
            // cap we still report the dollar amount via `cost_usd` so the UI
            // can show "$X.YZ on demand" even without a bar.
            let on_demand_pct = snap.on_demand_limit_cents.and_then(|limit| {
                if limit == 0 {
                    None
                } else {
                    Some((snap.on_demand_used_cents as f64 / limit as f64) * 100.0)
                }
            });
            let on_demand_window = UsageWindow {
                used_percent: on_demand_pct,
                tokens: 0,
                cost_usd: (snap.on_demand_used_cents as f64) / 100.0,
                message_count: 0,
                resets_at: snap.billing_cycle_end_unix,
                window_seconds: cursor_web::window_seconds_for(snap.billing_cycle_end_unix),
            };
            let plan_label = snap.membership_type.or(plan);
            (plan_window, on_demand_window, plan_label)
        }
        _ => {
            let five_hour = UsageWindow {
                used_percent: headline_pct,
                tokens: 0,
                cost_usd: 0.0,
                message_count: active_count,
                resets_at: None,
                // Reuse the field as a "the percent reflects activity in this
                // window" hint — 24h. The frontend doesn't tie window_seconds
                // to any reset countdown when resets_at is None, so this is
                // purely informational.
                window_seconds: 24 * 60 * 60,
            };
            // No weekly equivalent; leave it as a no-data window so the
            // frontend can render Cursor as a single-bar provider.
            let weekly = UsageWindow {
                used_percent: None,
                tokens: 0,
                cost_usd: 0.0,
                message_count: 0,
                resets_at: None,
                window_seconds: 7 * 24 * 60 * 60,
            };
            // Borrow the membership label from the web snapshot when we have
            // one — it's more authoritative than the cached SQLite value.
            let plan_label = web
                .as_ref()
                .and_then(|s| s.membership_type.clone())
                .or(plan);
            (five_hour, weekly, plan_label)
        }
    };

    Some(ProviderUsage {
        provider: "cursor".into(),
        plan,
        five_hour,
        weekly,
        notice,
        model_limits: Vec::new(),
    })
}

#[cfg(target_os = "macos")]
fn cursor_state_db() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join("Library")
            .join("Application Support")
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

#[cfg(target_os = "windows")]
fn cursor_state_db() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

#[cfg(target_os = "linux")]
fn cursor_state_db() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

/// Whether the Cursor application binary is installed at one of the standard
/// OS install locations. Used to suppress the dashboard's Cursor row for
/// users who don't have Cursor — even if leftover state from a prior install
/// is still present in their config dir.
fn cursor_installed() -> bool {
    cursor_install_paths().iter().any(|p| p.exists())
}

#[cfg(target_os = "macos")]
fn cursor_install_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("/Applications/Cursor.app")];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join("Applications").join("Cursor.app"));
    }
    paths
}

#[cfg(target_os = "windows")]
fn cursor_install_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    // Default per-user install (Cursor's Inno Setup installer drops here).
    if let Some(local) = dirs::data_local_dir() {
        paths.push(local.join("Programs").join("cursor").join("Cursor.exe"));
    }
    // Less common system-wide installs.
    for var in ["PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Ok(root) = std::env::var(var) {
            paths.push(PathBuf::from(&root).join("cursor").join("Cursor.exe"));
            paths.push(PathBuf::from(&root).join("Cursor").join("Cursor.exe"));
        }
    }
    paths
}

#[cfg(target_os = "linux")]
fn cursor_install_paths() -> Vec<PathBuf> {
    // Covers distro packages, manual /opt installs, and Snap. AppImages live
    // wherever the user dropped them so we can't enumerate those reliably —
    // anyone running Cursor as an AppImage will likely also have a desktop
    // launcher pointing at one of these standard binary paths.
    vec![
        PathBuf::from("/usr/bin/cursor"),
        PathBuf::from("/usr/local/bin/cursor"),
        PathBuf::from("/opt/cursor/cursor"),
        PathBuf::from("/opt/Cursor/cursor"),
        PathBuf::from("/snap/bin/cursor"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Turning Claude Code off must skip its usage fetch entirely, so the
    /// Claude sign-in never leaves the machine. (Disabled Codex / Cursor still
    /// read their local files, which callers filter out; only the network
    /// paths are gated.)
    #[test]
    fn disabled_claude_is_not_collected() {
        let agents = AgentSources {
            claude_code: false,
            codex: false,
            cursor: false,
            cursor_web: true,
            initialized: true,
        };
        let limits = collect(&agents, false);
        assert!(limits.providers.iter().all(|p| p.provider != "claude"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn security_quote_escapes_quotes_and_backslashes() {
        assert_eq!(security_quote(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        assert_eq!(security_quote("it's"), r#""it's""#);
    }

    fn codex_window(used_percent: f64, resets_at: Option<i64>) -> CodexWindow {
        CodexWindow {
            used_percent,
            window_seconds: Some(18_000),
            resets_at,
        }
    }

    #[test]
    fn codex_window_past_its_reset_reads_as_fresh() {
        let now = Utc::now().timestamp();
        let p = codex_provider(
            Some("plus".into()),
            Some(codex_window(40.0, Some(now - 60))),
            Some(codex_window(12.0, Some(now + 3600))),
        );
        assert_eq!(p.five_hour.used_percent, Some(0.0));
        assert_eq!(p.five_hour.resets_at, None);
        assert_eq!(p.five_hour.window_seconds, 18_000);
        assert_eq!(p.weekly.used_percent, Some(12.0));
        assert_eq!(p.weekly.resets_at, Some(now + 3600));
    }

    #[test]
    fn codex_without_windows_falls_back_to_default_lengths() {
        let p = codex_provider(None, None, None);
        assert_eq!(p.five_hour.window_seconds, 5 * 60 * 60);
        assert_eq!(p.weekly.window_seconds, 7 * 24 * 60 * 60);
        assert_eq!(p.weekly.used_percent, Some(0.0));
    }

    const NOW: i64 = 1_800_000_000;

    fn usage(reset_in: i64) -> RemoteUsage {
        RemoteUsage {
            five_hour_pct: 42.0,
            five_hour_reset: Some(NOW + reset_in),
            seven_day_pct: 11.0,
            seven_day_reset: Some(NOW + 3 * 24 * 60 * 60),
            scoped: Vec::new(),
        }
    }

    /// A successful entry fetched `age` seconds ago, with the newest local
    /// JSONL write recorded at that same moment.
    fn entry(age: i64) -> CacheEntry {
        CacheEntry {
            version: CACHE_VERSION,
            fetched_unix: NOW - age,
            expires_unix: NOW - age + SUCCESS_TTL.as_secs() as i64,
            value: Some(usage(60 * 60)),
            failure: None,
            local_mtime_unix: Some(NOW - age),
        }
    }

    #[test]
    fn parses_fable_weekly_scoped_limit() {
        let body: UsageResponse = serde_json::from_str(
            r#"{
                "five_hour": { "utilization": 9.0, "resets_at": null },
                "seven_day": { "utilization": 68.0, "resets_at": null },
                "seven_day_opus": null,
                "seven_day_sonnet": null,
                "limits": [
                    { "kind": "session", "group": "session", "percent": 9,
                      "severity": "normal", "is_active": false, "scope": null },
                    { "kind": "weekly_all", "group": "weekly", "percent": 68,
                      "severity": "normal", "is_active": false, "scope": null },
                    { "kind": "weekly_scoped", "group": "weekly", "percent": 100,
                      "severity": "critical", "is_active": true,
                      "resets_at": "2026-09-19T09:00:00Z",
                      "scope": { "model": { "id": null, "display_name": "Fable" } } },
                    { "kind": "weekly_scoped", "percent": 12, "scope": null }
                ]
            }"#,
        )
        .unwrap();
        let scoped = parse_scoped_limits(&body.limits);
        // session / weekly_all duplicate the flat buckets; the model-less
        // scoped entry has nothing to label, so it's dropped.
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].model, "Fable");
        assert_eq!(scoped[0].pct, 100.0);
        assert!(scoped[0].is_active);
        assert_eq!(scoped[0].reset, parse_iso_secs("2026-09-19T09:00:00Z"));
    }

    #[test]
    fn response_without_limits_still_parses() {
        let body: UsageResponse = serde_json::from_str(
            r#"{ "five_hour": { "utilization": 1.0, "resets_at": null },
                 "seven_day": { "utilization": 2.0, "resets_at": null } }"#,
        )
        .unwrap();
        assert!(parse_scoped_limits(&body.limits).is_empty());
    }

    #[test]
    fn old_disk_cache_without_scoped_still_loads() {
        let u: RemoteUsage = serde_json::from_str(
            r#"{ "five_hour_pct": 1.0, "five_hour_reset": null,
                 "seven_day_pct": 2.0, "seven_day_reset": null }"#,
        )
        .unwrap();
        assert!(u.scoped.is_empty());
    }

    #[test]
    fn scoped_limit_sums_local_spend_for_its_family() {
        let mut by_model = HashMap::new();
        let mut fable = WindowAcc::default();
        fable.input = 1_000;
        fable.cost = 2.5;
        fable.messages = 3;
        let mut fable_1 = WindowAcc::default();
        fable_1.output = 500;
        fable_1.cost = 1.0;
        fable_1.messages = 2;
        let mut opus = WindowAcc::default();
        opus.input = 9_999;
        opus.cost = 9.0;
        opus.messages = 9;
        by_model.insert("claude-fable-5".to_string(), fable);
        by_model.insert("claude-fable-5-1".to_string(), fable_1);
        by_model.insert("claude-opus-5-5".to_string(), opus);
        let limit = scoped_model_limit(
            &RemoteScopedLimit {
                model: "Fable".into(),
                pct: 43.0,
                reset: Some(NOW),
                is_active: false,
            },
            &by_model,
        );
        assert_eq!(limit.model, "Fable");
        assert_eq!(limit.window.used_percent, Some(43.0));
        assert_eq!(limit.window.tokens, 1_500);
        assert_eq!(limit.window.message_count, 5);
        assert!((limit.window.cost_usd - 3.5).abs() < 1e-9);
        assert_eq!(limit.window.resets_at, Some(NOW));
    }

    /// A per-model cap rolling over invalidates the cache the same way the
    /// 5h / weekly windows do — otherwise a spent Fable bar would sit at
    /// 100% past its reset.
    #[test]
    fn refetches_when_a_scoped_limit_has_reset() {
        let mut e = entry(10);
        if let Some(u) = e.value.as_mut() {
            u.scoped.push(RemoteScopedLimit {
                model: "Fable".into(),
                pct: 100.0,
                reset: Some(NOW - 1),
                is_active: true,
            });
        }
        assert!(!serve_cached(&e, NOW, Some(NOW - 1)));
    }

    #[test]
    fn serves_within_ttl() {
        assert!(serve_cached(&entry(10), NOW, Some(NOW - 1)));
    }

    /// The regression this whole cache rework is about: with an active session
    /// writing JSONL, an expired entry must NOT be served — that's what pinned
    /// the menu-bar percentage for a quarter of an hour.
    #[test]
    fn refetches_past_ttl_when_local_activity_is_newer() {
        let stale = entry(SUCCESS_TTL.as_secs() as i64 + 5);
        assert!(!serve_cached(&stale, NOW, Some(NOW)));
    }

    /// Idle machine: TTL is up but nothing new was written locally, so the
    /// percentage cannot have moved here. Keep the cached value rather than
    /// re-pinging a rate-limited endpoint.
    #[test]
    fn extends_past_ttl_while_idle() {
        let idle = entry(SUCCESS_TTL.as_secs() as i64 + 5);
        let mtime = idle.local_mtime_unix;
        assert!(serve_cached(&idle, NOW, mtime));
    }

    /// ...but not forever — the cap is what lets usage from another machine on
    /// the same account eventually surface.
    #[test]
    fn extension_stops_at_cap() {
        let old = entry(MTIME_EXTENSION_CAP_SECS + 1);
        let mtime = old.local_mtime_unix;
        assert!(!serve_cached(&old, NOW, mtime));
    }

    /// A failure entry rides its backoff TTL but is never extended — otherwise
    /// a 429 during an idle stretch would suppress recovery for the whole cap.
    #[test]
    fn failures_are_not_extended() {
        let mut failed = entry(SUCCESS_TTL.as_secs() as i64 + 5);
        failed.value = None;
        failed.failure = Some(FailureKind::RateLimited);
        let mtime = failed.local_mtime_unix;
        assert!(!serve_cached(&failed, NOW, mtime));
    }

    /// An entry from an older build (no `version`, so 0) is refetched even
    /// inside its TTL: it can't carry fields that build didn't know about.
    #[test]
    fn older_build_entry_forces_refetch() {
        let mut old = entry(1);
        old.version = 0;
        assert!(!serve_cached(&old, NOW, Some(NOW - 1)));
    }

    /// ...but a live 429 backoff is honored whichever build recorded it.
    #[test]
    fn older_build_backoff_still_honored() {
        let mut old = entry(1);
        old.version = 0;
        old.failure = Some(FailureKind::RateLimited);
        assert!(serve_cached(&old, NOW, Some(NOW - 1)));
    }

    #[test]
    fn pre_version_disk_entry_parses_as_version_zero() {
        let e: CacheEntry = serde_json::from_str(
            r#"{ "fetched_unix": 1, "expires_unix": 2, "value": null,
                 "failure": null, "local_mtime_unix": null }"#,
        )
        .unwrap();
        assert_eq!(e.version, 0);
    }

    /// A passed reset window beats both the TTL and the extension: the cached
    /// percentages describe the window that just rolled over.
    #[test]
    fn reset_window_forces_refetch() {
        let mut fresh = entry(1);
        fresh.value = Some(usage(-1));
        assert!(!serve_cached(&fresh, NOW, Some(NOW - 1)));
    }

    /// Wall-clock TTLs survive a suspend: an entry written before a three-hour
    /// nap is expired on wake, where the old monotonic `Instant` clock (which
    /// stops during macOS sleep) would have called it seconds old.
    #[test]
    fn sleep_expires_the_entry() {
        let before_sleep = entry(3 * 60 * 60);
        assert!(!serve_cached(&before_sleep, NOW, Some(NOW)));
    }

    /// The clobber that turns one 429 into several: a fetch already in flight
    /// when the backoff landed comes back successful and, being newer, would
    /// reset the clock and resume polling inside the closed window.
    #[test]
    fn success_during_live_backoff_keeps_the_retry_deadline() {
        let mut backoff = entry(10);
        backoff.value = None;
        backoff.failure = Some(FailureKind::RateLimited);
        backoff.expires_unix = NOW + 800;

        let merged = keep_live_backoff(entry(0), Some(&backoff), NOW);

        assert_eq!(merged.expires_unix, backoff.expires_unix, "kept the deadline");
        assert!(merged.value.is_some(), "kept the fresh percentages");
        assert!(matches!(merged.failure, Some(FailureKind::RateLimited)));
    }

    #[test]
    fn expired_backoff_does_not_hold_back_a_success() {
        let mut expired = entry(10);
        expired.value = None;
        expired.failure = Some(FailureKind::RateLimited);
        expired.expires_unix = NOW - 1;

        let fresh = entry(0);
        let merged = keep_live_backoff(fresh.clone(), Some(&expired), NOW);

        assert_eq!(merged.expires_unix, fresh.expires_unix);
        assert!(merged.failure.is_none());
    }

    /// A window rolling over is not permission to disobey a server backoff —
    /// and this combination is reachable, because `keep_live_backoff` leaves
    /// successful entries carrying a RateLimited failure.
    #[test]
    fn live_backoff_outranks_an_elapsed_reset_window() {
        let mut e = entry(1);
        e.value = Some(usage(-1)); // 5h window already reset
        e.failure = Some(FailureKind::RateLimited);
        e.expires_unix = NOW + 600;
        assert!(serve_cached(&e, NOW, Some(NOW)));
    }

    #[test]
    fn lease_is_exclusive_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-fetch.lock");

        assert!(FetchLease::claim(&path).unwrap(), "first caller wins");
        assert!(!FetchLease::claim(&path).unwrap(), "second caller backs off");

        std::fs::remove_file(&path).unwrap(); // what Drop does
        assert!(FetchLease::claim(&path).unwrap(), "free again after release");
    }

    /// A holder that crashed mid-fetch must not wedge the account's polling
    /// forever, so a lease older than `LEASE_TTL_SECS` is breakable.
    #[test]
    fn stale_lease_is_broken() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage-fetch.lock");
        assert!(FetchLease::claim(&path).unwrap());
        assert!(!FetchLease::claim(&path).unwrap());

        let aged = SystemTime::now() - Duration::from_secs(LEASE_TTL_SECS as u64 + 5);
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(aged)).unwrap();

        assert!(FetchLease::claim(&path).unwrap(), "abandoned lease is reclaimed");
    }

    #[test]
    fn cache_entry_round_trips_through_disk_format() {
        let e = entry(5);
        let raw = serde_json::to_string(&e).unwrap();
        let back: CacheEntry = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.fetched_unix, e.fetched_unix);
        assert_eq!(back.expires_unix, e.expires_unix);
        assert_eq!(back.local_mtime_unix, e.local_mtime_unix);
        assert_eq!(
            back.value.map(|u| u.five_hour_pct),
            e.value.map(|u| u.five_hour_pct)
        );
    }
}
