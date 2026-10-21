use crate::models::{
    CommandEntry, CostBreakdown, CostBucket, CostTotals, DayBucket, ErrorEntry, FileEntry,
    ModelUsage, RepoCost, RepoCostDetail, SequenceEntry, Session, SessionDetail, SessionEvent,
    SessionStats, TokenUsage, ToolBreakdown, ToolStats, TranscriptMatch,
};
use crate::pricing;
use anyhow::Result;
use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDate, Timelike, Utc};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

// ── Cache ──────────────────────────────────────────────────────────────
//
// Parsing the JSONL is the expensive part of every session-related query.
// We keep a process-lifetime cache keyed by (path, mtime). On each scan we
// stat every .jsonl in ~/.claude/projects/* — cheap — and only re-parse
// files whose mtime changed (or were never seen). Files that no longer
// exist are evicted.

/// Clone is cheap — internally an Arc — so the cache can move into
/// `spawn_blocking` closures without giving up the shared state.
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

fn parse_session_file(path: &Path) -> Option<Session> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut start_ts: Option<i64> = None;
    let mut end_ts: Option<i64> = None;
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut model: Option<String> = None;
    let mut messages = 0u32;
    let mut usage = TokenUsage::default();
    let mut cost = 0.0_f64;
    let mut cost_by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    let mut first_prompt: Option<String> = None;
    let mut tool_uses: BTreeMap<String, u32> = BTreeMap::new();
    let mut tool_errors = 0u32;
    let mut tool_errors_by_name: BTreeMap<String, u32> = BTreeMap::new();
    let mut tool_sequences: BTreeMap<String, u32> = BTreeMap::new();
    let mut files_edited: BTreeMap<String, u32> = BTreeMap::new();
    let mut bash_commands: BTreeMap<String, u32> = BTreeMap::new();
    // Maps tool_use_id → tool_name so tool_result errors can be attributed
    // back to the tool that emitted them.
    let mut tool_use_index: HashMap<String, String> = HashMap::new();
    let mut prev_tool: Option<String> = None;

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };

        let timestamp = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ts);
        if let Some(ts) = timestamp {
            start_ts = Some(start_ts.map_or(ts, |s| s.min(ts)));
            end_ts = Some(end_ts.map_or(ts, |e| e.max(ts)));
        }
        if cwd.is_none() {
            cwd = value
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if branch.is_none() {
            branch = value
                .get("gitBranch")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }

        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "user" || kind == "assistant" {
            messages += 1;
        }

        if kind == "user" && first_prompt.is_none() {
            if let Some(text) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(extract_first_user_text)
            {
                first_prompt = Some(text);
            }
        }

        if kind == "assistant" {
            let msg = value.get("message");
            if model.is_none() {
                model = msg
                    .and_then(|m| m.get("model"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
            }
            if let Some(u) = msg.and_then(|m| m.get("usage")) {
                let turn = TokenUsage {
                    input: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    output: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                    cache_read: u
                        .get("cache_read_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_creation: u
                        .get("cache_creation_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                    cache_creation_1h: u
                        .get("cache_creation")
                        .and_then(|c| c.get("ephemeral_1h_input_tokens"))
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0),
                };
                if let Some(m) = msg.and_then(|m| m.get("model")).and_then(|v| v.as_str()) {
                    let turn_cost = pricing::cost_of(m, &turn, timestamp.or(start_ts));
                    cost += turn_cost;
                    // Attribute this message's spend to the local day it
                    // happened on, so a midnight-crossing or resumed session
                    // doesn't dump its whole cost on `start_ts`. Fall back to
                    // the session's first-seen day if a line lacks a timestamp.
                    if let Some(day) = timestamp.or(start_ts).and_then(millis_to_local_date) {
                        *cost_by_day.entry(day).or_insert(0.0) += turn_cost;
                    }
                }
                usage.input += turn.input;
                usage.output += turn.output;
                usage.cache_read += turn.cache_read;
                usage.cache_creation += turn.cache_creation;
                usage.cache_creation_1h += turn.cache_creation_1h;
            }
            if let Some(blocks) = msg
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in blocks {
                    let bty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if bty != "tool_use" {
                        continue;
                    }
                    let Some(name) = block.get("name").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    *tool_uses.entry(name.to_string()).or_insert(0) += 1;

                    if let Some(id) = block.get("id").and_then(|v| v.as_str()) {
                        tool_use_index.insert(id.to_string(), name.to_string());
                    }

                    if let Some(prev) = &prev_tool {
                        let key = format!("{prev}\u{2192}{name}");
                        *tool_sequences.entry(key).or_insert(0) += 1;
                    }
                    prev_tool = Some(name.to_string());

                    let input = block.get("input");
                    match name {
                        "Edit" | "Write" | "NotebookEdit" => {
                            if let Some(fp) = input
                                .and_then(|i| i.get("file_path"))
                                .and_then(|v| v.as_str())
                            {
                                *files_edited.entry(fp.to_string()).or_insert(0) += 1;
                            }
                        }
                        "Bash" => {
                            if let Some(cmd) = input
                                .and_then(|i| i.get("command"))
                                .and_then(|v| v.as_str())
                            {
                                if let Some(first) = first_token(cmd) {
                                    *bash_commands.entry(first).or_insert(0) += 1;
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        } else if kind == "user" {
            // Tool results come back as user-role content blocks with type=tool_result.
            if let Some(blocks) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array())
            {
                for block in blocks {
                    if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                        continue;
                    }
                    let is_error = block
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !is_error {
                        continue;
                    }
                    tool_errors += 1;
                    let id = block.get("tool_use_id").and_then(|v| v.as_str());
                    if let Some(id) = id {
                        if let Some(tool_name) = tool_use_index.get(id) {
                            *tool_errors_by_name.entry(tool_name.clone()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }

    let session_id =
        session_id.or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;

    Some(Session {
        id: session_id,
        project_name: cwd.as_deref().and_then(|p| {
            Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        }),
        project_path: cwd,
        branch,
        model,
        start_ts: start_ts.unwrap_or(0),
        end_ts: end_ts.unwrap_or(0),
        message_count: messages,
        first_prompt,
        usage,
        cost_usd: cost,
        cost_by_day,
        tool_uses,
        tool_errors,
        tool_errors_by_name,
        tool_sequences,
        files_edited,
        bash_commands,
    })
}

/// Splits a Bash command string into the first meaningful token. Drops common
/// shell prefixes like `sudo`, env-var assignments, and noisy redirections so
/// `npm run build` and `sudo npm run build` both bucket as `npm`.
fn first_token(cmd: &str) -> Option<String> {
    for raw in cmd.split_whitespace() {
        // Skip env-var assignments: FOO=bar
        if raw.contains('=') && !raw.starts_with('-') {
            continue;
        }
        // Skip common prepended commands.
        if matches!(raw, "sudo" | "time" | "nice" | "ionice" | "env") {
            continue;
        }
        return Some(raw.to_string());
    }
    None
}

/// Extracts the first plain-text segment from a user message's content blob.
fn extract_first_user_text(content: &serde_json::Value) -> Option<String> {
    let raw = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts.iter().find_map(|p| {
            if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                p.get("text").and_then(|t| t.as_str()).map(str::to_string)
            } else {
                None
            }
        })?,
        _ => return None,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let truncated: String = trimmed.chars().take(280).collect();
    Some(if truncated.len() < trimmed.len() {
        format!("{truncated}…")
    } else {
        truncated
    })
}

fn parse_iso_ts(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
}

/// Locate a session JSONL by its sessionId. We recognize a match either by
/// the embedded sessionId field or by the filename stem.
fn find_session_file(id: &str) -> Option<PathBuf> {
    let root = projects_dir()?;
    if !root.is_dir() {
        return None;
    }
    for project in std::fs::read_dir(&root).ok()?.flatten() {
        let pdir = project.path();
        if !pdir.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(&pdir).ok()?.flatten() {
            let p = file.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if p.file_stem().and_then(|s| s.to_str()) == Some(id) {
                return Some(p);
            }
        }
    }
    None
}

const TOOL_RESULT_TRUNCATE: usize = 800;
const TEXT_TRUNCATE: usize = 4000;

/// Parse a JSONL transcript into the rich event-by-event view used by the
/// Session Replay screen. Returns None if the file can't be opened.
pub fn scan_detail(id: &str) -> Option<SessionDetail> {
    let path = find_session_file(id)?;
    let file = File::open(&path).ok()?;
    let reader = BufReader::new(file);

    let mut start_ts: Option<i64> = None;
    let mut end_ts: Option<i64> = None;
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut model: Option<String> = None;
    let mut messages = 0u32;
    let mut usage = TokenUsage::default();
    let mut cost = 0.0_f64;
    let mut first_prompt: Option<String> = None;
    let mut events: Vec<SessionEvent> = Vec::new();
    let mut files_modified: Vec<String> = Vec::new();
    let mut files_seen: std::collections::HashSet<String> = std::collections::HashSet::new();

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
            .and_then(parse_iso_ts)
            .unwrap_or(0);
        if ts != 0 {
            start_ts = Some(start_ts.map_or(ts, |s| s.min(ts)));
            end_ts = Some(end_ts.map_or(ts, |e| e.max(ts)));
        }
        if cwd.is_none() {
            cwd = value
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if branch.is_none() {
            branch = value
                .get("gitBranch")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }

        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "user" => {
                messages += 1;
                let content = value.get("message").and_then(|m| m.get("content"));
                if let Some(text) = extract_text(content) {
                    if first_prompt.is_none() {
                        first_prompt = Some(truncate_chars(&text, 280));
                    }
                    events.push(SessionEvent {
                        ts,
                        kind: "user".into(),
                        text: Some(truncate_chars(&text, TEXT_TRUNCATE)),
                        tool_name: None,
                        tool_summary: None,
                        tool_result: None,
                        is_error: false,
                    });
                }
                // Tool results come back as user-role content blocks.
                if let Some(blocks) = content.and_then(|c| c.as_array()) {
                    for block in blocks {
                        if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                            continue;
                        }
                        let body = extract_tool_result(block);
                        let is_error = block
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        events.push(SessionEvent {
                            ts,
                            kind: "tool_result".into(),
                            text: None,
                            tool_name: None,
                            tool_summary: None,
                            tool_result: body,
                            is_error,
                        });
                    }
                }
            }
            "assistant" => {
                messages += 1;
                let msg = value.get("message");
                if model.is_none() {
                    model = msg
                        .and_then(|m| m.get("model"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                }
                if let Some(u) = msg.and_then(|m| m.get("usage")) {
                    let turn = TokenUsage {
                        input: u.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        output: u.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0),
                        cache_read: u
                            .get("cache_read_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_creation: u
                            .get("cache_creation_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_creation_1h: u
                            .get("cache_creation")
                            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                    };
                    if let Some(m) = msg.and_then(|m| m.get("model")).and_then(|v| v.as_str()) {
                        cost += pricing::cost_of(m, &turn, Some(ts));
                    }
                    usage.input += turn.input;
                    usage.output += turn.output;
                    usage.cache_read += turn.cache_read;
                    usage.cache_creation += turn.cache_creation;
                    usage.cache_creation_1h += turn.cache_creation_1h;
                }
                let blocks = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array());
                if let Some(blocks) = blocks {
                    for block in blocks {
                        let bty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match bty {
                            "text" => {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    let trimmed = text.trim();
                                    if !trimmed.is_empty() {
                                        events.push(SessionEvent {
                                            ts,
                                            kind: "assistant".into(),
                                            text: Some(truncate_chars(trimmed, TEXT_TRUNCATE)),
                                            tool_name: None,
                                            tool_summary: None,
                                            tool_result: None,
                                            is_error: false,
                                        });
                                    }
                                }
                            }
                            "tool_use" => {
                                let tool_name = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let input = block
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let summary = summarize_tool(&tool_name, &input);
                                if matches!(tool_name.as_str(), "Edit" | "Write" | "NotebookEdit") {
                                    if let Some(fp) =
                                        input.get("file_path").and_then(|v| v.as_str())
                                    {
                                        if files_seen.insert(fp.to_string()) {
                                            files_modified.push(fp.to_string());
                                        }
                                    }
                                }
                                events.push(SessionEvent {
                                    ts,
                                    kind: "tool_use".into(),
                                    text: None,
                                    tool_name: Some(tool_name),
                                    tool_summary: Some(summary),
                                    tool_result: None,
                                    is_error: false,
                                });
                            }
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let resolved_id =
        session_id.or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;

    Some(SessionDetail {
        id: resolved_id,
        project_name: cwd.as_deref().and_then(|p| {
            Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        }),
        project_path: cwd,
        branch,
        model,
        start_ts: start_ts.unwrap_or(0),
        end_ts: end_ts.unwrap_or(0),
        message_count: messages,
        cost_usd: cost,
        usage,
        first_prompt,
        files_modified,
        events,
    })
}

/// Bumped by every search; a search that sees a newer value stops early, so
/// queries typed in quick succession don't pile up full-disk scans.
static SEARCH_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Case-insensitive full-text search over every transcript's user and
/// assistant text (tool calls and results are skipped). Lines are
/// pre-filtered on the raw JSON before parsing, so a file with no hit costs
/// one scan. Most matches first. A search superseded by a newer one returns
/// whatever it has so far (the caller has already moved on).
pub fn search_transcripts(query: &str) -> Vec<TranscriptMatch> {
    use std::sync::atomic::Ordering;
    let generation = SEARCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 2 {
        return Vec::new();
    }
    let Some(root) = projects_dir() else {
        return Vec::new();
    };
    let Ok(projects) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let p = file.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if SEARCH_GENERATION.load(Ordering::SeqCst) != generation {
                return out;
            }
            let matches = count_transcript_matches(&p, &needle);
            if matches == 0 {
                continue;
            }
            if let Some(stem) = p.file_stem() {
                out.push(TranscriptMatch {
                    session_id: stem.to_string_lossy().to_string(),
                    matches,
                });
            }
        }
    }
    out.sort_by(|a, b| b.matches.cmp(&a.matches));
    out
}

fn count_transcript_matches(path: &Path, needle: &str) -> u32 {
    let Ok(file) = File::open(path) else {
        return 0;
    };
    // Quotes and backslashes are escaped in the raw JSON, so the prefilter
    // would miss them — parse every line in that case.
    let prefilter = !needle.contains('"') && !needle.contains('\\');
    let mut n = 0u32;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if prefilter && !contains_ignore_case(&line, needle) {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };
        let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let count = |t: &str| t.to_lowercase().matches(needle).count() as u32;
        match value.get("message").and_then(|m| m.get("content")) {
            Some(serde_json::Value::String(s)) => n += count(s),
            Some(serde_json::Value::Array(parts)) => {
                for part in parts {
                    if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                            n += count(t);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    n
}

/// `haystack.to_lowercase().contains(needle)` for an already-lowercased
/// needle, without allocating when the needle is ASCII (the common case).
fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    if !needle.is_ascii() {
        return haystack.to_lowercase().contains(needle);
    }
    let (h, n) = (haystack.as_bytes(), needle.as_bytes());
    n.is_empty() || h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n))
}

fn extract_text(content: Option<&serde_json::Value>) -> Option<String> {
    let content = content?;
    match content {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Array(parts) => {
            for p in parts {
                if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = p.get("text").and_then(|t| t.as_str()) {
                        let t = text.trim();
                        if !t.is_empty() {
                            return Some(t.to_string());
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_tool_result(block: &serde_json::Value) -> Option<String> {
    let content = block.get("content")?;
    let raw = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => {
            let mut buf = String::new();
            for p in parts {
                if let Some(text) = p.get("text").and_then(|t| t.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(text);
                }
            }
            buf
        }
        _ => return None,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(truncate_chars(trimmed, TOOL_RESULT_TRUNCATE))
    }
}

fn summarize_tool(tool: &str, input: &serde_json::Value) -> String {
    match tool {
        "Read" | "Edit" | "Write" | "NotebookEdit" => input
            .get("file_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Bash" => {
            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            truncate_chars(cmd, 200)
        }
        "Glob" | "Grep" => {
            let pattern = input.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            let path = input.get("path").and_then(|v| v.as_str()).unwrap_or("");
            match (pattern.is_empty(), path.is_empty()) {
                (false, false) => format!("{pattern} in {path}"),
                (false, true) => pattern.to_string(),
                (true, false) => path.to_string(),
                (true, true) => String::new(),
            }
        }
        "Task" | "Agent" => input
            .get("description")
            .or_else(|| input.get("subagent_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "Skill" => input
            .get("skill")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        "WebFetch" | "WebSearch" => input
            .get("url")
            .or_else(|| input.get("query"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => input
            .as_object()
            .and_then(|o| o.values().find_map(|v| v.as_str()))
            .map(|s| truncate_chars(s, 200))
            .unwrap_or_default(),
    }
}

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let truncated: String = s.chars().take(n).collect();
    format!("{truncated}…")
}

/// Walks ~/.claude/projects/* and returns every session, using the cache
/// to skip files whose mtime is unchanged since last call.
pub fn scan_all(cache: &Cache) -> Result<Vec<Session>> {
    let Some(root) = projects_dir() else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }

    // Collect (path, mtime) for every .jsonl
    let mut current: Vec<(PathBuf, SystemTime)> = Vec::new();
    for project_entry in std::fs::read_dir(&root)?.flatten() {
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        for file_entry in std::fs::read_dir(&project_path)?.flatten() {
            let p = file_entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = file_entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            current.push((p, mtime));
        }
    }

    let mut entries = cache.entries.lock().unwrap();

    // Evict files no longer present
    let live: std::collections::HashSet<&PathBuf> = current.iter().map(|(p, _)| p).collect();
    entries.retain(|p, _| live.contains(p));

    let mut sessions = Vec::with_capacity(current.len());
    for (path, mtime) in current {
        let needs_parse = match entries.get(&path) {
            Some(entry) => entry.mtime != mtime,
            None => true,
        };
        if needs_parse {
            if let Some(session) = parse_session_file(&path) {
                entries.insert(
                    path.clone(),
                    CacheEntry {
                        mtime,
                        session: session.clone(),
                    },
                );
                sessions.push(session);
            }
        } else if let Some(entry) = entries.get(&path) {
            sessions.push(entry.session.clone());
        }
    }

    sessions.sort_by(|a, b| b.end_ts.cmp(&a.end_ts));
    Ok(sessions)
}

/// Aggregate stats for the Sessions view.
pub fn stats(sessions: &[Session]) -> SessionStats {
    let mut hour_histogram = [0u32; 24];
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut total_messages = 0u64;
    let mut total_cost = 0.0;
    let mut usage = TokenUsage::default();

    let day_buckets = day_buckets(sessions, 84, |_| 1.0);

    for s in sessions {
        total_messages += s.message_count as u64;
        total_cost += s.cost_usd;
        usage.input += s.usage.input;
        usage.output += s.usage.output;
        usage.cache_read += s.usage.cache_read;
        usage.cache_creation += s.usage.cache_creation;
        usage.cache_creation_1h += s.usage.cache_creation_1h;

        if let Some(dt) = millis_to_utc(s.start_ts) {
            let hour = dt.hour() as usize;
            hour_histogram[hour] = hour_histogram[hour].saturating_add(1);
        }

        let key = s.model.clone().unwrap_or_else(|| "unknown".into());
        let entry = by_model.entry(key.clone()).or_insert(ModelUsage {
            model: key,
            sessions: 0,
            cost_usd: 0.0,
            tokens: 0,
            cache_read_tokens: 0,
            cache_read_savings_usd: 0.0,
        });
        entry.sessions += 1;
        entry.cost_usd += s.cost_usd;
        entry.tokens += s.usage.input + s.usage.output;
        entry.cache_read_tokens += s.usage.cache_read;
        entry.cache_read_savings_usd +=
            crate::pricing::cache_read_savings_usd(&entry.model, s.usage.cache_read);
    }

    let mut by_model: Vec<ModelUsage> = by_model.into_values().collect();
    by_model.sort_by(|a, b| b.tokens.cmp(&a.tokens));

    let total_tokens = usage.input + usage.output;

    SessionStats {
        total_sessions: sessions.len(),
        total_messages,
        total_cost_usd: total_cost,
        total_tokens,
        usage,
        hour_histogram,
        day_histogram: day_buckets.iter().map(|v| *v as u32).collect(),
        by_model,
    }
}

/// Cost breakdown for the Costs view.
pub fn costs(sessions: &[Session]) -> CostBreakdown {
    let mut by_model: HashMap<String, ModelUsage> = HashMap::new();
    let mut by_repo: HashMap<String, RepoCost> = HashMap::new();
    let mut total = 0.0_f64;
    let mut total_tokens: u64 = 0;
    let mut total_messages: u64 = 0;

    for s in sessions {
        total += s.cost_usd;
        let session_tokens = s.usage.input + s.usage.output;
        total_tokens += session_tokens;
        total_messages += s.message_count as u64;
        let model_key = s.model.clone().unwrap_or_else(|| "unknown".into());
        let m = by_model.entry(model_key.clone()).or_insert(ModelUsage {
            model: model_key,
            sessions: 0,
            cost_usd: 0.0,
            tokens: 0,
            cache_read_tokens: 0,
            cache_read_savings_usd: 0.0,
        });
        m.sessions += 1;
        m.cost_usd += s.cost_usd;
        m.tokens += session_tokens;
        m.cache_read_tokens += s.usage.cache_read;
        m.cache_read_savings_usd +=
            crate::pricing::cache_read_savings_usd(&m.model, s.usage.cache_read);

        let repo_key = s
            .project_name
            .clone()
            .or_else(|| s.project_path.clone())
            .unwrap_or_else(|| "(unknown)".into());
        let r = by_repo.entry(repo_key.clone()).or_insert(RepoCost {
            repo_name: repo_key,
            repo_path: s.project_path.clone(),
            cost_usd: 0.0,
            sessions: 0,
            tokens: 0,
            messages: 0,
        });
        r.cost_usd += s.cost_usd;
        r.sessions += 1;
        r.tokens += session_tokens;
        r.messages += s.message_count as u64;
    }

    let mut by_model: Vec<ModelUsage> = by_model.into_values().collect();
    by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap());
    let mut by_repo: Vec<RepoCost> = by_repo.into_values().collect();
    by_repo.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap());

    let by_day = cost_day_buckets(sessions, 30);

    CostBreakdown {
        total_usd: total,
        total_tokens,
        total_messages,
        by_model,
        by_repo,
        by_day,
    }
}

/// Per-repo cost detail for the trailing 30 days. Buckets are computed in
/// the user's local timezone for day/week alignment, since the UI labels
/// them with calendar dates — but ts ranges stay in UTC millis so the
/// frontend doesn't need to second-guess the math.
pub fn repo_cost_detail(sessions: &[Session], repo_key: &str) -> RepoCostDetail {
    // Filter to this repo, by the same key the by_repo aggregation uses:
    // project_name → project_path → "(unknown)".
    let matching: Vec<&Session> = sessions
        .iter()
        .filter(|s| {
            let key = s
                .project_name
                .clone()
                .or_else(|| s.project_path.clone())
                .unwrap_or_else(|| "(unknown)".into());
            key == repo_key
        })
        .collect();

    // Cap the detail window to the trailing 30 days for symmetry with the
    // main Costs view's byDay window.
    let today_local = Local::now().date_naive();
    let cutoff_local = today_local - ChronoDuration::days(29);
    let in_window: Vec<&Session> = matching
        .iter()
        .copied()
        .filter(|s| {
            let Some(local_date) = millis_to_local_date(s.start_ts) else {
                return false;
            };
            local_date >= cutoff_local && local_date <= today_local
        })
        .collect();

    // Totals across the rolling 30 day window.
    let mut totals = CostTotals {
        sessions: 0,
        messages: 0,
        tokens: 0,
        cost_usd: 0.0,
    };
    for s in &in_window {
        totals.sessions += 1;
        totals.messages += s.message_count as u64;
        totals.tokens += s.usage.input + s.usage.output;
        totals.cost_usd += s.cost_usd;
    }

    let by_day = bucket_by_day(&in_window, cutoff_local, today_local);
    let by_five_hour = bucket_by_five_hour(&in_window);
    let by_week = bucket_by_week(&in_window, cutoff_local, today_local);
    let by_weekly_session = bucket_by_weekly_session(&in_window);

    // Repo metadata: take the first session that has both fields.
    let repo_name = matching
        .iter()
        .find_map(|s| s.project_name.clone())
        .unwrap_or_else(|| repo_key.to_string());
    let repo_path = matching.iter().find_map(|s| s.project_path.clone());

    RepoCostDetail {
        repo_name,
        repo_path,
        totals,
        by_day,
        by_five_hour,
        by_week,
        by_weekly_session,
    }
}

fn millis_to_local_date(ms: i64) -> Option<NaiveDate> {
    let dt = millis_to_utc(ms)?;
    Some(dt.with_timezone(&Local).date_naive())
}

/// Daily buckets between cutoff..=today inclusive, oldest → newest. Empty
/// days are included so the UI can paint a continuous strip.
fn bucket_by_day(sessions: &[&Session], cutoff: NaiveDate, today: NaiveDate) -> Vec<CostBucket> {
    let span = (today - cutoff).num_days() + 1;
    let mut out: Vec<CostBucket> = Vec::with_capacity(span as usize);
    for i in 0..span {
        let date = cutoff + ChronoDuration::days(i);
        let label = date.format("%a, %b %-d").to_string();
        let start_ts = date
            .and_hms_opt(0, 0, 0)
            .and_then(|ndt| ndt.and_local_timezone(Local).single())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        let end_ts = (date + ChronoDuration::days(1))
            .and_hms_opt(0, 0, 0)
            .and_then(|ndt| ndt.and_local_timezone(Local).single())
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        out.push(CostBucket {
            start_ts,
            end_ts,
            label,
            sessions: 0,
            messages: 0,
            tokens: 0,
            cost_usd: 0.0,
        });
    }

    for s in sessions {
        let Some(date) = millis_to_local_date(s.start_ts) else {
            continue;
        };
        let diff = (date - cutoff).num_days();
        if let Some(b) = out.get_mut(diff as usize) {
            b.sessions += 1;
            b.messages += s.message_count as u64;
            b.tokens += s.usage.input + s.usage.output;
            b.cost_usd += s.cost_usd;
        }
    }
    out
}

const FIVE_HOUR_MS: i64 = 5 * 60 * 60 * 1000;

/// Anthropic-style 5h windows aligned to floor(ts / 5h). Only windows with
/// activity are emitted, newest → oldest (the UI typically wants "latest
/// 5h windows" at the top).
fn bucket_by_five_hour(sessions: &[&Session]) -> Vec<CostBucket> {
    let mut buckets: BTreeMap<i64, CostBucket> = BTreeMap::new();
    for s in sessions {
        let start = (s.start_ts / FIVE_HOUR_MS) * FIVE_HOUR_MS;
        let end = start + FIVE_HOUR_MS;
        let entry = buckets.entry(start).or_insert_with(|| CostBucket {
            start_ts: start,
            end_ts: end,
            label: format_window_label(start, end),
            sessions: 0,
            messages: 0,
            tokens: 0,
            cost_usd: 0.0,
        });
        entry.sessions += 1;
        entry.messages += s.message_count as u64;
        entry.tokens += s.usage.input + s.usage.output;
        entry.cost_usd += s.cost_usd;
    }
    // BTreeMap iterates ascending; reverse for newest-first.
    buckets.into_values().rev().collect()
}

fn format_window_label(start_ms: i64, end_ms: i64) -> String {
    let Some(start) = millis_to_utc(start_ms) else {
        return String::new();
    };
    let Some(end) = millis_to_utc(end_ms) else {
        return String::new();
    };
    let start_local = start.with_timezone(&Local);
    let end_local = end.with_timezone(&Local);
    let same_day = start_local.date_naive() == end_local.date_naive();
    if same_day {
        format!(
            "{} · {}–{}",
            start_local.format("%a, %b %-d"),
            start_local.format("%-I%P"),
            end_local.format("%-I%P"),
        )
    } else {
        format!(
            "{} {} – {} {}",
            start_local.format("%b %-d"),
            start_local.format("%-I%P"),
            end_local.format("%b %-d"),
            end_local.format("%-I%P"),
        )
    }
}

/// Calendar-week buckets (Mon → Sun) spanning cutoff..=today.
fn bucket_by_week(sessions: &[&Session], cutoff: NaiveDate, today: NaiveDate) -> Vec<CostBucket> {
    // Roll back to the Monday of the earliest covered week.
    let first_monday =
        cutoff - ChronoDuration::days(cutoff.weekday().num_days_from_monday() as i64);
    let mut weeks: Vec<NaiveDate> = Vec::new();
    let mut cursor = first_monday;
    while cursor <= today {
        weeks.push(cursor);
        cursor += ChronoDuration::days(7);
    }

    let mut out: Vec<CostBucket> = weeks
        .iter()
        .map(|monday| {
            let sunday = *monday + ChronoDuration::days(6);
            let start_ts = monday
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).single())
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            let end_ts = (*monday + ChronoDuration::days(7))
                .and_hms_opt(0, 0, 0)
                .and_then(|ndt| ndt.and_local_timezone(Local).single())
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0);
            let label = format!("{} – {}", monday.format("%b %-d"), sunday.format("%b %-d"),);
            CostBucket {
                start_ts,
                end_ts,
                label,
                sessions: 0,
                messages: 0,
                tokens: 0,
                cost_usd: 0.0,
            }
        })
        .collect();

    for s in sessions {
        let Some(date) = millis_to_local_date(s.start_ts) else {
            continue;
        };
        let monday = date - ChronoDuration::days(date.weekday().num_days_from_monday() as i64);
        if let Some(b) = out.iter_mut().find(|b| {
            millis_to_local_date(b.start_ts)
                .map(|d| d == monday)
                .unwrap_or(false)
        }) {
            b.sessions += 1;
            b.messages += s.message_count as u64;
            b.tokens += s.usage.input + s.usage.output;
            b.cost_usd += s.cost_usd;
        }
    }
    // Newest week first.
    out.reverse();
    out
}

const WEEKLY_SESSION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Anthropic-style 7-day rolling sessions. Walk sessions in time order;
/// each block starts at the first session after the previous block ended,
/// and runs for 7 days from that start.
fn bucket_by_weekly_session(sessions: &[&Session]) -> Vec<CostBucket> {
    let mut sorted: Vec<&Session> = sessions.to_vec();
    sorted.sort_by_key(|s| s.start_ts);

    let mut out: Vec<CostBucket> = Vec::new();
    let mut block_end: i64 = i64::MIN;
    for s in sorted {
        if s.start_ts >= block_end {
            let start = s.start_ts;
            let end = start + WEEKLY_SESSION_MS;
            out.push(CostBucket {
                start_ts: start,
                end_ts: end,
                label: format_window_label(start, end),
                sessions: 0,
                messages: 0,
                tokens: 0,
                cost_usd: 0.0,
            });
            block_end = end;
        }
        let bucket = out.last_mut().expect("just pushed");
        bucket.sessions += 1;
        bucket.messages += s.message_count as u64;
        bucket.tokens += s.usage.input + s.usage.output;
        bucket.cost_usd += s.cost_usd;
    }
    out.reverse();
    out
}

/// Rolling-window day buckets of cost in USD (oldest → newest), summed from
/// each session's per-message daily attribution (`Session::cost_by_day`).
///
/// Unlike `day_buckets`, which keys off a single `start_ts`, this spreads a
/// session's spend across every local calendar day it was actually active on.
/// That's what keeps the "Today" / 30-day cost figures consistent with the
/// per-message 5h/weekly windows in `scanners::usage` — a session resumed days
/// after it started (Claude Code reuses the original JSONL, so `start_ts` stays
/// pinned to day one) no longer dumps all of its recent cost on the wrong day.
fn cost_day_buckets(sessions: &[Session], days: usize) -> Vec<f64> {
    let today = Local::now().date_naive();
    let mut out = vec![0.0; days];
    let span = days as i64;
    for s in sessions {
        for (date, cost) in &s.cost_by_day {
            let diff = today.signed_duration_since(*date).num_days();
            if (0..span).contains(&diff) {
                let idx = (span - 1 - diff) as usize;
                out[idx] += cost;
            }
        }
    }
    out
}

/// Rolling-window day buckets (oldest → newest), keyed off session start_ts.
/// Days are bucketed in the user's local timezone so "Today" / "This week"
/// reflect calendar days as the user experiences them, not UTC.
fn day_buckets(sessions: &[Session], days: usize, value_fn: impl Fn(&Session) -> f64) -> Vec<f64> {
    let today = Local::now().date_naive();
    let mut out = vec![0.0; days];
    let span = days as i64;
    for s in sessions {
        let Some(dt) = millis_to_utc(s.start_ts) else {
            continue;
        };
        let local_date = dt.with_timezone(&Local).date_naive();
        let diff = today.signed_duration_since(local_date).num_days();
        if (0..span).contains(&diff) {
            let idx = (span - 1 - diff) as usize;
            out[idx] += value_fn(s);
        }
    }
    out
}

fn millis_to_utc(ms: i64) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp_millis(ms)
}

/// 30d session-count histogram for the Dashboard.
pub fn activity_30d(sessions: &[Session]) -> Vec<u32> {
    day_buckets(sessions, 30, |_| 1.0)
        .iter()
        .map(|v| *v as u32)
        .collect()
}

/// Tool usage stats for the Tools view. Aggregates the new richer fields on
/// each session into the rolling-window metrics + top-N lists the UI needs.
pub fn tool_stats(sessions: &[Session]) -> ToolStats {
    let mut by_tool: HashMap<String, ToolBreakdown> = HashMap::new();
    let mut total_calls = 0u64;
    let mut total_errors = 0u64;
    let mut sequences: HashMap<String, u32> = HashMap::new();
    let mut error_by_name: HashMap<String, u32> = HashMap::new();
    let mut files: HashMap<String, (u32, Option<String>)> = HashMap::new();
    let mut commands: HashMap<String, u32> = HashMap::new();
    let mut projects: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut by_day_map: BTreeMap<String, u32> = BTreeMap::new();

    let today = Local::now().date_naive();
    let cutoff_365 = today - chrono::Duration::days(364);
    let cutoff_7 = today - chrono::Duration::days(6);
    let cutoff_14 = today - chrono::Duration::days(13);
    let mut last_7d_calls = 0u64;
    let mut prior_7d_calls = 0u64;

    for s in sessions {
        total_errors += s.tool_errors as u64;
        for (name, count) in &s.tool_uses {
            total_calls += *count as u64;
            let entry = by_tool.entry(name.clone()).or_insert(ToolBreakdown {
                name: name.clone(),
                calls: 0,
                errors: 0,
            });
            entry.calls += *count as u64;
        }
        for (name, errs) in &s.tool_errors_by_name {
            *error_by_name.entry(name.clone()).or_insert(0) += *errs;
        }
        for (key, count) in &s.tool_sequences {
            *sequences.entry(key.clone()).or_insert(0) += *count;
        }
        for (path, count) in &s.files_edited {
            let entry = files
                .entry(path.clone())
                .or_insert((0, s.project_name.clone()));
            entry.0 += *count;
            // Prefer a non-None repo if seen later.
            if entry.1.is_none() && s.project_name.is_some() {
                entry.1 = s.project_name.clone();
            }
        }
        for (cmd, count) in &s.bash_commands {
            *commands.entry(cmd.clone()).or_insert(0) += *count;
        }
        if let Some(name) = s.project_name.clone() {
            projects.insert(name);
        }

        // Day bucketing + last/prior week counts.
        let session_calls: u32 = s.tool_uses.values().sum();
        if session_calls == 0 {
            continue;
        }
        let Some(dt) = millis_to_utc(s.start_ts) else {
            continue;
        };
        let date = dt.with_timezone(&Local).date_naive();
        if date >= cutoff_365 && date <= today {
            let key = date.format("%Y-%m-%d").to_string();
            *by_day_map.entry(key).or_insert(0) += session_calls;
        }
        if date >= cutoff_7 && date <= today {
            last_7d_calls += session_calls as u64;
        } else if date >= cutoff_14 && date < cutoff_7 {
            prior_7d_calls += session_calls as u64;
        }
    }

    // Project this tool's error count back into the by_tool list so the UI
    // can show inline error counts on each row.
    let mut by_tool_vec: Vec<ToolBreakdown> = by_tool.into_values().collect();
    for t in &mut by_tool_vec {
        if let Some(errs) = error_by_name.get(&t.name) {
            t.errors = *errs as u64;
        }
    }
    by_tool_vec.sort_by(|a, b| b.calls.cmp(&a.calls));
    let top_tools: Vec<ToolBreakdown> = by_tool_vec.iter().take(10).cloned().collect();

    // Top consecutive sequences.
    let mut seq_vec: Vec<(String, u32)> = sequences.into_iter().collect();
    seq_vec.sort_by(|a, b| b.1.cmp(&a.1));
    let sequences_out: Vec<SequenceEntry> = seq_vec
        .into_iter()
        .take(10)
        .filter_map(|(key, count)| {
            let mut parts = key.split('\u{2192}');
            let from = parts.next()?.to_string();
            let to = parts.next()?.to_string();
            Some(SequenceEntry { from, to, count })
        })
        .collect();

    // Error-prone tools: error count + percentage of that tool's total calls.
    let mut error_prone: Vec<ErrorEntry> = error_by_name
        .iter()
        .filter_map(|(tool, errs)| {
            let calls = by_tool_vec.iter().find(|t| &t.name == tool)?.calls;
            let pct = if calls > 0 {
                ((*errs as f64 / calls as f64) * 100.0).round() as u32
            } else {
                0
            };
            Some(ErrorEntry {
                tool: tool.clone(),
                errors: *errs,
                error_pct: pct,
            })
        })
        .collect();
    error_prone.sort_by(|a, b| b.errors.cmp(&a.errors));
    error_prone.truncate(10);

    let mut top_files: Vec<FileEntry> = files
        .into_iter()
        .map(|(path, (count, repo))| FileEntry { path, repo, count })
        .collect();
    top_files.sort_by(|a, b| b.count.cmp(&a.count));
    let total_files_touched = top_files.len() as u64;
    top_files.truncate(10);

    let mut top_commands: Vec<CommandEntry> = commands
        .into_iter()
        .map(|(command, count)| CommandEntry { command, count })
        .collect();
    top_commands.sort_by(|a, b| b.count.cmp(&a.count));
    top_commands.truncate(10);

    // Build full 365-day series, oldest → newest, filling zero days.
    let mut by_day = Vec::with_capacity(365);
    for i in 0..365 {
        let d = cutoff_365 + chrono::Duration::days(i as i64);
        let key = d.format("%Y-%m-%d").to_string();
        let calls = by_day_map.get(&key).copied().unwrap_or(0);
        by_day.push(DayBucket { date: key, calls });
    }

    let session_count = sessions.len().max(1);
    let avg_calls_per_session = total_calls as f64 / session_count as f64;
    let error_rate_pct = if total_calls > 0 {
        (total_errors as f64 / total_calls as f64) * 100.0
    } else {
        0.0
    };
    let vs_last_week_pct = if prior_7d_calls > 0 {
        ((last_7d_calls as f64 - prior_7d_calls as f64) / prior_7d_calls as f64) * 100.0
    } else {
        0.0
    };

    ToolStats {
        total_calls,
        total_errors,
        total_files_touched,
        avg_calls_per_session,
        error_rate_pct,
        vs_last_week_pct,
        projects: projects.into_iter().collect(),
        by_day,
        by_tool: top_tools,
        sequences: sequences_out,
        error_prone,
        top_files,
        top_commands,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session whose cost lands on multiple days must spread across those
    /// days — not collapse onto its start date. This is the invariant that
    /// keeps the "Today" cost from being smaller than the per-message 5h
    /// window (which would otherwise show session cost > today cost).
    #[test]
    fn cost_day_buckets_split_session_across_midnight() {
        let today = Local::now().date_naive();
        let yesterday = today - ChronoDuration::days(1);

        let mut cost_by_day = BTreeMap::new();
        cost_by_day.insert(yesterday, 100.0);
        cost_by_day.insert(today, 50.0);

        let session = Session {
            id: "s1".into(),
            project_path: None,
            project_name: None,
            branch: None,
            model: None,
            start_ts: 0,
            end_ts: 0,
            message_count: 0,
            first_prompt: None,
            usage: TokenUsage::default(),
            cost_usd: 150.0,
            cost_by_day,
            tool_uses: BTreeMap::new(),
            tool_errors: 0,
            tool_errors_by_name: BTreeMap::new(),
            tool_sequences: BTreeMap::new(),
            files_edited: BTreeMap::new(),
            bash_commands: BTreeMap::new(),
        };

        let buckets = cost_day_buckets(&[session], 30);
        assert_eq!(buckets.len(), 30);
        // Trailing bucket is "today" — only today's spend, not the full session.
        assert_eq!(buckets[29], 50.0);
        assert_eq!(buckets[28], 100.0);
        // No spend leaked anywhere else.
        assert_eq!(buckets[..28].iter().sum::<f64>(), 0.0);
    }
}
