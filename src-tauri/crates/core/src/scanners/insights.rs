//! Cross-repo activity stats ("Insights"), in the spirit of GitHub's Pulse.
//!
//! Git numbers come from local `git log` over each repo's default branch
//! (the remote-tracking ref unioned with the local branch of the same name),
//! so they need no network and are only as fresh as the last fetch. PR
//! numbers come from `gh` in a separate pass because it's slow and online.

use crate::models::{
    HotFile, InsightAuthor, InsightPr, PrInsights, PrSession, PullRequestList, RepoInsight,
    RepoInsights, RepoPrInsight, Session,
};
use crate::process_ext::NoWindow;
use crate::scanners::github;
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Timelike};
use rayon::prelude::*;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

/// Agent names matched (case-insensitively) in `Co-authored-by` trailers.
const AGENT_MARKERS: &[&str] = &["claude", "anthropic", "codex", "openai", "cursor", "copilot"];
const HOT_FILES: usize = 8;

// ── Period and buckets ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Unit {
    Hour,
    Day,
    Week,
}

#[derive(Debug, Clone)]
pub struct Period {
    pub days: u32,
    pub unit: Unit,
    pub since: DateTime<Local>,
    pub now: DateTime<Local>,
    pub count: usize,
}

fn local_midnight(d: NaiveDate) -> DateTime<Local> {
    let ndt = d.and_hms_opt(0, 0, 0).expect("midnight exists");
    Local
        .from_local_datetime(&ndt)
        .earliest()
        // A DST gap at midnight: fall back to 1am, which always exists.
        .unwrap_or_else(|| Local.from_local_datetime(&(ndt + Duration::hours(1))).unwrap())
}

impl Period {
    /// 1 day → 24 hourly buckets; up to 31 days → calendar days ending today;
    /// longer → whole weeks ending today.
    pub fn new(days: u32, now: DateTime<Local>) -> Self {
        let days = days.clamp(1, 366);
        if days <= 1 {
            let hour = now
                .with_minute(0)
                .and_then(|t| t.with_second(0))
                .and_then(|t| t.with_nanosecond(0))
                .unwrap_or(now);
            return Period { days, unit: Unit::Hour, since: hour - Duration::hours(23), now, count: 24 };
        }
        let today = now.date_naive();
        if days <= 31 {
            let since = local_midnight(today - Duration::days(days as i64 - 1));
            return Period { days, unit: Unit::Day, since, now, count: days as usize };
        }
        let weeks = days.div_ceil(7) as usize;
        let since = local_midnight(today - Duration::days(weeks as i64 * 7 - 1));
        Period { days, unit: Unit::Week, since, now, count: weeks }
    }

    pub fn unit_name(&self) -> &'static str {
        match self.unit {
            Unit::Hour => "hour",
            Unit::Day => "day",
            Unit::Week => "week",
        }
    }

    pub fn bucket_starts(&self) -> Vec<i64> {
        (0..self.count)
            .map(|i| match self.unit {
                Unit::Hour => (self.since + Duration::hours(i as i64)).timestamp_millis(),
                Unit::Day => local_midnight(self.since.date_naive() + Duration::days(i as i64))
                    .timestamp_millis(),
                Unit::Week => local_midnight(self.since.date_naive() + Duration::days(i as i64 * 7))
                    .timestamp_millis(),
            })
            .collect()
    }

    /// Bucket for a unix timestamp (seconds), or None outside the period.
    pub fn bucket_of(&self, ts: i64) -> Option<usize> {
        if ts < self.since.timestamp() {
            return None;
        }
        let idx = match self.unit {
            Unit::Hour => ((ts - self.since.timestamp()) / 3600) as usize,
            Unit::Day | Unit::Week => {
                let d = Local.timestamp_opt(ts, 0).single()?.date_naive();
                let n = (d - self.since.date_naive()).num_days();
                if n < 0 {
                    return None;
                }
                n as usize / if self.unit == Unit::Week { 7 } else { 1 }
            }
        };
        (idx < self.count).then_some(idx)
    }

    /// Start of the equal-length window just before this one.
    fn prev_since(&self) -> DateTime<Local> {
        self.since - (self.now - self.since)
    }
}

// ── git log parsing ───────────────────────────────────────────────────

