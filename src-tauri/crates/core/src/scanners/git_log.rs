use crate::models::{DiffStat, RepoActivity, Session, TimelineEvent};
use crate::process_ext::NoWindow;
use chrono::{DateTime, Local, Utc};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

/// Per-repo `git diff --stat` summary for repos with uncommitted changes.
/// Skips clean repos via a quick `git status --porcelain` test.
pub fn diff_stats(repos: &[(String, String, Option<String>)]) -> Vec<DiffStat> {
    let mut out = Vec::new();
    for (name, path, branch) in repos {
        let p = Path::new(path);
        // Cheap dirty check first
        let dirty = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(p)
            .args(["status", "--porcelain"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);
        if !dirty {
            continue;
        }

        // Get a list of files changed
        let names = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(p)
            .args(["diff", "HEAD", "--name-only"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(o.stdout)
                } else {
                    None
                }
            })
            .map(|stdout| {
                String::from_utf8_lossy(&stdout)
                    .lines()
                    .map(str::to_string)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // git diff --shortstat → " 3 files changed, 42 insertions(+), 7 deletions(-)"
        let shortstat = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(p)
            .args(["diff", "HEAD", "--shortstat"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(o.stdout)
                } else {
                    None
                }
            })
            .map(|stdout| String::from_utf8_lossy(&stdout).into_owned())
            .unwrap_or_default();

        let (files_changed, insertions, deletions) = parse_shortstat(&shortstat);

        out.push(DiffStat {
            repo_name: name.clone(),
            repo_path: path.clone(),
            branch: branch.clone(),
            files_changed: files_changed.max(names.len() as u32),
            insertions,
            deletions,
            files: names,
        });
    }
    out.sort_by(|a, b| {
        let a_total = a.insertions + a.deletions;
        let b_total = b.insertions + b.deletions;
        b_total.cmp(&a_total)
    });
    out
}

fn parse_shortstat(s: &str) -> (u32, u32, u32) {
    let mut files = 0;
    let mut ins = 0;
    let mut del = 0;
    for chunk in s.split(',') {
        let c = chunk.trim();
        let Some((num, kind)) = c.split_once(' ') else {
            continue;
        };
        let Ok(n) = num.parse::<u32>() else { continue };
        if kind.starts_with("file") {
            files = n;
        } else if kind.starts_with("insertion") {
            ins = n;
        } else if kind.starts_with("deletion") {
            del = n;
        }
    }
    (files, ins, del)
}

/// Recent commits (`git log --since=30.days`) across all repos.
pub fn recent_commits(repos: &[(String, String)]) -> Vec<TimelineEvent> {
    let mut events = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        let output = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(p)
            .args([
                "log",
                "--since=30.days",
                "--pretty=format:%H\x1f%at\x1f%an\x1f%s",
                "--no-merges",
            ])
            .output();
        let Ok(out) = output else { continue };
        if !out.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let parts: Vec<&str> = line.split('\x1f').collect();
            if parts.len() != 4 {
                continue;
            }
            let Ok(unix) = parts[1].parse::<i64>() else {
                continue;
            };
            events.push(TimelineEvent::Commit {
                ts: unix * 1000,
                repo: name.clone(),
                sha: parts[0].chars().take(7).collect(),
                author: parts[2].to_string(),
                subject: parts[3].to_string(),
            });
        }
    }
    events
}

/// Combine sessions + commits into a single chronological feed.
pub fn timeline(sessions: &[Session], repos: &[(String, String)]) -> Vec<TimelineEvent> {
    let mut events: Vec<TimelineEvent> = sessions
        .iter()
        .filter(|s| s.start_ts > 0)
        .map(|s| TimelineEvent::Session {
            ts: s.start_ts,
            id: s.id.clone(),
            title: s
                .first_prompt
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string),
            project: s.project_name.clone().or_else(|| s.project_path.clone()),
            model: s.model.clone(),
            cost_usd: s.cost_usd,
            message_count: s.message_count,
        })
        .collect();
    events.extend(recent_commits(repos));
    events.sort_by(|a, b| event_ts(b).cmp(&event_ts(a)));
    events.truncate(200);
    events
}

