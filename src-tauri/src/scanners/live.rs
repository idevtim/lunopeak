use crate::models::{LiveActivity, LiveContext, LiveEvent, LiveSubagent, LiveTodo, SessionLiveState};
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Only consider transcript files modified within this window. Ten minutes is
/// loose enough to capture sessions that just paused for thinking, tight
/// enough that we never re-parse historical chats.
pub(crate) const RECENT_WINDOW: Duration = Duration::from_secs(10 * 60);

/// Hard cap on feed length so we never ship a runaway payload to the UI.
const MAX_FEED: usize = 100;

pub fn collect(limit: usize) -> LiveActivity {
    match projects_dir() {
        Some(root) if root.is_dir() => collect_in(&root, limit),
        _ => empty(),
    }
}

fn collect_in(root: &Path, limit: usize) -> LiveActivity {

    let cutoff = SystemTime::now()
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut events: Vec<LiveEvent> = Vec::new();
    let mut sessions: HashMap<String, SessionLiveState> = HashMap::new();

    // Session folders holding subagent transcripts, visited after every main
    // transcript so their runs can attach to an already-parsed parent.
    let mut subagent_dirs: Vec<(String, PathBuf)> = Vec::new();

    let Ok(read_dir) = std::fs::read_dir(root) else {
        return empty();
    };
    for project in read_dir.flatten() {
        let pdir = project.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&pdir) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if file.file_type().is_ok_and(|t| t.is_dir()) {
                // Appending to a transcript doesn't touch its folder's mtime,
                // so every `subagents/` folder has to be listed; there are
                // only a few dozen, against thousands of session folders.
                let sub = path.join("subagents");
                if sub.is_dir() {
                    if let Some(sid) = path.file_name().and_then(|n| n.to_str()) {
                        subagent_dirs.push((sid.to_string(), sub));
                    }
                }
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = file
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if mtime < cutoff {
                continue;
            }
            parse_recent(&path, &mut events, &mut sessions);
        }
    }

    for (sid, dir) in subagent_dirs {
        let runs = scan_subagents(&dir, cutoff);
        if runs.is_empty() {
            continue;
        }
        let entry = sessions.entry(sid.clone()).or_insert_with(|| SessionLiveState {
            // The main chat can sit quiet for the whole run of a foreground
            // subagent; the session is still live, so stand one up.
            session_id: sid.clone(),
            cwd: runs.iter().find_map(|r| r.cwd.clone()),
            last_ts: 0,
            last_tool: None,
            last_summary: None,
            todos: Vec::new(),
            agent: "claude".to_string(),
            subagents: Vec::new(),
        });
        for run in runs {
            // Work done by a subagent is work done by the session.
            entry.last_ts = entry.last_ts.max(run.info.last_ts);
            for mut e in run.events {
                e.session_id = sid.clone();
                if e.cwd.is_none() {
                    e.cwd = entry.cwd.clone();
                }
                events.push(e);
            }
            entry.subagents.push(run.info);
        }
        entry.subagents.sort_by_key(|a| {
            (a.status != "running", std::cmp::Reverse(a.last_ts))
        });
    }

    events.sort_by_key(|e| std::cmp::Reverse(e.ts));
    let cap = limit.min(MAX_FEED);
    events.truncate(cap);

    let mut session_list: Vec<SessionLiveState> = sessions.into_values().collect();
    session_list.sort_by_key(|s| std::cmp::Reverse(s.last_ts));

    LiveActivity {
        feed: events,
        sessions: session_list,
    }
}

