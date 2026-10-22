//! Per-session scan of Codex CLI rollouts at ~/.codex/sessions/YYYY/MM/DD/
//! rollout-*.jsonl (plain, or zstd-compressed `.jsonl.zst` since Codex 0.163
//! migrated its history to the paginated store). Parses each file into the shared `Session` struct so the
//! existing aggregations (`sessions::costs`, `sessions::stats`, …) can fold
//! Codex usage in alongside Claude Code without separate code paths.
//!
//! Cost is estimated against OpenAI list prices via `pricing::openai_cost_of`.
//! As with the Claude side, this is a list-price estimate — actual billing
//! under a Plus / Team subscription is a flat monthly fee.

use crate::models::{Session, TokenUsage};
use crate::pricing;
use anyhow::Result;
use chrono::{DateTime, Local, Utc};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

fn sessions_root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

const ZST_SUFFIX: &str = ".jsonl.zst";

/// A Codex rollout, in either on-disk form. Codex 0.163 rewrote every
/// existing rollout as `rollout-*.jsonl.zst`; the line format inside is
/// unchanged. Shared by the live, usage and session scanners.
pub(crate) fn is_rollout(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.ends_with(".jsonl") || name.ends_with(ZST_SUFFIX)
}

fn is_compressed(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.ends_with(ZST_SUFFIX))
}

/// The `.jsonl` path a rollout is known by regardless of compression, so a
/// file caught mid-recompression (both forms briefly on disk) counts once.
fn rollout_key(path: &Path) -> PathBuf {
    match path.to_str().and_then(|s| s.strip_suffix(".zst")) {
        Some(plain) if is_compressed(path) => PathBuf::from(plain),
        _ => path.to_path_buf(),
    }
}

/// Line reader over a rollout. Compressed files are decoded into memory —
/// they're tens of KB on disk and a few MB at most expanded.
pub(crate) fn open_rollout(path: &Path) -> Option<Box<dyn BufRead>> {
    if !is_compressed(path) {
        return Some(Box::new(BufReader::new(File::open(path).ok()?)));
    }
    let mut raw = Vec::new();
    File::open(path).ok()?.read_to_end(&mut raw).ok()?;
    Some(Box::new(Cursor::new(decode_zstd(&raw)?)))
}