#[derive(Debug, Default, PartialEq)]
pub struct RawCommit {
    pub ts: i64,
    pub name: String,
    pub email: String,
    pub agent: bool,
    /// (path, additions, deletions); binary files count as 0/0.
    pub files: Vec<(String, u64, u64)>,
}

/// `%x1e` starts each record; the header is `%ct %x1f %aN %x1f %aE %x1f
/// trailers`, followed by `--numstat` lines (`add\tdel\tpath`).
pub const LOG_FORMAT: &str =
    "--format=%x1e%ct%x1f%aN%x1f%aE%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)";

pub fn parse_log(text: &str) -> Vec<RawCommit> {
    text.split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|record| {
            let mut lines = record.lines();
            let header = lines.next()?;
            let mut f = header.split('\x1f');
            let ts = f.next()?.trim().parse::<i64>().ok()?;
            let name = f.next().unwrap_or("").to_string();
            let email = f.next().unwrap_or("").to_string();
            let trailers = f.next().unwrap_or("").to_lowercase();
            let agent = AGENT_MARKERS.iter().any(|m| trailers.contains(m));
            let files = lines
                .filter_map(|l| {
                    let mut p = l.splitn(3, '\t');
                    let a = p.next()?;
                    let d = p.next()?;
                    let path = p.next()?.trim();
                    if path.is_empty() {
                        return None;
                    }
                    Some((
                        normalize_rename(path),
                        a.parse().unwrap_or(0),
                        d.parse().unwrap_or(0),
                    ))
                })
                .collect();
            Some(RawCommit { ts, name, email, agent, files })
        })
        .collect()
}

/// numstat writes renames as `dir/{old => new}/f` or `old => new`; keep the new path.
fn normalize_rename(path: &str) -> String {
    if let (Some(open), Some(close)) = (path.find('{'), path.find('}')) {
        if open < close {
            let inner = &path[open + 1..close];
            if let Some((_, new)) = inner.split_once(" => ") {
                let joined = format!("{}{}{}", &path[..open], new, &path[close + 1..]);
                return joined.replace("//", "/");
            }
        }
    }
    match path.split_once(" => ") {
        Some((_, new)) => new.to_string(),
        None => path.to_string(),
    }
}