fn parse_recent(
    path: &Path,
    events: &mut Vec<LiveEvent>,
    sessions: &mut HashMap<String, SessionLiveState>,
) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let reader = BufReader::new(file);

    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut last_ts: i64 = 0;
    let mut last_tool: Option<String> = None;
    let mut last_summary: Option<String> = None;
    let mut todos: Vec<LiveTodo> = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };

        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        if cwd.is_none() {
            cwd = value
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        let ts = value
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(parse_iso_ts)
            .unwrap_or(0);
        if ts > last_ts {
            last_ts = ts;
        }

        if value.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }

        let Some(blocks) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };

        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            let tool = block
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            if tool.is_empty() {
                continue;
            }
            let input = block
                .get("input")
                .cloned()
                .unwrap_or(serde_json::Value::Null);

            // TodoWrite drives the per-session task list, not the feed.
            if tool == "TodoWrite" {
                if let Some(arr) = input.get("todos").and_then(|t| t.as_array()) {
                    todos = arr
                        .iter()
                        .filter_map(|t| {
                            let content = t.get("content").and_then(|v| v.as_str())?;
                            Some(LiveTodo {
                                content: content.to_string(),
                                status: t
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("pending")
                                    .to_string(),
                            })
                        })
                        .collect();
                }
                continue;
            }

            let summary = summarize_tool(&tool, &input);
            let sid = session_id.clone().unwrap_or_default();
            events.push(LiveEvent {
                ts,
                session_id: sid,
                cwd: cwd.clone(),
                tool: tool.clone(),
                summary: summary.clone(),
                agent: "claude".to_string(),
                subagent_id: None,
                subagent: None,
            });
            last_tool = Some(tool);
            last_summary = Some(summary);
        }
    }

    let Some(sid) = session_id else {
        return;
    };
    sessions.insert(
        sid.clone(),
        SessionLiveState {
            session_id: sid,
            cwd,
            last_ts,
            last_tool,
            last_summary,
            todos,
            agent: "claude".to_string(),
            subagents: Vec::new(),
        },
    );
}

// ── Subagents ─────────────────────────────────────────────────────────

/// How far back to tail-read a subagent transcript for its latest steps.
/// They grow fast (a megabyte in a few minutes) and are polled every couple
/// of seconds, so never read one whole.
const SUBAGENT_TAIL_BYTES: u64 = 256 * 1024;

/// Steps per subagent sent to the feed; the feed shows the newest overall.
const SUBAGENT_FEED_EVENTS: usize = 20;

struct SubagentRunScan {
    info: LiveSubagent,
    cwd: Option<String>,
    events: Vec<LiveEvent>,
}

/// What `agent-<id>.meta.json` records about a run. `finished` is absent
/// (not false) while it runs; `model` is often missing, with the effort
/// picker's choice in `pickedEffortModel`.
#[derive(Default)]
pub(crate) struct SubagentMeta {
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub model: Option<String>,
    pub finished: bool,
}

pub(crate) fn read_subagent_meta(transcript: &Path) -> SubagentMeta {
    let Some(raw) = std::fs::read_to_string(transcript.with_extension("meta.json")).ok() else {
        return SubagentMeta::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return SubagentMeta::default();
    };
    let s = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .filter(|x| !x.is_empty())
            .map(str::to_string)
    };
    SubagentMeta {
        agent_type: s("agentType"),
        description: s("description"),
        model: s("model").or_else(|| s("pickedEffortModel")),
        finished: v.get("finished").and_then(|f| f.as_bool()).unwrap_or(false),
    }
}

/// `agent-<id>.jsonl` → `<id>`.
pub(crate) fn subagent_id(transcript: &Path) -> Option<String> {
    let stem = transcript.file_stem()?.to_str()?;
    Some(stem.strip_prefix("agent-").unwrap_or(stem).to_string())
}

/// Subagent transcripts in `dir` written to since `cutoff`. Anything older
/// is either long finished or abandoned (its session was killed mid-run).
fn recent_subagent_files(dir: &Path, cutoff: SystemTime) -> Vec<(PathBuf, SystemTime)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?;
            if !name.starts_with("agent-") || !name.ends_with(".jsonl") {
                return None;
            }
            let mtime = e.metadata().ok()?.modified().ok()?;
            (mtime >= cutoff).then_some((p, mtime))
        })
        .collect()
}

/// Subagents in a session's `subagents/` folder that are running, or that
/// finished inside the live window.
fn scan_subagents(dir: &Path, cutoff: SystemTime) -> Vec<SubagentRunScan> {
    recent_subagent_files(dir, cutoff)
        .into_iter()
        .filter_map(|(path, _)| scan_subagent(&path))
        .collect()
}

