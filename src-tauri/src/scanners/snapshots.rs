use crate::models::{Snapshot, SnapshotRepo};
use crate::process_ext::NoWindow;
use anyhow::{Context, Result};
use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

fn snapshots_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("could not determine app config dir")?
        .join("snapshots");
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Capture a snapshot from the given repos. Each repo contributes its
/// branch, HEAD SHA, dirty flag, and diff file list. Cheap enough to run
/// synchronously across dozens of repos.
pub fn capture(
    app: &AppHandle,
    repos: &[(String, String)],
    name: &str,
    note: Option<&str>,
) -> Result<Snapshot> {
    let mut entries = Vec::new();
    for (repo_name, repo_path) in repos {
        entries.push(capture_repo(repo_name, repo_path));
    }

    let snapshot = Snapshot {
        id: Uuid::new_v4().to_string(),
        name: name.trim().to_string(),
        note: note.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
        created_ts: Utc::now().timestamp_millis(),
        repos: entries,
    };

    let path = snapshots_dir(app)?.join(format!("{}.json", snapshot.id));
    fs::write(&path, serde_json::to_string_pretty(&snapshot)?)?;
    Ok(snapshot)
}

fn capture_repo(repo_name: &str, repo_path: &str) -> SnapshotRepo {
    let p = Path::new(repo_path);
    let branch = git_text(p, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let head = git_text(p, &["rev-parse", "--short=7", "HEAD"]);

    let porcelain = git_text(p, &["status", "--porcelain"]).unwrap_or_default();
    let dirty = !porcelain.trim().is_empty();

    let diff_files: Vec<String> = if dirty {
        git_text(p, &["diff", "HEAD", "--name-only"])
            .map(|s| {
                s.lines()
                    .map(str::to_string)
                    .filter(|l| !l.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let (insertions, deletions) = if dirty {
        parse_shortstat(&git_text(p, &["diff", "HEAD", "--shortstat"]).unwrap_or_default())
    } else {
        (0, 0)
    };

    SnapshotRepo {
        repo_name: repo_name.to_string(),
        repo_path: repo_path.to_string(),
        branch: branch.filter(|b| b != "HEAD"),
        head,
        dirty,
        diff_files,
        insertions,
        deletions,
    }
}

fn git_text(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn parse_shortstat(s: &str) -> (u32, u32) {
    let mut ins = 0;
    let mut del = 0;
    for chunk in s.split(',') {
        let c = chunk.trim();
        let Some((num, kind)) = c.split_once(' ') else {
            continue;
        };
        let Ok(n) = num.parse::<u32>() else { continue };
        if kind.starts_with("insertion") {
            ins = n;
        } else if kind.starts_with("deletion") {
            del = n;
        }
    }
    (ins, del)
}

pub fn list(app: &AppHandle) -> Result<Vec<Snapshot>> {
    let dir = snapshots_dir(app)?;
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(snap) = serde_json::from_str::<Snapshot>(&raw) {
                out.push(snap);
            }
        }
    }
    out.sort_by(|a, b| b.created_ts.cmp(&a.created_ts));
    Ok(out)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<()> {
    // Reject anything with path separators — defensive against an injection
    // attempt that would let `id` traverse out of the snapshots dir.
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(anyhow::anyhow!("invalid snapshot id"));
    }
    let path = snapshots_dir(app)?.join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
