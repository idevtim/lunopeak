use crate::models::{BranchInfo, DirtyFile, FileDiff, Repo, RepoStash};
use crate::process_ext::NoWindow;
use anyhow::Result;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_DEPTH: usize = 4;
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
];

/// Scan the given roots for git repositories. Returns a flat list.
pub fn scan_roots(roots: &[String]) -> Result<Vec<Repo>> {
    let mut repos = Vec::new();
    for root in roots {
        let root_path = PathBuf::from(root);
        if !root_path.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root_path)
            .max_depth(MAX_DEPTH)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                if e.depth() == 0 {
                    return true;
                }
                if name.starts_with('.') && name != ".git" {
                    return false;
                }
                !SKIP_DIRS.contains(&name.as_ref())
            })
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.file_name().is_some_and(|n| n == ".git") && path.is_dir() {
                if let Some(repo_path) = path.parent() {
                    if let Some(repo) = repo_from_path(repo_path) {
                        repos.push(repo);
                    }
                }
            }
        }
    }
    Ok(repos)
}

fn repo_from_path(path: &Path) -> Option<Repo> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let path_str = path.to_string_lossy().to_string();
    let has_claude_md = path.join("CLAUDE.md").is_file();
    let branch = read_head_branch(path);
    Some(Repo {
        id: Uuid::new_v4().to_string(),
        name,
        path: path_str,
        branch,
        has_claude_md,
        has_uncommitted: read_has_uncommitted(path),
        last_activity_ts: read_last_commit_ts(path),
        size_kb: None,
    })
}

/// `git status --porcelain` exits 0 with empty stdout when clean. Anything
/// else (including non-zero exit on a broken repo) we report as "unknown",
/// represented as `false` to avoid false alarms.
fn read_has_uncommitted(repo: &Path) -> bool {
    let output = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["status", "--porcelain"])
        .output();
    match output {
        Ok(out) if out.status.success() => !out.stdout.is_empty(),
        _ => false,
    }
}

fn read_head_branch(repo: &Path) -> Option<String> {
    let head = repo.join(".git").join("HEAD");
    let raw = std::fs::read_to_string(head).ok()?;
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("ref: refs/heads/") {
        Some(rest.to_string())
    } else if !trimmed.is_empty() {
        // Detached HEAD — return short SHA
        Some(trimmed.chars().take(7).collect())
    } else {
        None
    }
}

/// Subject line of HEAD's commit. Returns None on empty repos or git errors.
pub fn read_last_commit_subject(repo: &Path) -> Option<String> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["log", "-1", "--pretty=%s"])
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

/// Number of local commits ahead of the upstream tracking branch. Returns 0
/// when no upstream is configured (detached HEAD, no remote, etc).
pub fn read_unpushed_count(repo: &Path) -> u32 {
    let out = match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["rev-list", "--count", "@{u}..HEAD"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return 0,
    };
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u32>()
        .unwrap_or(0)
}