fn scan_subagent(path: &Path) -> Option<SubagentRunScan> {
    let id = subagent_id(path)?;
    let meta = read_subagent_meta(path);

    // The first line is the parent's prompt, stamped with the start time.
    let first = File::open(path)
        .ok()
        .and_then(|f| BufReader::new(f).lines().next())
        .and_then(Result::ok)
        .and_then(|l| serde_json::from_str::<serde_json::Value>(&l).ok());
    let started_ts = first
        .as_ref()
        .and_then(|v| v.get("timestamp"))
        .and_then(|t| t.as_str())
        .and_then(parse_iso_ts)
        .unwrap_or(0);
    let mut cwd = first
        .as_ref()
        .and_then(|v| v.get("cwd"))
        .and_then(|c| c.as_str())
        .map(str::to_string);

    let label = meta.description.clone().or_else(|| meta.agent_type.clone());
    // The transcript's own model wins: `pickedEffortModel` can name a model
    // the run never used (a custom agent pinned to another one).
    let mut model: Option<String> = None;
    let mut last_ts = started_ts;
    let mut last_tool = None;
    let mut last_summary = None;
    let mut events = Vec::new();

    let (lines, _) = read_tail_lines(path, SUBAGENT_TAIL_BYTES);
    for line in &lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_iso_ts)
            .unwrap_or(0);
        last_ts = last_ts.max(ts);
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(|c| c.as_str()).map(str::to_string);
        }
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        if let Some(m) = v
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(|m| m.as_str())
            .filter(|m| *m != "<synthetic>")
        {
            model = Some(m.to_string());
        }
        let Some(blocks) = v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                continue;
            }
            let Some(tool) = block.get("name").and_then(|n| n.as_str()).filter(|n| !n.is_empty())
            else {
                continue;
            };
            if tool == "TodoWrite" {
                continue;
            }
            let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
            let summary = summarize_tool(tool, &input);
            events.push(LiveEvent {
                ts,
                session_id: String::new(),
                cwd: cwd.clone(),
                tool: tool.to_string(),
                summary: summary.clone(),
                agent: "claude".to_string(),
                subagent_id: Some(id.clone()),
                subagent: label.clone(),
            });
            last_tool = Some(tool.to_string());
            last_summary = Some(summary);
        }
    }
    if events.len() > SUBAGENT_FEED_EVENTS {
        events.drain(..events.len() - SUBAGENT_FEED_EVENTS);
    }

    Some(SubagentRunScan {
        info: LiveSubagent {
            id,
            agent_type: meta.agent_type,
            description: meta.description,
            model: model.or(meta.model),
            status: if meta.finished { "done" } else { "running" }.to_string(),
            started_ts,
            last_ts,
            last_tool,
            last_summary,
        },
        cwd,
        events,
    })
}

/// Subagents still running under the session whose main transcript is
/// `transcript` — the `<session-id>/subagents/` folder beside it.
fn running_subagents(transcript: &Path) -> u32 {
    let cutoff = SystemTime::now()
        .checked_sub(RECENT_WINDOW)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let dir = transcript.with_extension("").join("subagents");
    recent_subagent_files(&dir, cutoff)
        .iter()
        .filter(|(p, _)| !read_subagent_meta(p).finished)
        .count() as u32
}

// ── Per-process context window ─────────────────────────────────────────

/// First tail read when looking for the latest assistant turn. Most turns sit
/// in the last few KB; a huge tool result can push them further back, so we
/// retry once with `TAIL_BYTES_MAX` before giving up.
const TAIL_BYTES: u64 = 512 * 1024;
const TAIL_BYTES_MAX: u64 = 8 * 1024 * 1024;