fn event_ts(e: &TimelineEvent) -> i64 {
    match e {
        TimelineEvent::Session { ts, .. } => *ts,
        TimelineEvent::Commit { ts, .. } => *ts,
    }
}

/// Per-repo per-day activity (sessions started + commits authored) for the
/// last 30 days. Used by both Repo Pulse + Work Graph.
pub fn repo_activity(sessions: &[Session], repos: &[(String, String)]) -> Vec<RepoActivity> {
    // Bucket per local-day so the 30-day histogram lines up with the
    // user's calendar, not UTC.
    let today = Local::now().date_naive();
    // Resolve the local git user once. Per-repo `user.email` overrides are
    // queried lazily below — most users only have a global identity, so we
    // skip the per-repo call when the global value matches.
    let global_email = git_global_email();

    // Map sessions onto repos by project_path
    let mut session_buckets: HashMap<String, ([u32; 30], u32)> = HashMap::new();
    for s in sessions {
        let Some(path) = &s.project_path else {
            continue;
        };
        let Some(dt) = DateTime::<Utc>::from_timestamp_millis(s.start_ts) else {
            continue;
        };
        let diff = today
            .signed_duration_since(dt.with_timezone(&Local).date_naive())
            .num_days();
        if !(0..30).contains(&diff) {
            continue;
        }
        let entry = session_buckets.entry(path.clone()).or_insert(([0; 30], 0));
        entry.0[29 - diff as usize] += 1;
        entry.1 += 1;
    }

    let mut out = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        let (s_days, s_total) = session_buckets.get(path).copied().unwrap_or(([0; 30], 0));

        // Pick the email this repo will match against. Repos with a local
        // override (work identity in a personal scan dir) get their own.
        let mine_email = git_repo_email(p).or_else(|| global_email.clone());

        // git log --since=30.days with author-email field so we can split
        // total commits from "mine".
        let mut c_days = [0u32; 30];
        let mut c_total = 0u32;
        let mut m_c_days = [0u32; 30];
        let mut m_c_total = 0u32;
        let output = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(p)
            .args([
                "log",
                "--since=30.days",
                "--pretty=format:%at\x1f%ae",
                "--no-merges",
            ])
            .output();
        if let Ok(out_) = output {
            if out_.status.success() {
                for line in String::from_utf8_lossy(&out_.stdout).lines() {
                    let mut parts = line.splitn(2, '\x1f');
                    let unix_s = parts.next().unwrap_or("");
                    let email = parts.next().unwrap_or("");
                    let Ok(unix) = unix_s.parse::<i64>() else {
                        continue;
                    };
                    let Some(dt) = DateTime::<Utc>::from_timestamp(unix, 0) else {
                        continue;
                    };
                    let diff = today
                        .signed_duration_since(dt.with_timezone(&Local).date_naive())
                        .num_days();
                    if !(0..30).contains(&diff) {
                        continue;
                    }
                    let idx = 29 - diff as usize;
                    c_days[idx] += 1;
                    c_total += 1;
                    if let Some(me) = mine_email.as_deref() {
                        if email.eq_ignore_ascii_case(me) {
                            m_c_days[idx] += 1;
                            m_c_total += 1;
                        }
                    }
                }
            }
        }

        let mut combined = [0u32; 30];
        let mut mine = [0u32; 30];
        for i in 0..30 {
            combined[i] = s_days[i] + c_days[i];
            // Sessions are always the local user — count them in mine too.
            mine[i] = s_days[i] + m_c_days[i];
        }

        // Skip totally inactive repos to keep the view focused
        if s_total == 0 && c_total == 0 {
            continue;
        }

        out.push(RepoActivity {
            repo_name: name.clone(),
            repo_path: path.clone(),
            days: combined.to_vec(),
            total_sessions: s_total,
            total_commits: c_total,
            mine_days: mine.to_vec(),
            mine_commits: m_c_total,
        });
    }

    out.sort_by(|a, b| {
        let a_total = a.total_sessions + a.total_commits;
        let b_total = b.total_sessions + b.total_commits;
        b_total.cmp(&a_total)
    });
    out
}

fn git_global_email() -> Option<String> {
    let out = Command::new("git")
        .no_window()
        .args(["config", "--global", "--get", "user.email"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn git_repo_email(repo: &Path) -> Option<String> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["config", "--local", "--get", "user.email"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
