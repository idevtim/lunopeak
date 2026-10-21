//! Provider service-status polling.
//!
//! Every AI agent we track (Claude, Codex/OpenAI, Cursor) exposes a public
//! Atlassian StatusPage at a well-known host, with two stable endpoints:
//!
//!   * `/api/v2/status.json` — rolled-up health summary
//!     `{ status: { indicator, description }, page: {…} }`
//!   * `/api/v2/incidents/unresolved.json` — open incidents
//!     `{ incidents: [{ name, status, impact, shortlink, started_at, updated_at }] }`
//!
//! We fetch only the enabled providers, in parallel (rayon), caching each
//! one for `STATUS_TTL` so the dashboard's polling cadence doesn't
//! hammer the StatusPage CDN, and fall back to an `"unknown"` indicator on
//! any error so a transient outage of *the status site* doesn't masquerade
//! as a green check.

use crate::models::{ProviderIncident, ProviderStatus, ProviderStatusList};
use chrono::Utc;
use rayon::prelude::*;
use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const STATUS_TTL: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

struct ProviderEndpoint {
    id: &'static str,
    /// Base URL with no trailing slash.
    base: &'static str,
    /// Path appended to `base` for the incidents fetch. Most Atlassian
    /// StatusPage installs serve `/api/v2/incidents/unresolved.json`, which
    /// pre-filters to open incidents. OpenAI's migrated page 404s on that
    /// path but serves `/api/v2/incidents.json` (all incidents, including
    /// resolved); we filter resolved entries out at parse time below.
    incidents_path: &'static str,
}

const ATLASSIAN_UNRESOLVED: &str = "/api/v2/incidents/unresolved.json";
const ATLASSIAN_ALL: &str = "/api/v2/incidents.json";

const PROVIDERS: &[ProviderEndpoint] = &[
    ProviderEndpoint {
        id: "claude",
        base: "https://status.claude.com",
        incidents_path: ATLASSIAN_UNRESOLVED,
    },
    ProviderEndpoint {
        id: "codex",
        base: "https://status.openai.com",
        incidents_path: ATLASSIAN_ALL,
    },
    ProviderEndpoint {
        id: "cursor",
        base: "https://status.cursor.com",
        incidents_path: ATLASSIAN_UNRESOLVED,
    },
];

/// Per-provider cache, so a provider is only ever fetched while it's enabled
/// and toggling one on doesn't refetch the others.
static CACHE: Mutex<Vec<(Instant, ProviderStatus)>> = Mutex::new(Vec::new());

/// Endpoints that need a network round-trip: enabled, and with no cache entry
/// younger than `STATUS_TTL`. Disabled providers are never returned, so their
/// status page is never contacted.
fn endpoints_to_fetch(
    enabled_ids: &[&str],
    is_fresh: impl Fn(&str) -> bool,
) -> Vec<&'static ProviderEndpoint> {
    PROVIDERS
        .iter()
        .filter(|p| enabled_ids.contains(&p.id) && !is_fresh(p.id))
        .collect()
}

/// Returns the current status for each enabled provider, in `PROVIDERS` order.
/// Only enabled providers are fetched — users who've disabled e.g. Cursor never
/// pay (or reveal) the round-trip to its status page.
pub fn collect(enabled_ids: &[&str]) -> ProviderStatusList {
    let is_fresh = |cache: &[(Instant, ProviderStatus)], id: &str| {
        cache
            .iter()
            .any(|(at, s)| s.provider == id && at.elapsed() < STATUS_TTL)
    };

    let stale = match CACHE.lock() {
        Ok(guard) => endpoints_to_fetch(enabled_ids, |id| is_fresh(&guard, id)),
        Err(_) => endpoints_to_fetch(enabled_ids, |_| false),
    };
    let fetched: Vec<ProviderStatus> = stale.par_iter().map(|p| fetch_one(p)).collect();

    let mut cache = match CACHE.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return ProviderStatusList { providers: fetched };
        }
    };
    let now = Instant::now();
    for status in fetched {
        cache.retain(|(_, s)| s.provider != status.provider);
        cache.push((now, status));
    }

    ProviderStatusList {
        providers: PROVIDERS
            .iter()
            .filter(|p| enabled_ids.contains(&p.id))
            .filter_map(|p| cache.iter().find(|(_, s)| s.provider == p.id))
            .map(|(_, s)| s.clone())
            .collect(),
    }
}