/// Claude Code writes `~/.claude/sessions/<pid>.json` for every running
/// session (pid, sessionId, cwd, name, busy/idle status) and leaves the file
/// behind when the process dies. Each live pid is paired with its transcript,
/// whose latest main-chain assistant turn carries the prompt size — that is
/// the context window fill Claude Code itself reports.
pub fn contexts() -> Vec<LiveContext> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".claude").join("sessions")) else {
        return Vec::new();
    };
    let Ok(read_dir) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let files: Vec<serde_json::Value> = read_dir
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|raw| serde_json::from_str(&raw).ok())
        .collect();
    if files.is_empty() {
        return Vec::new();
    }

    let pids: Vec<sysinfo::Pid> = files
        .iter()
        .filter_map(|v| v.get("pid").and_then(|p| p.as_u64()))
        .map(|p| sysinfo::Pid::from_u32(p as u32))
        .collect();
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&pids),
        true,
        sysinfo::ProcessRefreshKind::new(),
    );

    let projects = projects_dir();
    let mut out = Vec::new();
    for v in &files {
        let Some(pid) = v.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32) else {
            continue;
        };
        // Stale files outlive their process, and the OS recycles pids — only
        // trust a pid that is still running something Claude-shaped (the
        // native binary, or the npm CLI under node / bun).
        let Some(proc_) = sys.process(sysinfo::Pid::from_u32(pid)) else {
            continue;
        };
        let pname = proc_.name().to_string_lossy().to_lowercase();
        if !(pname.contains("claude") || pname.contains("node") || pname.contains("bun")) {
            continue;
        }
        let Some(session_id) = v.get("sessionId").and_then(|s| s.as_str()) else {
            continue;
        };
        let cwd = v.get("cwd").and_then(|s| s.as_str()).map(str::to_string);
        // Hooks and plugins spawn short-lived helper sessions in the OS temp
        // dir; they aren't anything the user is running.
        if cwd.as_deref().is_some_and(is_temp_path) {
            continue;
        }
        let transcript = projects
            .as_deref()
            .and_then(|root| find_transcript(root, cwd.as_deref(), session_id));
        let turn = transcript.as_deref().and_then(latest_claude_turn);
        let subagents_running = transcript.as_deref().map(running_subagents).unwrap_or(0);
        let updated = v
            .get("statusUpdatedAt")
            .or_else(|| v.get("updatedAt"))
            .and_then(|t| t.as_i64())
            .unwrap_or(0);
        let (mut model, mut used, turn_ts) = match turn {
            Some(t) => (Some(t.model), Some(t.used_tokens), t.ts),
            None => (None, None, 0),
        };
        // When LunoPeak's status line runs in this session, Claude Code has
        // told us the real window size — prefer it to the model heuristic.
        let recorded = crate::statusline::recorded_context(session_id);
        if used.is_none() {
            used = recorded.as_ref().and_then(|r| r.used_tokens);
        }
        if model.is_none() {
            model = recorded.as_ref().and_then(|r| r.model.clone());
        }
        let window = match &recorded {
            Some(r) if r.window_tokens > 0 => used.map(|_| r.window_tokens),
            _ => used.map(|u| claude_context_window(model.as_deref().unwrap_or(""), u)),
        };
        out.push(LiveContext {
            agent: "claude".to_string(),
            session_id: session_id.to_string(),
            pid: Some(pid),
            name: v.get("name").and_then(|s| s.as_str()).map(str::to_string),
            cwd,
            model,
            used_tokens: used,
            window_tokens: window,
            used_percent: used.zip(window).map(|(u, w)| percent(u, w)),
            status: v.get("status").and_then(|s| s.as_str()).map(str::to_string),
            last_ts: updated.max(turn_ts),
            subagents_running,
        });
    }
    out
}

fn is_temp_path(path: &str) -> bool {
    let tmp = std::env::temp_dir();
    let canonical = tmp.canonicalize().unwrap_or_else(|_| tmp.clone());
    let p = Path::new(path);
    p.starts_with(&tmp)
        || p.starts_with(&canonical)
        || (cfg!(unix) && (p.starts_with("/tmp") || p.starts_with("/private/tmp")))
}

pub(crate) fn percent(used: u64, window: u64) -> f64 {
    if window == 0 {
        return 0.0;
    }
    (used as f64 / window as f64 * 100.0).min(100.0)
}

/// Transcripts live at `projects/<cwd with every non-alphanumeric char
/// replaced by '-'>/<sessionId>.jsonl`. Fall back to a directory sweep in case
/// the encoding drifts between Claude Code versions.
fn find_transcript(root: &Path, cwd: Option<&str>, session_id: &str) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    if let Some(cwd) = cwd {
        let encoded: String = cwd
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let direct = root.join(encoded).join(&file);
        if direct.is_file() {
            return Some(direct);
        }
    }
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&file))
        .find(|p| p.is_file())
}

