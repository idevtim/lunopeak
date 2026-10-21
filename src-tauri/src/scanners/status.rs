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
//! We fetch all enabled providers in parallel (rayon) on every call, cache
//! the result for `STATUS_TTL` so the dashboard's polling cadence doesn't
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

struct CacheEntry {
    fetched_at: Instant,
    list: ProviderStatusList,
}

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// Returns the current status for each requested provider. `enabled_ids`
/// gates the parallel fan-out so users who've disabled e.g. Cursor don't
/// pay the network round-trip for its status page.
pub fn collect(enabled_ids: &[&str]) -> ProviderStatusList {
    if let Ok(guard) = CACHE.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < STATUS_TTL {
                // Filter the cached snapshot to only the providers the caller
                // currently wants. We don't re-fetch when the gate set
                // changes; the cache always holds the union and we slice
                // here. Cheap and avoids cache thrash when the user toggles.
                return ProviderStatusList {
                    providers: entry
                        .list
                        .providers
                        .iter()
                        .filter(|p| enabled_ids.contains(&p.provider.as_str()))
                        .cloned()
                        .collect(),
                };
            }
        }
    }

    let providers: Vec<ProviderStatus> = PROVIDERS.par_iter().map(|p| fetch_one(p)).collect();
    let list = ProviderStatusList { providers };

    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(CacheEntry {
            fetched_at: Instant::now(),
            list: list.clone(),
        });
    }

    ProviderStatusList {
        providers: list
            .providers
            .into_iter()
            .filter(|p| enabled_ids.contains(&p.provider.as_str()))
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
