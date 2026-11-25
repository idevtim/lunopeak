//! The merged, cross-provider feeds behind the Live view: activity, context
//! fill and running agent processes. The app's IPC commands and the node both
//! call these, so a provider added to `scanners` shows up in both places.

use crate::models::{
    ActiveProcess, AgentSources, LiveActivity, LiveContext, LiveEvent, SessionLiveState,
};
use crate::scanners;

/// Which providers to read. Mirrors the on/off half of `AgentSources`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sources {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
}

impl Sources {
    pub const ALL: Sources = Sources {
        claude: true,
        codex: true,
        cursor: true,
    };

    pub fn any(self) -> bool {
        self.claude || self.codex || self.cursor
    }
}

impl From<&AgentSources> for Sources {
    fn from(a: &AgentSources) -> Self {
        Sources {
            claude: a.claude_code,
            codex: a.codex,
            cursor: a.cursor,
        }
    }
}

/// Tool-use feed (newest first, at most `limit`) plus per-session state from
/// every enabled provider.
pub fn live_activity(src: Sources, limit: usize) -> LiveActivity {
    let mut feed: Vec<LiveEvent> = Vec::new();
    let mut sessions: Vec<SessionLiveState> = Vec::new();
    if src.claude {
        let mut a = scanners::live::collect(limit);
        feed.append(&mut a.feed);
        sessions.append(&mut a.sessions);
    }
    if src.codex {
        let mut b = scanners::live_codex::collect(limit);
        feed.append(&mut b.feed);
        sessions.append(&mut b.sessions);
    }
    if src.cursor {
        let mut c = scanners::live_cursor::collect(limit);
        feed.append(&mut c.feed);
        sessions.append(&mut c.sessions);
    }
    feed.sort_by_key(|e| std::cmp::Reverse(e.ts));
    feed.truncate(limit);
    sessions.sort_by_key(|s| std::cmp::Reverse(s.last_ts));
    LiveActivity { feed, sessions }
}

/// Context-window fill for each running session, busy first, then freshest.
pub fn live_contexts(src: Sources) -> Vec<LiveContext> {
    let mut out = Vec::new();
    if src.claude {
        out.extend(scanners::live::contexts());
    }
    // Claude maps pids itself; Codex and Cursor pair against the process
    // table, so only pay for the full scan when one of them is on.
    if src.codex || src.cursor {
        let procs = scanners::processes::scan();
        if src.codex {
            out.extend(scanners::live_codex::contexts(&procs));
        }
        if src.cursor {
            out.extend(scanners::live_cursor::contexts(&procs));
        }
    }
    out.sort_by(|a, b| {
        let busy = |c: &LiveContext| c.status.as_deref() == Some("busy");
        busy(b).cmp(&busy(a)).then(b.last_ts.cmp(&a.last_ts))
    });
    out
}

/// Running agent processes, minus providers the user switched off so the
/// Live view doesn't surface a PID for a source that's gated everywhere else.
pub fn active_processes(src: Sources) -> Vec<ActiveProcess> {
    let mut procs = scanners::processes::scan();
    // Strip `.exe` so the match works the same on Windows and macOS.
    procs.retain(|p| {
        let raw = p.name.to_lowercase();
        let name = raw.strip_suffix(".exe").unwrap_or(&raw);
        let is_claude = name == "claude" || name == "cline" || name.starts_with("claude ");
        let is_codex = name == "codex" || name.starts_with("codex ");
        let is_cursor = name == "cursor" || name.starts_with("cursor ");
        if is_claude {
            src.claude
        } else if is_codex {
            src.codex
        } else if is_cursor {
            src.cursor
        } else {
            true
        }
    });
    procs
}