struct ClaudeTurn {
    model: String,
    used_tokens: u64,
    ts: i64,
}

fn latest_claude_turn(path: &Path) -> Option<ClaudeTurn> {
    for budget in [TAIL_BYTES, TAIL_BYTES_MAX] {
        let (lines, whole_file) = read_tail_lines(path, budget);
        if let Some(turn) = lines.iter().rev().find_map(|l| parse_claude_turn(l)) {
            return Some(turn);
        }
        if whole_file {
            break;
        }
    }
    None
}

/// Prompt size of one main-chain assistant turn: fresh input plus both cache
/// legs, which together are everything the model saw. Sidechain (subagent)
/// turns have their own window and synthetic turns carry no real usage.
fn parse_claude_turn(line: &str) -> Option<ClaudeTurn> {
    // Cheap prefilter — most tail lines are tool results, not assistant turns.
    if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    if v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
        return None;
    }
    let msg = v.get("message")?;
    let model = msg.get("model").and_then(|m| m.as_str()).unwrap_or("");
    if model.is_empty() || model == "<synthetic>" {
        return None;
    }
    let usage = msg.get("usage")?;
    let n = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let used = n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
    if used == 0 {
        return None;
    }
    Some(ClaudeTurn {
        model: model.to_string(),
        used_tokens: used,
        ts: v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .and_then(parse_iso_ts)
            .unwrap_or(0),
    })
}

/// Transcripts don't record the window size, so infer it from the model: the
/// current families run a 1M window, older ones 200k. A prompt already past
/// 200k proves the session is on the 1M window whatever the model says.
pub(crate) fn claude_context_window(model: &str, used: u64) -> u64 {
    const STANDARD: u64 = 200_000;
    const EXTENDED: u64 = 1_000_000;
    let m = model.to_lowercase();
    let one_m = m.contains("[1m]")
        || m.contains("fable")
        || m.contains("mythos")
        || m.contains("opus-5")
        || m.contains("sonnet-5")
        || m.contains("haiku-5")
        || ["opus-4-6", "opus-4-7", "opus-4-8", "sonnet-4-6"]
            .iter()
            .any(|f| m.contains(f));
    if one_m || used > STANDARD {
        EXTENDED
    } else {
        STANDARD
    }
}

