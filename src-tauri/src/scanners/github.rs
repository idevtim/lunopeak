use crate::models::{GithubStatus, PullRequest, PullRequestList};
use crate::process_ext::NoWindow;
use rayon::prelude::*;
use serde::Deserialize;
use std::path::Path;
use std::process::Command;

/// Probe the local `gh` CLI. Distinguishes "not installed" from "installed
/// but logged out" so the UI can show the right next step.
pub fn status() -> GithubStatus {
    let version = Command::new("gh").no_window().arg("--version").output();
    let installed = matches!(&version, Ok(o) if o.status.success());
    if !installed {
        return GithubStatus {
            installed: false,
            authenticated: false,
            user: None,
            message: None,
        };
    }
    let auth = Command::new("gh")
        .no_window()
        .args(["auth", "status"])
        .output();
    let (authenticated, message) = match auth {
        Ok(o) if o.status.success() => (true, None),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let stdout = String::from_utf8_lossy(&o.stdout);
            let combined = if !stderr.trim().is_empty() {
                stderr
            } else {
                stdout
            };
            let first_line = combined
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(str::to_string);
            (false, first_line)
        }
        _ => (false, Some("could not run gh auth status".into())),
    };
    let user = if authenticated {
        Command::new("gh")
            .no_window()
            .args(["api", "user", "--jq", ".login"])
            .output()
            .ok()
            .and_then(|o| {
                if !o.status.success() {
                    return None;
                }
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                (!s.is_empty()).then_some(s)
            })
    } else {
        None
    };
    GithubStatus {
        installed,
        authenticated,
        user,
        message,
    }
}

/// `(owner, name)` for the `origin` remote, when it points at github.com.
/// Returns None for non-GitHub remotes, missing remotes, or git errors.
fn read_github_origin(repo: &Path) -> Option<(String, String)> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    parse_github_url(&url)
}

/// Accept the three URL shapes git emits for github.com: SSH (`git@`), HTTPS,
/// and the older `ssh://` form. Strips a trailing `.git`. Anything else
/// returns None — we'd rather skip a repo than guess at a non-GitHub host.
fn parse_github_url(url: &str) -> Option<(String, String)> {
    let body = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("git://github.com/"))?;
    let body = body.trim_end_matches('/');
    let body = body.strip_suffix(".git").unwrap_or(body);
    let mut parts = body.splitn(2, '/');
    let owner = parts.next()?.trim().to_string();
    let repo = parts.next()?.trim().to_string();
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner, repo))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuthor {
    login: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u32,
    title: String,
    url: String,
    author: Option<RawAuthor>,
    head_ref_name: Option<String>,
    is_draft: Option<bool>,
    review_decision: Option<String>,
    updated_at: Option<String>,
}

/// Open PRs across all tracked repos with a github.com origin. Per-repo gh
/// invocations run in parallel — gh's startup cost is the main contributor
/// to wall time, and each call is independent.
pub fn list_open(repos: &[(String, String)]) -> PullRequestList {
    let status = status();

    // Even when gh isn't installed/authed we still walk the repo list so the
    // UI can report "you have N github repos but gh isn't set up" — much more
    // actionable than a flat "no PRs".
    let candidates: Vec<(String, String, String, String)> = repos
        .iter()
        .filter_map(|(name, path)| {
            let (owner, repo) = read_github_origin(Path::new(path))?;
            Some((name.clone(), path.clone(), owner, repo))
        })
        .collect();
    let github_repo_count = candidates.len() as u32;

    if !status.installed || !status.authenticated {
        return PullRequestList {
            status,
            prs: Vec::new(),
            github_repo_count,
        };
    }

    let mut prs: Vec<PullRequest> = candidates
        .into_par_iter()
        .flat_map_iter(|(repo_name, repo_path, owner, repo)| {
            gh_list_prs(&owner, &repo)
                .into_iter()
                .map(move |raw| PullRequest {
                    number: raw.number,
                    title: raw.title,
                    url: raw.url,
                    author: raw.author.and_then(|a| a.login).unwrap_or_default(),
                    head_ref: raw.head_ref_name.unwrap_or_default(),
                    is_draft: raw.is_draft.unwrap_or(false),
                    review_decision: raw.review_decision.filter(|d| !d.is_empty()),
                    updated_at_ms: raw.updated_at.as_deref().and_then(parse_iso_to_ms),
                    repo_name: repo_name.clone(),
                    repo_path: repo_path.clone(),
                    owner: owner.clone(),
                    repo: repo.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect();

    // Newest activity first — matches the rest of the dashboard's ordering
    // and means the PRs the user is actively shipping float to the top.
    prs.sort_by(|a, b| {
        b.updated_at_ms
            .unwrap_or(0)
            .cmp(&a.updated_at_ms.unwrap_or(0))
    });

    PullRequestList {
        status,
        prs,
        github_repo_count,
    }
}

fn gh_list_prs(owner: &str, repo: &str) -> Vec<RawPr> {
    let out = Command::new("gh")
        .no_window()
        .args([
            "pr",
            "list",
            "-R",
            &format!("{owner}/{repo}"),
            "--state",
            "open",
            "--json",
            "number,title,url,author,headRefName,isDraft,reviewDecision,updatedAt",
            "--limit",
            "50",
        ])
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    serde_json::from_slice(&out.stdout).unwrap_or_default()
}

fn parse_iso_to_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::parse_github_url;

    #[test]
    fn parses_common_remote_shapes() {
        assert_eq!(
            parse_github_url("git@github.com:owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
        assert_eq!(
            parse_github_url("https://github.com/owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
        assert_eq!(
            parse_github_url("https://github.com/owner/repo"),
            Some(("owner".into(), "repo".into()))
        );
        assert_eq!(
            parse_github_url("ssh://git@github.com/owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
    }

    #[test]
    fn rejects_non_github_and_malformed() {
        assert_eq!(parse_github_url("git@gitlab.com:owner/repo.git"), None);
        assert_eq!(parse_github_url("https://example.com/owner/repo"), None);
        assert_eq!(parse_github_url("https://github.com/owner"), None);
        assert_eq!(
            parse_github_url("https://github.com/owner/sub/repo.git"),
            None
        );
    }
}