/// Decodes every frame in `raw`. A frame that fails part-way (a file being
/// written as we read it) keeps whatever decoded before the error.
fn decode_zstd(raw: &[u8]) -> Option<Vec<u8>> {
    let mut src = raw;
    let mut out = Vec::new();
    while !src.is_empty() {
        let Ok(mut frame) = ruzstd::decoding::StreamingDecoder::new(&mut src) else {
            break;
        };
        if frame.read_to_end(&mut out).is_err() {
            break;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Every rollout under `root` with its mtime. When both forms of one rollout
/// exist, the newer file wins.
pub(crate) fn rollout_files(root: &Path) -> Vec<(PathBuf, SystemTime)> {
    let mut by_key: HashMap<PathBuf, (PathBuf, SystemTime)> = HashMap::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() || !is_rollout(entry.path()) {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let path = entry.into_path();
        let key = rollout_key(&path);
        match by_key.get(&key) {
            Some((_, seen)) if *seen >= mtime => {}
            _ => {
                by_key.insert(key, (path, mtime));
            }
        }
    }
    by_key.into_values().collect()
}

#[derive(Default, Clone)]
pub struct Cache {
    entries: Arc<Mutex<HashMap<PathBuf, CacheEntry>>>,
}

struct CacheEntry {
    mtime: SystemTime,
    session: Session,
}

impl Cache {
    pub fn new() -> Self {
        Self::default()
    }
}

pub fn scan_all(cache: &Cache) -> Result<Vec<Session>> {
    let Some(root) = sessions_root() else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    let current = rollout_files(&root);

    let mut entries = cache.entries.lock().unwrap();
    let live: std::collections::HashSet<&PathBuf> = current.iter().map(|(p, _)| p).collect();
    entries.retain(|p, _| live.contains(p));

    let mut sessions = Vec::with_capacity(current.len());
    for (path, mtime) in current {
        let needs_parse = match entries.get(&path) {
            Some(e) => e.mtime != mtime,
            None => true,
        };
        if needs_parse {
            if let Some(session) = parse_rollout(&path) {
                entries.insert(
                    path.clone(),
                    CacheEntry {
                        mtime,
                        session: session.clone(),
                    },
                );
                sessions.push(session);
            }
        } else if let Some(e) = entries.get(&path) {
            sessions.push(e.session.clone());
        }
    }

    Ok(sessions)
}

fn parse_rollout(path: &Path) -> Option<Session> {
    let reader = open_rollout(path)?;

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut model: Option<String> = None;
    let mut start_ts: Option<i64> = None;
    let mut end_ts: Option<i64> = None;
    // Cumulative token totals from the LAST `event_msg` / `token_count`
    // line that carried a non-null `info.total_token_usage`. Codex
    // accumulates across the session, so the last record is the final total.
    let mut total_input: u64 = 0;
    let mut total_cached_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut messages: u32 = 0;

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };

        let ts = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ts);
        if let Some(t) = ts {
            start_ts = Some(start_ts.map_or(t, |s| s.min(t)));
            end_ts = Some(end_ts.map_or(t, |e| e.max(t)));
        }

        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = value.get("payload");

        match kind {
            "session_meta" => {
                if let Some(p) = payload {
                    if session_id.is_none() {
                        session_id = p.get("id").and_then(|v| v.as_str()).map(str::to_string);
                    }
                    if cwd.is_none() {
                        cwd = p.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
                    }
                }
            }
            "turn_context" => {
                // Per-turn context carries the active model. Take the last
                // value we see — if the user switched models mid-session,
                // the most recent one is the better single-label answer.
                if let Some(m) = payload
                    .and_then(|p| p.get("model"))
                    .and_then(|v| v.as_str())
                {
                    model = Some(m.to_string());
                }
            }
            "event_msg" => {
                let Some(p) = payload else { continue };
                if p.get("type").and_then(|v| v.as_str()) != Some("token_count") {
                    continue;
                }
                let Some(info) = p.get("info").filter(|v| !v.is_null()) else {
                    continue;
                };
                if let Some(total) = info.get("total_token_usage") {
                    let input = total
                        .get("input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let cached = total
                        .get("cached_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    let output = total
                        .get("output_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    total_input = input;
                    total_cached_input = cached;
                    total_output = output;
                }
                // Each token_count event corresponds to one assistant turn.
                messages = messages.saturating_add(1);
            }
            _ => {}
        }
    }

    let session_id = session_id.or_else(|| {
        rollout_key(path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
    })?;

    // Codex reports input_tokens as the full prompt size, with cached_input
    // a subset. Split into uncached vs cached so pricing applies the right
    // rate to each bucket.
    let uncached_input = total_input.saturating_sub(total_cached_input);
    let usage = TokenUsage {
        input: uncached_input,
        output: total_output,
        cache_read: total_cached_input,
        cache_creation: 0,
        cache_creation_1h: 0,
    };
    // Rates are pinned to when the session ran, not to today — OpenAI cut
    // Terra / Luna pricing on 2026-07-30 and older sessions still cost what
    // they cost. Codex gives us one cumulative total per session, so the
    // session's start is the only timestamp there is to price against.
    let cost = pricing::openai_cost_of(
        model.as_deref().unwrap_or("gpt-5"),
        &usage,
        start_ts.or(end_ts),
    );

    // Codex only exposes cumulative token totals (one cost for the whole
    // session), so unlike the Claude scanner we can't attribute spend per
    // message. Pin it to the session's start day — matching the previous
    // start_ts bucketing — so Codex still shows up in the day/today cost
    // buckets that now read `cost_by_day`.
    let mut cost_by_day = std::collections::BTreeMap::new();
    if cost > 0.0 {
        let ts = start_ts.or(end_ts).unwrap_or(0);
        if let Some(date) = DateTime::<Utc>::from_timestamp_millis(ts)
            .map(|dt| dt.with_timezone(&Local).date_naive())
        {
            cost_by_day.insert(date, cost);
        }
    }

    Some(Session {
        id: session_id,
        project_name: cwd.as_deref().and_then(|p| {
            Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        }),
        project_path: cwd,
        branch: None,
        model,
        start_ts: start_ts.unwrap_or(0),
        end_ts: end_ts.unwrap_or(0),
        message_count: messages,
        first_prompt: None,
        usage,
        cost_usd: cost,
        cost_by_day,
        subagent_count: 0,
        subagent_cost_usd: 0.0,
        tool_uses: Default::default(),
        tool_errors: 0,
        tool_errors_by_name: Default::default(),
        tool_sequences: Default::default(),
        files_edited: Default::default(),
        bash_commands: Default::default(),
    })
}

fn parse_iso_ts(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ruzstd::encoding::{compress_to_vec, CompressionLevel};
    use std::time::Duration;

    const ROLLOUT: &str = concat!(
        r#"{"timestamp":"2026-09-04T17:28:43Z","ordinal":0,"type":"session_meta","payload":{"id":"abc","cwd":"/work/repo"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T17:28:44Z","ordinal":1,"type":"turn_context","payload":{"model":"gpt-5.5-codex"}}"#,
        "\n",
        r#"{"timestamp":"2026-09-04T17:29:45Z","ordinal":2,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}"#,
        "\n",
    );

    fn zst(text: &str) -> Vec<u8> {
        compress_to_vec(text.as_bytes(), CompressionLevel::Fastest)
    }

    #[test]
    fn recognises_both_rollout_forms() {
        assert!(is_rollout(Path::new("/s/rollout-1.jsonl")));
        assert!(is_rollout(Path::new("/s/rollout-1.jsonl.zst")));
        assert!(!is_rollout(Path::new("/s/rollout-1.json")));
        assert!(!is_rollout(Path::new("/s/notes.zst")));
        assert_eq!(
            rollout_key(Path::new("/s/rollout-1.jsonl.zst")),
            PathBuf::from("/s/rollout-1.jsonl")
        );
    }

    #[test]
    fn compressed_rollout_parses_like_plain() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("rollout-a.jsonl");
        let packed = dir.path().join("rollout-b.jsonl.zst");
        std::fs::write(&plain, ROLLOUT).unwrap();
        std::fs::write(&packed, zst(ROLLOUT)).unwrap();

        let a = parse_rollout(&plain).unwrap();
        let b = parse_rollout(&packed).unwrap();
        assert_eq!(b.id, "abc");
        assert_eq!(b.model.as_deref(), Some("gpt-5.5-codex"));
        assert_eq!((b.usage.input, b.usage.cache_read, b.usage.output), (600, 400, 50));
        assert_eq!(a.usage.input, b.usage.input);
        assert_eq!(a.message_count, b.message_count);
    }

    #[test]
    fn decodes_every_frame_and_keeps_a_torn_tail() {
        let (head, tail) = ROLLOUT.split_at(ROLLOUT.find("\n").unwrap() + 1);
        let mut raw = zst(head);
        raw.extend(zst(tail));
        assert_eq!(decode_zstd(&raw).unwrap(), ROLLOUT.as_bytes());

        // A trailing frame still being written mustn't lose the frames before it.
        let mut torn = zst(head);
        let second = zst(tail);
        torn.extend(&second[..second.len() / 2]);
        assert!(decode_zstd(&torn).unwrap().starts_with(head.as_bytes()));
    }

    #[test]
    fn a_rollout_on_disk_in_both_forms_counts_once() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("rollout-a.jsonl");
        let packed = dir.path().join("rollout-a.jsonl.zst");
        std::fs::write(&plain, ROLLOUT).unwrap();
        std::fs::write(&packed, zst(ROLLOUT)).unwrap();
        let newer = SystemTime::now() + Duration::from_secs(60);
        File::options()
            .write(true)
            .open(&packed)
            .unwrap()
            .set_modified(newer)
            .unwrap();

        let files = rollout_files(dir.path());
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, packed);
    }
}