/// Read up to `max_bytes` from the end of `path`, split into complete lines.
/// The first line is dropped when the read started mid-file, since it is
/// almost certainly a fragment. Returns whether the whole file was covered.
pub(crate) fn read_tail_lines(path: &Path, max_bytes: u64) -> (Vec<String>, bool) {
    let Ok(mut file) = File::open(path) else {
        return (Vec::new(), true);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (Vec::new(), true);
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return (Vec::new(), true);
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    (lines, start == 0)
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
            truncate_chars(cmd, 80)
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
            .map(|s| truncate_chars(s, 80))
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

fn parse_iso_ts(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn empty() -> LiveActivity {
    LiveActivity {
        feed: Vec::new(),
        sessions: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn assistant(sidechain: bool, model: &str, input: u64, create: u64, read: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "isSidechain": sidechain,
            "timestamp": "2026-09-28T14:00:00Z",
            "message": {
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "cache_creation_input_tokens": create,
                    "cache_read_input_tokens": read,
                    "output_tokens": 999
                }
            }
        })
        .to_string()
    }

    #[test]
    fn turn_counts_input_and_both_cache_legs_but_not_output() {
        let t = parse_claude_turn(&assistant(false, "claude-opus-5-5", 2, 790, 69_075)).unwrap();
        assert_eq!(t.used_tokens, 69_867);
        assert_eq!(t.model, "claude-opus-5-5");
        assert!(t.ts > 0);
    }

    #[test]
    fn turn_skips_sidechain_and_synthetic() {
        assert!(parse_claude_turn(&assistant(true, "claude-opus-5-5", 1, 1, 1)).is_none());
        assert!(parse_claude_turn(&assistant(false, "<synthetic>", 1, 1, 1)).is_none());
        assert!(parse_claude_turn(r#"{"type":"user","message":{"usage":{}}}"#).is_none());
    }

    #[test]
    fn window_by_model_family() {
        assert_eq!(claude_context_window("claude-haiku-4-5-20251001", 50_000), 200_000);
        assert_eq!(claude_context_window("claude-sonnet-4-5", 50_000), 200_000);
        assert_eq!(claude_context_window("claude-opus-5-5", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-fable-5-1", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-fable-5-2", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-mythos-5-2", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-sonnet-5", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-sonnet-5-5", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-sonnet-4-6", 50_000), 1_000_000);
        assert_eq!(claude_context_window("claude-haiku-5-5", 50_000), 1_000_000);
        // Past 200k proves the extended window regardless of model.
        assert_eq!(claude_context_window("claude-sonnet-4-5", 250_000), 1_000_000);
    }

    #[test]
    fn temp_dirs_are_helper_sessions() {
        let tmp = std::env::temp_dir().join("x");
        assert!(is_temp_path(tmp.to_str().unwrap()));
        assert!(!is_temp_path("/Users/me/Sites/app"));
    }

    #[test]
    fn percent_caps_at_100() {
        assert_eq!(percent(50, 200), 25.0);
        assert_eq!(percent(300, 200), 100.0);
        assert_eq!(percent(1, 0), 0.0);
    }

    #[test]
    fn tail_read_drops_partial_first_line_and_finds_last_turn() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(f, "{}", assistant(false, "claude-opus-5-5", 1, 0, 10_000)).unwrap();
        writeln!(f, "{}", "x".repeat(200)).unwrap();
        writeln!(f, "{}", assistant(false, "claude-opus-5-5", 1, 0, 20_000)).unwrap();
        writeln!(f, "{}", assistant(true, "claude-opus-5-5", 1, 0, 90_000)).unwrap();
        f.flush().unwrap();

        let (whole, covered) = read_tail_lines(f.path(), 1 << 20);
        assert!(covered);
        assert_eq!(whole.len(), 4);

        // A tiny budget starts mid-line; the fragment must not be returned.
        let (tail, covered) = read_tail_lines(f.path(), 50);
        assert!(!covered);
        assert!(tail.len() <= 1);

        let t = latest_claude_turn(f.path()).unwrap();
        assert_eq!(t.used_tokens, 20_001);
    }

    fn tool_line(session: &str, cwd: &str, ts: &str, tool: &str, input: serde_json::Value) -> String {
        serde_json::json!({
            "type": "assistant",
            "sessionId": session,
            "cwd": cwd,
            "timestamp": ts,
            "message": {
                "model": "claude-opus-5-5",
                "content": [{ "type": "tool_use", "name": tool, "input": input }]
            }
        })
        .to_string()
    }

    fn write(path: &Path, lines: &[String]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn subagents_attach_to_parent_without_clobbering_it() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("-Users-me-app");
        write(
            &proj.join("parent.jsonl"),
            &[tool_line("parent", "/Users/me/app", "2026-11-18T10:00:00Z", "Agent",
                serde_json::json!({ "description": "Review the diff" }))],
        );
        let subs = proj.join("parent").join("subagents");
        // Running: no `finished` key; its lines carry the parent's sessionId.
        write(
            &subs.join("agent-aaa.jsonl"),
            &[
                serde_json::json!({ "type": "user", "sessionId": "parent", "cwd": "/Users/me/app",
                    "timestamp": "2026-11-18T10:00:01Z", "message": { "content": "go" } }).to_string(),
                tool_line("parent", "/Users/me/app", "2026-11-18T10:00:05Z", "Read",
                    serde_json::json!({ "file_path": "/Users/me/app/src/a.ts" })),
            ],
        );
        std::fs::write(
            subs.join("agent-aaa.meta.json"),
            r#"{"agentType":"Explore","description":"Map the auth flow","pickedEffortModel":"claude-fable-5-1"}"#,
        )
        .unwrap();
        // Finished.
        write(
            &subs.join("agent-bbb.jsonl"),
            &[tool_line("parent", "/Users/me/app", "2026-11-18T10:00:03Z", "Bash",
                serde_json::json!({ "command": "npm test" }))],
        );
        std::fs::write(
            subs.join("agent-bbb.meta.json"),
            r#"{"agentType":"general-purpose","description":"Run tests","finished":true}"#,
        )
        .unwrap();
        // No meta at all.
        write(
            &subs.join("agent-ccc.jsonl"),
            &[tool_line("parent", "/Users/me/app", "2026-11-18T10:00:02Z", "Grep",
                serde_json::json!({ "pattern": "TODO" }))],
        );

        let a = collect_in(root.path(), 50);
        assert_eq!(a.sessions.len(), 1);
        let s = &a.sessions[0];
        assert_eq!(s.session_id, "parent");
        // The main chat's own last step survives.
        assert_eq!(s.last_tool.as_deref(), Some("Agent"));
        assert_eq!(s.subagents.len(), 3);

        let by_id = |id: &str| s.subagents.iter().find(|x| x.id == id).unwrap();
        let aaa = by_id("aaa");
        assert_eq!(aaa.status, "running");
        assert_eq!(aaa.agent_type.as_deref(), Some("Explore"));
        assert_eq!(aaa.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(aaa.last_tool.as_deref(), Some("Read"));
        assert!(aaa.started_ts < aaa.last_ts);
        assert_eq!(by_id("bbb").status, "done");
        let ccc = by_id("ccc");
        assert_eq!(ccc.status, "running");
        assert!(ccc.description.is_none());
        assert_eq!(ccc.model.as_deref(), Some("claude-opus-5-5"));
        // Running first.
        assert_eq!(s.subagents[2].id, "bbb");
        // Session counts the subagents' newer work.
        assert_eq!(s.last_ts, aaa.last_ts);

        let read = a.feed.iter().find(|e| e.tool == "Read").unwrap();
        assert_eq!(read.session_id, "parent");
        assert_eq!(read.subagent_id.as_deref(), Some("aaa"));
        assert_eq!(read.subagent.as_deref(), Some("Map the auth flow"));
        let agent = a.feed.iter().find(|e| e.tool == "Agent").unwrap();
        assert!(agent.subagent.is_none());

        assert_eq!(running_subagents(&proj.join("parent.jsonl")), 2);
    }

    #[test]
    fn quiet_parent_still_shows_its_running_subagent() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("-Users-me-app");
        let subs = proj.join("parent").join("subagents");
        write(
            &subs.join("agent-aaa.jsonl"),
            &[tool_line("parent", "/Users/me/app", "2026-11-18T10:00:05Z", "Edit",
                serde_json::json!({ "file_path": "/Users/me/app/x.rs" }))],
        );
        let a = collect_in(root.path(), 50);
        assert_eq!(a.sessions.len(), 1);
        let s = &a.sessions[0];
        assert_eq!(s.session_id, "parent");
        assert_eq!(s.cwd.as_deref(), Some("/Users/me/app"));
        assert!(s.last_tool.is_none());
        assert_eq!(s.subagents.len(), 1);
        assert_eq!(a.feed.len(), 1);
    }

    /// Prints live subagents on this machine.
    /// `cargo test live_subagents_smoke -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_subagents_smoke() {
        let t = std::time::Instant::now();
        let a = collect(40);
        println!("collect took {:?}", t.elapsed());
        for s in a.sessions.iter().filter(|s| !s.subagents.is_empty()) {
            println!("{} {:?}", s.session_id, s.cwd);
            for sub in &s.subagents {
                println!("  {sub:?}");
            }
        }
        for e in a.feed.iter().filter(|e| e.subagent.is_some()).take(5) {
            println!("feed: {e:?}");
        }
    }

    /// Prints the contexts for sessions running on this machine.
    /// `cargo test live_contexts_smoke -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_contexts_smoke() {
        let procs = crate::scanners::processes::scan();
        for c in contexts()
            .into_iter()
            .chain(crate::scanners::live_codex::contexts(&procs))
            .chain(crate::scanners::live_cursor::contexts(&procs))
        {
            println!("{c:?}");
        }
    }
}