fn fetch_one(endpoint: &ProviderEndpoint) -> ProviderStatus {
    let now = Utc::now().timestamp();
    let client = match reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("LunoPeak")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            crate::elog!(error, "status", "client build failed for {}: {e}", endpoint.id);
            return unknown(endpoint.id, now);
        }
    };

    let status_url = format!("{}/api/v2/status.json", endpoint.base);
    let incidents_url = format!("{}{}", endpoint.base, endpoint.incidents_path);

    let summary: StatusSummary = match client.get(&status_url).send().and_then(|r| r.json()) {
        Ok(s) => s,
        Err(e) => {
            crate::elog!(error, "status", "{} status fetch failed: {e}", endpoint.id);
            return unknown(endpoint.id, now);
        }
    };

    // Incidents fetch is best-effort: a status page that returns the summary
    // fine but errors on incidents (rare but possible) shouldn't demote the
    // indicator from green to unknown. We also exclude `resolved` /
    // `postmortem` entries — relevant when the provider's incidents endpoint
    // returns the full history rather than just open ones (e.g. OpenAI).
    let incidents = match client
        .get(&incidents_url)
        .send()
        .and_then(|r| r.json::<IncidentList>())
    {
        Ok(list) => list
            .incidents
            .into_iter()
            .filter(|i| i.status != "resolved" && i.status != "postmortem")
            .map(map_incident)
            .collect(),
        Err(e) => {
            crate::elog!(error, "status", "{} incidents fetch failed: {e}", endpoint.id);
            Vec::new()
        }
    };

    ProviderStatus {
        provider: endpoint.id.to_string(),
        indicator: summary.status.indicator,
        description: summary.status.description,
        incidents,
        fetched_at: now,
    }
}

fn unknown(id: &str, now: i64) -> ProviderStatus {
    ProviderStatus {
        provider: id.to_string(),
        indicator: "unknown".into(),
        description: "Status unavailable".into(),
        incidents: Vec::new(),
        fetched_at: now,
    }
}

fn map_incident(raw: RawIncident) -> ProviderIncident {
    ProviderIncident {
        name: raw.name,
        status: raw.status,
        // Standard Atlassian responses always set `impact`; OpenAI's migrated
        // schema sometimes omits it. Default to "none" so the UI still has a
        // valid value to dispatch on rather than choking on a missing field.
        impact: raw.impact.unwrap_or_else(|| "none".to_string()),
        url: raw.shortlink.unwrap_or_default(),
        started_at: raw
            .started_at
            .or(raw.created_at)
            .as_deref()
            .and_then(parse_iso_secs),
        updated_at: raw.updated_at.as_deref().and_then(parse_iso_secs),
    }
}

fn parse_iso_secs(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp())
}

#[derive(Debug, Deserialize)]
struct StatusSummary {
    status: SummaryBlock,
}

#[derive(Debug, Deserialize)]
struct SummaryBlock {
    indicator: String,
    description: String,
}

#[derive(Debug, Deserialize)]
struct IncidentList {
    incidents: Vec<RawIncident>,
}

#[derive(Debug, Deserialize)]
struct RawIncident {
    name: String,
    status: String,
    /// Optional because OpenAI's migrated incidents schema omits it.
    impact: Option<String>,
    shortlink: Option<String>,
    /// Standard Atlassian payloads carry both `started_at` and `created_at`.
    /// OpenAI's migrated schema omits `started_at` and only sets `created_at`.
    /// These must be two distinct fields — a serde `alias` collapses them into
    /// one, which then trips serde's duplicate-field check (and fails the whole
    /// decode as "error decoding response body") whenever both keys are present.
    /// `map_incident` prefers `started_at` and falls back to `created_at`.
    started_at: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(endpoints: Vec<&'static ProviderEndpoint>) -> Vec<&'static str> {
        endpoints.into_iter().map(|p| p.id).collect()
    }

    #[test]
    fn disabled_providers_are_never_fetched() {
        assert_eq!(ids(endpoints_to_fetch(&["claude"], |_| false)), vec!["claude"]);
        assert!(endpoints_to_fetch(&[], |_| false).is_empty());
    }

    #[test]
    fn fresh_providers_are_not_refetched() {
        let fetch = endpoints_to_fetch(&["claude", "codex", "cursor"], |id| id == "codex");
        assert_eq!(ids(fetch), vec!["claude", "cursor"]);
    }

    /// Standard Atlassian payload: both `started_at` and `created_at` present.
    /// Regression for the serde `alias` that collapsed them into one field and
    /// failed the decode with "duplicate field" whenever a live incident
    /// carried both keys (Claude / Cursor status pages).
    #[test]
    fn decodes_incident_with_both_started_and_created_at() {
        let json = r#"{
            "incidents": [{
                "name": "We've suspended access to a model",
                "status": "monitoring",
                "impact": "critical",
                "shortlink": "https://stspg.io/abc",
                "started_at": "2026-06-13T00:50:43.823Z",
                "created_at": "2026-06-13T00:50:43.835Z",
                "updated_at": "2026-06-13T01:00:00.000Z",
                "incident_updates": []
            }]
        }"#;

        let list: IncidentList = serde_json::from_str(json).expect("payload should decode");
        let incident = map_incident(list.incidents.into_iter().next().unwrap());
        // `started_at` wins over `created_at`.
        assert_eq!(incident.started_at, parse_iso_secs("2026-06-13T00:50:43.823Z"));
    }

    /// OpenAI's migrated schema: only `created_at`, no `started_at`.
    #[test]
    fn decodes_incident_with_only_created_at() {
        let json = r#"{
            "incidents": [{
                "name": "Elevated errors",
                "status": "investigating",
                "created_at": "2026-06-13T00:50:43.835Z"
            }]
        }"#;

        let list: IncidentList = serde_json::from_str(json).expect("payload should decode");
        let incident = map_incident(list.incidents.into_iter().next().unwrap());
        assert_eq!(incident.started_at, parse_iso_secs("2026-06-13T00:50:43.835Z"));
        assert_eq!(incident.impact, "none");
    }
}