/// Per-file rows of `git status --porcelain` (staged, unstaged, untracked).
/// Returns an empty vec for clean repos or on git errors. Renames surface
/// as their new path with status "R".
pub fn read_dirty_files(repo: &Path) -> Vec<DirtyFile> {
    let out = match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["status", "--porcelain=v1", "-z"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let mut files = Vec::new();
    let mut iter = out.stdout.split(|b| *b == 0);
    while let Some(record) = iter.next() {
        if record.len() < 3 {
            continue;
        }
        let staged = (record[0] as char).to_string();
        let unstaged = (record[1] as char).to_string();
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        // Rename/copy entries are followed by an extra NUL-delimited
        // "old path" record. Drop it — we only display the new name.
        let is_rename = staged == "R" || staged == "C" || unstaged == "R" || unstaged == "C";
        if is_rename {
            iter.next();
        }
        files.push(DirtyFile {
            path,
            staged,
            unstaged,
        });
    }
    files
}

/// Number of files with any kind of pending change (staged, unstaged, or
/// untracked). Mirrors the row count of `git status --porcelain`.
pub fn read_uncommitted_files(repo: &Path) -> u32 {
    let out = match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["status", "--porcelain"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return 0,
    };
    out.stdout.iter().filter(|&&b| b == b'\n').count() as u32
}

/// Full `git stash list` parsed into reflog + subject + the files each stash
/// touches. Empty when no stash exists or git can't be invoked.
pub fn read_stashes(repo: &Path) -> Vec<RepoStash> {
    let out = match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["stash", "list", "--pretty=format:%gd|%gs"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut stashes = Vec::new();
    for line in stdout.lines() {
        let Some((reflog, subject)) = line.split_once('|') else {
            continue;
        };
        let reflog = reflog.trim().to_string();
        let files = read_stash_files(repo, &reflog);
        stashes.push(RepoStash {
            reflog,
            subject: subject.trim().to_string(),
            files,
        });
    }
    stashes
}

/// File paths touched by a single stash (`git stash show <reflog> --name-only`).
fn read_stash_files(repo: &Path, reflog: &str) -> Vec<String> {
    let out = match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["stash", "show", "--name-only", reflog])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Count of entries in `git stash list`.
pub fn read_stash_count(repo: &Path) -> u32 {
    let out = match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["stash", "list"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return 0,
    };
    out.stdout.iter().filter(|&&b| b == b'\n').count() as u32
}

fn read_last_commit_ts(repo: &Path) -> Option<i64> {
    // Cheap approximation: mtime of HEAD's referenced ref file.
    let head = repo.join(".git").join("HEAD");
    let raw = std::fs::read_to_string(&head).ok()?;
    let trimmed = raw.trim();
    let target = if let Some(rest) = trimmed.strip_prefix("ref: ") {
        repo.join(".git").join(rest)
    } else {
        head
    };
    let metadata = std::fs::metadata(target).ok()?;
    let modified = metadata.modified().ok()?;
    let secs = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(secs as i64 * 1000)
}

fn git_stdout(repo: &Path, args: &[&str]) -> Option<Vec<u8>> {
    match Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
    {
        Ok(o) if o.status.success() => Some(o.stdout),
        _ => None,
    }
}

/// Longest patch we ship per file. Big generated files (lockfiles, bundles)
/// would otherwise blow up the IPC payload for no reading value.
const MAX_PATCH_LINES: usize = 1500;
/// Untracked files are read straight off disk; skip anything bigger.
const MAX_UNTRACKED_BYTES: u64 = 256 * 1024;
const MAX_UNTRACKED_FILES: usize = 100;

/// Path from a `diff --git` header (minus the prefix). Without renames both
/// halves name the same file, so the header is `a/<p> b/<p>` (or each half
/// quoted when the path has control characters, quotes or backslashes).
/// Splitting at the midpoint handles paths that themselves contain " b/".
fn diff_header_path(header: &str) -> Option<String> {
    if let Some(rest) = header.strip_prefix("\"a/") {
        // Quoted: "a/<p>" "b/<p>" — take the first half, keep it as git
        // escaped it (rare enough that unescaping isn't worth it).
        let (p, _) = rest.split_once("\" \"b/")?;
        return Some(p.to_string());
    }
    let rest = header.strip_prefix("a/")?;
    // rest = "<p> b/<p>", so len = 2·len(p) + 3.
    let n = rest.len().checked_sub(3)? / 2;
    let (p, tail) = (rest.get(..n)?, rest.get(n..)?);
    (tail.strip_prefix(" b/") == Some(p)).then(|| p.to_string())
}

/// Uncommitted changes against HEAD, one entry per file, with the unified
/// diff body. Untracked files come back as new files with every line added.
pub fn read_file_diffs(repo: &Path) -> Vec<FileDiff> {
    let mut out: Vec<FileDiff> = Vec::new();

    // Tracked changes. `--no-renames` keeps one path per section so the
    // numstat rows and the patch sections line up by name.
    // quotePath=false keeps non-ASCII names literal instead of octal-escaped.
    if let Some(raw) = git_stdout(
        repo,
        &["-c", "core.quotePath=false", "diff", "HEAD", "--no-renames", "--no-color", "--no-ext-diff"],
    ) {
        let text = String::from_utf8_lossy(&raw);
        for section in text.split("\ndiff --git ").map(|s| s.trim_start_matches("diff --git ")) {
            if section.trim().is_empty() {
                continue;
            }
            let header = section.lines().next().unwrap_or("");
            let Some(path) = diff_header_path(header) else {
                continue;
            };
            let mut diff = FileDiff {
                path,
                insertions: 0,
                deletions: 0,
                is_new: false,
                is_deleted: false,
                binary: false,
                patch: String::new(),
                truncated: false,
            };
            let mut in_hunks = false;
            let mut lines = 0usize;
            for line in section.lines().skip(1) {
                if !in_hunks {
                    if line.starts_with("new file mode") {
                        diff.is_new = true;
                    } else if line.starts_with("deleted file mode") {
                        diff.is_deleted = true;
                    } else if line.starts_with("Binary files") {
                        diff.binary = true;
                    } else if line.starts_with("@@") {
                        in_hunks = true;
                    }
                    if !in_hunks {
                        continue;
                    }
                }
                if line.starts_with('+') {
                    diff.insertions += 1;
                } else if line.starts_with('-') {
                    diff.deletions += 1;
                }
                if lines < MAX_PATCH_LINES {
                    diff.patch.push_str(line);
                    diff.patch.push('\n');
                    lines += 1;
                } else {
                    diff.truncated = true;
                }
            }
            out.push(diff);
        }
    }

    // Untracked files never show up in `git diff`.
    if let Some(raw) = git_stdout(repo, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        for rel in raw
            .split(|b| *b == 0)
            .filter(|r| !r.is_empty())
            .take(MAX_UNTRACKED_FILES)
        {
            let path = String::from_utf8_lossy(rel).into_owned();
            let full = repo.join(&path);
            let mut diff = FileDiff {
                path,
                insertions: 0,
                deletions: 0,
                is_new: true,
                is_deleted: false,
                binary: false,
                patch: String::new(),
                truncated: false,
            };
            let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
            match (size <= MAX_UNTRACKED_BYTES)
                .then(|| std::fs::read(&full).ok())
                .flatten()
                .map(String::from_utf8)
            {
                Some(Ok(body)) => {
                    let total = body.lines().count();
                    diff.insertions = total as u32;
                    diff.patch = format!("@@ -0,0 +1,{total} @@\n");
                    for line in body.lines().take(MAX_PATCH_LINES) {
                        diff.patch.push('+');
                        diff.patch.push_str(line);
                        diff.patch.push('\n');
                    }
                    diff.truncated = total > MAX_PATCH_LINES;
                }
                Some(Err(_)) => diff.binary = true,
                None => diff.truncated = true,
            }
            out.push(diff);
        }
    }

    out
}

const DEFAULT_BRANCHES: &[&str] = &["main", "master", "develop", "trunk"];
const MAX_BRANCHES: usize = 60;

/// Local branches with their tip time and distance from the default branch.
/// Sorted current first, then default, then newest tip first.
pub fn read_branches(repo: &Path) -> Vec<BranchInfo> {
    let Some(raw) = git_stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%09%(committerdate:unix)%09%(HEAD)",
            "refs/heads",
        ],
    ) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&raw);
    let mut rows: Vec<(String, Option<i64>, bool)> = text
        .lines()
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let name = parts.next()?.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let ts = parts.next().and_then(|t| t.trim().parse::<i64>().ok()).map(|s| s * 1000);
            let current = parts.next().map(|h| h.trim() == "*").unwrap_or(false);
            Some((name, ts, current))
        })
        .collect();
    let default = DEFAULT_BRANCHES
        .iter()
        .find(|d| rows.iter().any(|(n, _, _)| n == *d))
        .map(|d| d.to_string());
    // Order before capping: for-each-ref lists alphabetically, so truncating
    // first would drop branches by name — possibly the current one.
    rows.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then((default.as_deref() == Some(b.0.as_str())).cmp(&(default.as_deref() == Some(a.0.as_str()))))
            .then(b.1.unwrap_or(0).cmp(&a.1.unwrap_or(0)))
    });

    let out: Vec<BranchInfo> = rows
        .into_iter()
        .take(MAX_BRANCHES)
        .map(|(name, last_commit_ts, is_current)| {
            let is_default = default.as_deref() == Some(name.as_str());
            // None when rev-list fails: the counts are unknown, so the branch
            // must not be reported merged (that offers it up for deletion).
            let counts: Option<(u32, u32)> = match (&default, is_default) {
                (Some(d), false) => git_stdout(
                    repo,
                    &["rev-list", "--left-right", "--count", &format!("{d}...{name}")],
                )
                .and_then(|o| {
                    let s = String::from_utf8_lossy(&o).to_string();
                    let mut it = s.split_whitespace();
                    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
                }),
                _ => None,
            };
            let (behind, ahead) = counts.unwrap_or((0, 0));
            BranchInfo {
                merged: counts.is_some_and(|(_, ahead)| ahead == 0),
                name,
                is_current,
                is_default,
                last_commit_ts,
                ahead,
                behind,
            }
        })
        .collect();
    out
}

#[cfg(test)]
mod tests {
    use super::diff_header_path;

    #[test]
    fn diff_header_path_handles_spaces_unicode_and_quotes() {
        assert_eq!(diff_header_path("a/src/x.rs b/src/x.rs").as_deref(), Some("src/x.rs"));
        assert_eq!(diff_header_path("a/a b/c.txt b/a b/c.txt").as_deref(), Some("a b/c.txt"));
        assert_eq!(diff_header_path("a/café.txt b/café.txt").as_deref(), Some("café.txt"));
        assert_eq!(
            diff_header_path(r#""a/q\"x.txt" "b/q\"x.txt""#).as_deref(),
            Some(r#"q\"x.txt"#)
        );
        assert_eq!(diff_header_path("garbage"), None);
    }
}