// ── per-repo git collection ───────────────────────────────────────────

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The default branch as refs to union: the remote-tracking ref (fresh
/// after a fetch, includes PRs merged on GitHub) plus the local branch of
/// the same name (includes unpushed work). Falls back to HEAD.
fn default_refs(repo: &Path) -> Vec<String> {
    let remote_head = git(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let existing: HashSet<String> = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads/main",
            "refs/heads/master",
            "refs/remotes/origin/main",
            "refs/remotes/origin/master",
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(str::to_string)
    .collect();

    let branch = remote_head
        .as_deref()
        .and_then(|r| r.strip_prefix("origin/"))
        .map(str::to_string)
        .or_else(|| {
            ["main", "master"]
                .iter()
                .find(|b| existing.contains(**b) || existing.contains(&format!("origin/{b}")))
                .map(|b| b.to_string())
        });
    let Some(branch) = branch else { return vec!["HEAD".into()] };

    let mut refs = Vec::new();
    let remote = format!("origin/{branch}");
    if remote_head.is_some() || existing.contains(&remote) {
        refs.push(remote);
    }
    if existing.contains(&branch)
        || git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_some()
    {
        refs.push(branch);
    }
    if refs.is_empty() {
        refs.push("HEAD".into());
    }
    refs
}

fn count(repo: &Path, args: &[&str]) -> u32 {
    git(repo, args)
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

fn last_fetch_ms(repo: &Path) -> Option<i64> {
    let meta = std::fs::metadata(repo.join(".git").join("FETCH_HEAD")).ok()?;
    let t = meta.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}

pub fn summarize(name: &str, path: &str, refs: Vec<String>, commits: &[RawCommit], period: &Period) -> RepoInsight {
    let n = period.count;
    let mut ins = RepoInsight {
        name: name.to_string(),
        path: path.to_string(),
        refs,
        commits: 0,
        prev_commits: 0,
        all_branch_commits: 0,
        additions: 0,
        deletions: 0,
        files_changed: 0,
        agent_commits: 0,
        commits_by_bucket: vec![0; n],
        additions_by_bucket: vec![0; n],
        deletions_by_bucket: vec![0; n],
        authors: Vec::new(),
        hot_files: Vec::new(),
        last_commit_ms: commits.iter().map(|c| c.ts * 1000).max(),
        last_fetch_ms: None,
        sessions: 0,
        agent_cost_usd: 0.0,
    };
    let mut authors: HashMap<String, InsightAuthor> = HashMap::new();
    let mut files: HashMap<String, HotFile> = HashMap::new();
    for c in commits {
        let Some(b) = period.bucket_of(c.ts) else { continue };
        ins.commits += 1;
        ins.commits_by_bucket[b] += 1;
        if c.agent {
            ins.agent_commits += 1;
        }
        let (add, del) = c.files.iter().fold((0, 0), |(a, d), f| (a + f.1, d + f.2));
        ins.additions += add;
        ins.deletions += del;
        ins.additions_by_bucket[b] += add;
        ins.deletions_by_bucket[b] += del;
        let key = if c.email.is_empty() { c.name.to_lowercase() } else { c.email.to_lowercase() };
        let a = authors.entry(key).or_insert_with(|| InsightAuthor {
            name: c.name.clone(),
            email: c.email.clone(),
            commits: 0,
            additions: 0,
            deletions: 0,
        });
        a.commits += 1;
        a.additions += add;
        a.deletions += del;
        for (p, fa, fd) in &c.files {
            let h = files.entry(p.clone()).or_insert_with(|| HotFile {
                path: p.clone(),
                commits: 0,
                additions: 0,
                deletions: 0,
            });
            h.commits += 1;
            h.additions += fa;
            h.deletions += fd;
        }
    }
    ins.files_changed = files.len() as u32;
    ins.authors = authors.into_values().collect();
    ins.authors.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));
    let mut hot: Vec<HotFile> = files.into_values().collect();
    hot.sort_by(|a, b| {
        b.commits
            .cmp(&a.commits)
            .then((b.additions + b.deletions).cmp(&(a.additions + a.deletions)))
            .then(a.path.cmp(&b.path))
    });
    hot.truncate(HOT_FILES);
    ins.hot_files = hot;
    ins
}

fn repo_insight(name: &str, path: &str, period: &Period) -> RepoInsight {
    let p = Path::new(path);
    let refs = default_refs(p);
    let since = format!("--since={}", period.since.to_rfc3339());
    let mut args: Vec<&str> = vec!["log", "--no-merges", "--numstat", LOG_FORMAT, &since];
    args.extend(refs.iter().map(String::as_str));
    args.push("--");
    let commits = git(p, &args).map(|t| parse_log(&t)).unwrap_or_default();
    let mut ins = summarize(name, path, refs.clone(), &commits, period);

    let prev_since = format!("--since={}", period.prev_since().to_rfc3339());
    let until = format!("--until={}", period.since.to_rfc3339());
    let mut prev_args: Vec<&str> = vec!["rev-list", "--count", "--no-merges", &prev_since, &until];
    prev_args.extend(refs.iter().map(String::as_str));
    prev_args.push("--");
    ins.prev_commits = count(p, &prev_args);
    ins.all_branch_commits = count(
        p,
        &["rev-list", "--count", "--no-merges", &since, "--branches", "--remotes", "--"],
    )
    .max(ins.commits);
    if ins.last_commit_ms.is_none() {
        let mut last: Vec<&str> = vec!["log", "-1", "--format=%ct"];
        last.extend(refs.iter().map(String::as_str));
        last.push("--");
        ins.last_commit_ms = git(p, &last).and_then(|s| s.trim().parse::<i64>().ok()).map(|t| t * 1000);
    }
    ins.last_fetch_ms = last_fetch_ms(p);
    ins
}

fn in_repo(project: &str, repo: &str) -> bool {
    project == repo
        || project
            .strip_prefix(repo)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
}

pub fn collect(repos: &[(String, String)], days: u32, sessions: &[Session]) -> RepoInsights {
    let period = Period::new(days, Local::now());
    let since_ms = period.since.timestamp_millis();
    let mut out: Vec<RepoInsight> = repos
        .par_iter()
        .map(|(name, path)| repo_insight(name, path, &period))
        .collect();
    for s in sessions.iter().filter(|s| s.start_ts >= since_ms) {
        let Some(project) = s.project_path.as_deref() else { continue };
        // Longest matching repo path wins so nested repos aren't double counted.
        if let Some(r) = out
            .iter_mut()
            .filter(|r| in_repo(project, &r.path))
            .max_by_key(|r| r.path.len())
        {
            r.sessions += 1;
            r.agent_cost_usd += s.cost_usd;
        }
    }
    out.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));
    RepoInsights {
        days: period.days,
        since_ms,
        until_ms: period.now.timestamp_millis(),
        bucket_unit: period.unit_name().into(),
        buckets: period.bucket_starts(),
        repos: out,
    }
}

// ── Pull requests via gh ──────────────────────────────────────────────

#[derive(Deserialize)]
struct RawLogin {
    login: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInsightPr {
    number: u32,
    title: String,
    url: String,
    author: Option<RawLogin>,
    created_at: Option<String>,
    merged_at: Option<String>,
    #[serde(default)]
    head_ref_name: String,
}

fn gh_prs_since(slug: &str, since: DateTime<Local>) -> Result<Vec<RawInsightPr>, String> {
    // `updated:` is a date in UTC; a day of slack, filtered exactly below.
    // No additions/deletions: they make gh ~8x slower (26s vs 3s for 370
    // PRs), and git already reports line counts.
    let date = (since.with_timezone(&chrono::Utc) - Duration::days(1)).format("%Y-%m-%d");
    let out = Command::new("gh")
        .no_window()
        .args([
            "pr",
            "list",
            "-R",
            slug,
            "--state",
            "all",
            "--search",
            &format!("updated:>={date}"),
            "--json",
            "number,title,url,author,createdAt,mergedAt,headRefName",
            "--limit",
            "1000",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().find(|l| !l.trim().is_empty()).unwrap_or("gh failed").to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// PR activity for every github.com repo. `open` is the open-PR list the
/// app already caches for the dashboard, reused for "open now" counts.
pub fn collect_prs(repos: &[(String, String)], days: u32, open: &PullRequestList) -> PrInsights {
    let period = Period::new(days, Local::now());
    let since_ms = period.since.timestamp_millis();
    let candidates: Vec<(String, String, String)> = repos
        .iter()
        .filter_map(|(name, path)| {
            let (owner, repo) = github::read_github_origin(Path::new(path))?;
            Some((name.clone(), path.clone(), format!("{owner}/{repo}")))
        })
        .collect();
    let github_repo_count = candidates.len() as u32;
    let status = open.status.clone();
    if !status.installed || !status.authenticated {
        return PrInsights { status, github_repo_count, repos: Vec::new() };
    }
    let mut out: Vec<RepoPrInsight> = candidates
        .into_par_iter()
        .map(|(name, path, slug)| {
            let open_now = open.prs.iter().filter(|p| p.repo_path == path).count() as u32;
            let default_branch = default_refs(Path::new(&path))
                .last()
                .filter(|r| r.as_str() != "HEAD")
                .map(|r| r.strip_prefix("origin/").unwrap_or(r).to_string());
            let mut ins = RepoPrInsight {
                name,
                path,
                slug: slug.clone(),
                merged: Vec::new(),
                opened: 0,
                open_now,
                default_branch,
                error: None,
            };
            match gh_prs_since(&slug, period.since) {
                Ok(raw) => {
                    for pr in raw {
                        let created = pr.created_at.as_deref().and_then(github::parse_iso_to_ms).unwrap_or(0);
                        if created >= since_ms {
                            ins.opened += 1;
                        }
                        let Some(merged) = pr.merged_at.as_deref().and_then(github::parse_iso_to_ms) else {
                            continue;
                        };
                        if merged < since_ms {
                            continue;
                        }
                        ins.merged.push(InsightPr {
                            number: pr.number,
                            title: pr.title,
                            url: pr.url,
                            author: pr.author.and_then(|a| a.login).unwrap_or_default(),
                            created_at_ms: created,
                            merged_at_ms: merged,
                            head_ref: pr.head_ref_name,
                            agent_cost_usd: 0.0,
                            agent_sessions: Vec::new(),
                        });
                    }
                    ins.merged.sort_by_key(|p| std::cmp::Reverse(p.merged_at_ms));
                }
                Err(e) => ins.error = Some(e),
            }
            ins
        })
        .collect();
    out.sort_by(|a, b| b.merged.len().cmp(&a.merged.len()).then(a.name.cmp(&b.name)));
    PrInsights { status, github_repo_count, repos: out }
}

// ── What each PR cost ─────────────────────────────────────────────────

/// How far before a PR opened its branch's spend still counts. Retries
/// usually start days before the PR, but a branch name reused months later
/// ("fix-tests") shouldn't inherit the old spend.
const PR_LOOKBACK_MS: i64 = 14 * 24 * 3600 * 1000;

/// Fill each merged PR's agent cost from Claude sessions' spend on its head
/// branch in the same repo. Only spend from after the previous merge of the
/// same branch name (or `PR_LOOKBACK_MS` before the PR opened) up to this
/// PR's merge counts, minute by minute (`Session::cost_by_branch`), so a
/// session that keeps going on the branch after a merge bills the rest to
/// the next PR from it, or to nothing, and a session that also did other
/// work is split. Runs on every request over the cached `gh` data, so
/// sessions that finish after the PR list was fetched still show up.
pub fn attach_pr_costs(prs: &mut PrInsights, sessions: &[Session]) {
    let repo_paths: Vec<String> = prs.repos.iter().map(|r| r.path.clone()).collect();
    for repo in &mut prs.repos {
        // Longest matching repo wins, so a nested repo keeps its own sessions.
        let mine: Vec<&Session> = sessions
            .iter()
            .filter(|s| !s.cost_by_branch.is_empty())
            .filter(|s| {
                let Some(project) = s.project_path.as_deref() else { return false };
                in_repo(project, &repo.path)
                    && !repo_paths
                        .iter()
                        .any(|p| p.len() > repo.path.len() && in_repo(project, p))
            })
            .collect();
        let mut order: Vec<usize> = (0..repo.merged.len()).collect();
        order.sort_by_key(|&i| repo.merged[i].merged_at_ms);
        let mut last_merge: HashMap<String, i64> = HashMap::new();
        for i in order {
            let pr = &mut repo.merged[i];
            pr.agent_cost_usd = 0.0;
            pr.agent_sessions.clear();
            if pr.head_ref.is_empty() || repo.default_branch.as_deref() == Some(pr.head_ref.as_str()) {
                continue;
            }
            // `created_at_ms` is 0 when gh's timestamp didn't parse; measure
            // the lookback from the merge then, rather than from 1970.
            let opened = if pr.created_at_ms > 0 { pr.created_at_ms } else { pr.merged_at_ms };
            let after = last_merge
                .get(&pr.head_ref)
                .copied()
                .unwrap_or(i64::MIN)
                .max(opened - PR_LOOKBACK_MS);
            last_merge.insert(pr.head_ref.clone(), pr.merged_at_ms);
            if after >= pr.merged_at_ms {
                continue;
            }
            for s in &mine {
                let Some(minutes) = s.cost_by_branch.get(&pr.head_ref) else { continue };
                let (turns, cost) = minutes
                    .range(after + 1..=pr.merged_at_ms)
                    .fold((0usize, 0.0_f64), |(n, c), (_, v)| (n + 1, c + v));
                if turns == 0 {
                    continue;
                }
                pr.agent_cost_usd += cost;
                pr.agent_sessions.push(PrSession {
                    id: s.id.clone(),
                    start_ts: s.start_ts,
                    end_ts: s.end_ts,
                    cost_usd: cost,
                    session_cost_usd: s.cost_usd,
                    first_prompt: s.first_prompt.clone(),
                    model: s.model.clone(),
                });
            }
            pr.agent_sessions.sort_by_key(|s| s.start_ts);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_records_with_numstat_and_trailers() {
        let text = "\x1e1700000000\x1fTim\x1ftim@x.dev\x1fClaude <noreply@anthropic.com>\n\n12\t3\tsrc/a.rs\n-\t-\timg.png\n\x1e1700000500\x1fSam\x1fsam@x.dev\x1f\n\n1\t0\tsrc/{old => new}/b.ts\n";
        let c = parse_log(text);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].ts, 1700000000);
        assert!(c[0].agent);
        assert_eq!(c[0].files, vec![("src/a.rs".into(), 12, 3), ("img.png".into(), 0, 0)]);
        assert!(!c[1].agent);
        assert_eq!(c[1].files[0].0, "src/new/b.ts");
    }

    #[test]
    fn normalizes_renames() {
        assert_eq!(normalize_rename("a => b"), "b");
        assert_eq!(normalize_rename("x/{a => b}/c"), "x/b/c");
        assert_eq!(normalize_rename("x/{ => b}/c"), "x/b/c");
        assert_eq!(normalize_rename("plain/path"), "plain/path");
    }

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, h, 30, 0).unwrap()
    }

    #[test]
    fn daily_period_buckets_by_calendar_day() {
        let p = Period::new(7, at(2026, 11, 20, 15));
        assert_eq!(p.count, 7);
        assert_eq!(p.since.date_naive(), NaiveDate::from_ymd_opt(2026, 11, 14).unwrap());
        assert_eq!(p.bucket_of(at(2026, 11, 14, 0).timestamp()), Some(0));
        assert_eq!(p.bucket_of(at(2026, 11, 20, 14).timestamp()), Some(6));
        assert_eq!(p.bucket_of(at(2026, 11, 13, 23).timestamp()), None);
        assert_eq!(p.bucket_starts().len(), 7);
    }

    #[test]
    fn hourly_and_weekly_periods() {
        let h = Period::new(1, at(2026, 11, 20, 15));
        assert_eq!(h.unit, Unit::Hour);
        assert_eq!(h.bucket_of(at(2026, 11, 20, 15).timestamp()), Some(23));
        let w = Period::new(90, at(2026, 11, 20, 15));
        assert_eq!(w.unit, Unit::Week);
        assert_eq!(w.count, 13);
        assert_eq!(w.bucket_of(at(2026, 11, 20, 15).timestamp()), Some(12));
    }

    #[test]
    fn summarize_counts_authors_files_and_buckets() {
        let p = Period::new(7, at(2026, 11, 20, 15));
        let commits = vec![
            RawCommit { ts: at(2026, 11, 19, 9).timestamp(), name: "Tim".into(), email: "T@x".into(), agent: true, files: vec![("a".into(), 5, 1)] },
            RawCommit { ts: at(2026, 11, 20, 9).timestamp(), name: "Tim".into(), email: "t@x".into(), agent: false, files: vec![("a".into(), 2, 2), ("b".into(), 1, 0)] },
            RawCommit { ts: at(2026, 11, 1, 9).timestamp(), name: "Old".into(), email: "o@x".into(), agent: false, files: vec![] },
        ];
        let s = summarize("r", "/r", vec!["main".into()], &commits, &p);
        assert_eq!(s.commits, 2);
        assert_eq!(s.agent_commits, 1);
        assert_eq!((s.additions, s.deletions), (8, 3));
        assert_eq!(s.authors.len(), 1);
        assert_eq!(s.files_changed, 2);
        assert_eq!(s.hot_files[0].path, "a");
        assert_eq!(s.commits_by_bucket[5..], [1, 1]);
    }

    #[test]
    fn session_path_matching() {
        assert!(in_repo("/a/repo", "/a/repo"));
        assert!(in_repo("/a/repo/sub", "/a/repo"));
        assert!(!in_repo("/a/repo2", "/a/repo"));
    }

    /// `spend` is (branch, minute ms, cost); `start_ts` is the earliest minute.
    fn session(id: &str, project: &str, spend: &[(&str, i64, f64)]) -> Session {
        let start_ts = spend.iter().map(|x| x.1).min().unwrap_or(0);
        let mut cost_by_branch = crate::models::BranchSpend::new();
        for &(b, t, c) in spend {
            *cost_by_branch.entry(b.into()).or_default().entry(t).or_insert(0.0) += c;
        }
        Session {
            host: None,
            id: id.into(),
            project_path: Some(project.into()),
            project_name: None,
            branch: None,
            model: None,
            start_ts,
            end_ts: start_ts + 1,
            message_count: 0,
            first_prompt: None,
            usage: Default::default(),
            cost_usd: spend.iter().map(|x| x.2).sum(),
            cost_by_day: Default::default(),
            cost_by_slot: Default::default(),
            subagent_count: 0,
            subagent_cost_usd: 0.0,
            cost_by_branch,
            tool_uses: Default::default(),
            tool_errors: 0,
            tool_errors_by_name: Default::default(),
            tool_sequences: Default::default(),
            files_edited: Default::default(),
            bash_commands: Default::default(),
        }
    }

    fn pr(number: u32, head: &str, created: i64, merged: i64) -> InsightPr {
        InsightPr {
            number,
            title: String::new(),
            url: String::new(),
            author: String::new(),
            created_at_ms: created,
            merged_at_ms: merged,
            head_ref: head.into(),
            agent_cost_usd: 0.0,
            agent_sessions: Vec::new(),
        }
    }

    #[test]
    fn pr_costs_sum_retries_on_the_head_branch() {
        const DAY: i64 = 86_400_000;
        let t0 = 100 * DAY;
        let mut prs = PrInsights {
            status: crate::models::GithubStatus { installed: true, authenticated: true, user: None, message: None },
            github_repo_count: 1,
            repos: vec![RepoPrInsight {
                name: "r".into(),
                path: "/r".into(),
                slug: "o/r".into(),
                // Same branch name merged twice: the second PR must not
                // inherit the first one's sessions.
                merged: vec![pr(2, "fix", t0 + 5 * DAY, t0 + 6 * DAY), pr(1, "fix", t0, t0 + DAY), pr(3, "main", t0, t0 + DAY)],
                opened: 3,
                open_now: 0,
                default_branch: Some("main".into()),
                error: None,
            }],
        };
        const MIN: i64 = 60_000;
        let sessions = vec![
            session("a", "/r", &[("fix", t0 - DAY, 2.0)]), // first attempt
            session("b", "/r/sub", &[("fix", t0 + DAY / 2, 3.0), ("main", t0 + DAY / 2 + MIN, 9.0)]), // retry, split
            // Kept going on the branch after PR 1 merged: the rest is PR 2's.
            session("g", "/r", &[("fix", t0 + DAY - MIN, 1.0), ("fix", t0 + DAY + MIN, 4.0)]),
            session("c", "/r", &[("fix", t0 + 4 * DAY, 5.0)]), // second PR
            session("d", "/r", &[("fix", t0 + 7 * DAY, 7.0)]), // after merge
            session("e", "/other", &[("fix", t0, 11.0)]),      // other repo
            session("f", "/r", &[("fix", t0 - 30 * DAY, 13.0)]), // too old
        ];
        attach_pr_costs(&mut prs, &sessions);
        let m = &prs.repos[0].merged;
        let ids = |p: &InsightPr| p.agent_sessions.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(&m[1]), ["a", "b", "g"]);
        assert_eq!(m[1].agent_cost_usd, 6.0);
        assert_eq!(m[1].agent_sessions[1].session_cost_usd, 12.0);
        assert_eq!(m[1].agent_sessions[2].cost_usd, 1.0);
        assert_eq!(ids(&m[0]), ["g", "c"]);
        assert_eq!(m[0].agent_cost_usd, 9.0);
        assert!(m[2].agent_sessions.is_empty(), "default branch PRs get no cost");
    }

    /// `LUNOPEAK_INSIGHTS_REPO=/path cargo test -p lunopeak-core insights_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn insights_live() {
        let path = std::env::var("LUNOPEAK_INSIGHTS_REPO").expect("set LUNOPEAK_INSIGHTS_REPO");
        let days: u32 = std::env::var("LUNOPEAK_INSIGHTS_DAYS").ok().and_then(|d| d.parse().ok()).unwrap_or(7);
        let repos = vec![("repo".to_string(), path)];
        let t = std::time::Instant::now();
        let open = github::list_open(&repos);
        let prs = collect_prs(&repos, days, &open);
        for p in &prs.repos {
            println!(
                "prs: {} merged={} opened={} open_now={} error={:?} ({:?})",
                p.slug, p.merged.len(), p.opened, p.open_now, p.error, t.elapsed()
            );
        }
        let r = collect(&repos, days, &[]);
        let i = &r.repos[0];
        println!(
            "refs={:?} commits={} prev={} all={} +{} -{} files={} agent={} authors={:?} buckets={:?}",
            i.refs, i.commits, i.prev_commits, i.all_branch_commits, i.additions, i.deletions,
            i.files_changed, i.agent_commits,
            i.authors.iter().map(|a| (&a.name, a.commits)).collect::<Vec<_>>(), i.commits_by_bucket
        );
    }
}
