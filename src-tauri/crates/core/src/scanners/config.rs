use crate::models::{ClaudeMdEntry, ConfigArtifact, HookEntry, HygieneIssue, RepoSetup, Severity};
use crate::process_ext::NoWindow;
use crate::scanners::git as git_scanner;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const TOKEN_RATIO: f64 = 0.25; // ≈4 chars per token, ≈0.75 tokens per word

fn home_claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

fn estimate_tokens(words: u32, bytes: u64) -> u32 {
    let by_words = (words as f64 * 0.75) as u32;
    let by_chars = (bytes as f64 * TOKEN_RATIO) as u32;
    by_words.max(by_chars)
}

fn count_words(s: &str) -> u32 {
    s.split_whitespace().count() as u32
}

// ── CLAUDE.md ──────────────────────────────────────────────────────────

/// Every instruction / memory file agents read: the global ~/.claude/CLAUDE.md
/// and ~/.codex/AGENTS.md, each repo's CLAUDE.md and AGENTS.md, and the
/// notes Claude auto-saves under ~/.claude/projects/<slug>/memory/.
pub fn scan_claude_md(repo_paths: &[(String, String)]) -> Vec<ClaudeMdEntry> {
    let mut out = Vec::new();

    if let Some(global) = home_claude_dir().map(|p| p.join("CLAUDE.md")) {
        out.extend(read_claude_md(&global, None, None, "global", "claude-md"));
    }
    if let Some(global) = dirs::home_dir().map(|h| h.join(".codex").join("AGENTS.md")) {
        out.extend(read_claude_md(&global, None, None, "global", "agents-md"));
    }

    let projects_dir = home_claude_dir().map(|p| p.join("projects"));
    for (name, path) in repo_paths {
        let root = Path::new(path);
        for (file, kind) in [("CLAUDE.md", "claude-md"), ("AGENTS.md", "agents-md")] {
            out.extend(read_claude_md(
                &root.join(file),
                Some(name.clone()),
                Some(path.clone()),
                "repo",
                kind,
            ));
        }
        let Some(memory_dir) = projects_dir.as_ref().map(|d| d.join(project_slug(path)).join("memory"))
        else {
            continue;
        };
        let Ok(entries) = fs::read_dir(&memory_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("md") {
                out.extend(read_claude_md(&p, Some(name.clone()), Some(path.clone()), "repo", "memory"));
            }
        }
    }

    out.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    out
}

/// Claude Code's per-project directory name: the absolute path with every
/// non-alphanumeric character replaced by `-`.
fn project_slug(path: &str) -> String {
    path.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn read_claude_md(
    path: &Path,
    repo_name: Option<String>,
    repo_path: Option<String>,
    scope: &str,
    kind: &str,
) -> Option<ClaudeMdEntry> {
    let raw = fs::read_to_string(path).ok()?;
    let bytes = raw.len() as u64;
    let words = count_words(&raw);
    let lines = raw.lines().count() as u32;
    let topics = extract_topics(&raw);
    let modified_ms = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    Some(ClaudeMdEntry {
        repo_name,
        repo_path,
        path: path.to_string_lossy().to_string(),
        bytes,
        words,
        estimated_tokens: estimate_tokens(words, bytes),
        scope: scope.into(),
        lines,
        topics,
        body: raw,
        kind: kind.into(),
        description: read_frontmatter(path).and_then(|fm| fm.description),
        modified_ms,
    })
}

/// Markdown H1/H2 headings in source order. Skips fenced code blocks so
/// `# !/bin/sh` inside a snippet isn't picked up. Trims trailing `#` chars
/// (some authors close their headings with hashes).
fn extract_topics(raw: &str) -> Vec<String> {
    let mut topics = Vec::new();
    let mut in_fence = false;
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // H1 (`# `) or H2 (`## `). Skip H3+ to keep the topic list short.
        let stripped = if let Some(s) = trimmed.strip_prefix("## ") {
            Some(s)
        } else {
            trimmed.strip_prefix("# ")
        };
        if let Some(rest) = stripped {
            let title = rest.trim().trim_end_matches('#').trim().to_string();
            if !title.is_empty() {
                topics.push(title);
            }
        }
    }
    topics
}

// ── Skills + Agents share frontmatter parsing ──────────────────────────

#[derive(Debug, Default, Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    model: Option<String>,
    /// `tools` may be a comma string or a YAML list — we capture both.
    tools: Option<Value>,
}

/// Reads the YAML frontmatter from the head of a markdown file.
/// Returns `None` if the file doesn't open with `---`.
fn read_frontmatter(path: &Path) -> Option<Frontmatter> {
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim_start();
    let rest = trimmed.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let yaml = &rest[..end];
    serde_yaml_minimal::from_str(yaml).ok()
}

fn tools_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Array(arr) => {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(", "))
            }
        }
        _ => None,
    }
}

pub fn scan_skills(repo_paths: &[(String, String)]) -> Vec<ConfigArtifact> {
    let mut out = Vec::new();

    if let Some(home) = home_claude_dir() {
        scan_skills_dir(&home.join("skills"), None, None, "global", &mut out);
    }
    for (name, path) in repo_paths {
        let dir = Path::new(path).join(".claude").join("skills");
        scan_skills_dir(
            &dir,
            Some(name.clone()),
            Some(path.clone()),
            "repo",
            &mut out,
        );
    }
    for (plugin, dir) in crate::scanners::install::plugin_install_dirs() {
        scan_skills_dir(&dir.join("skills"), Some(plugin), None, "plugin", &mut out);
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_skills_dir(
    dir: &Path,
    repo_name: Option<String>,
    repo_path: Option<String>,
    scope: &str,
    out: &mut Vec<ConfigArtifact>,
) {
    if !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            // Skill directory — look for a SKILL.md or skill.md
            for candidate in ["SKILL.md", "skill.md"] {
                let f = p.join(candidate);
                if f.is_file() {
                    if let Some(art) = build_artifact(
                        &f,
                        repo_name.clone(),
                        repo_path.clone(),
                        scope,
                        Some(p.file_name().unwrap().to_string_lossy().to_string()),
                    ) {
                        out.push(art);
                    }
                    break;
                }
            }
        } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Some(art) = build_artifact(&p, repo_name.clone(), repo_path.clone(), scope, None)
            {
                out.push(art);
            }
        }
    }
}

pub fn scan_agents(repo_paths: &[(String, String)]) -> Vec<ConfigArtifact> {
    let mut out = Vec::new();

    if let Some(home) = home_claude_dir() {
        scan_agents_dir(&home.join("agents"), None, None, "global", &mut out);
    }
    for (name, path) in repo_paths {
        let dir = Path::new(path).join(".claude").join("agents");
        scan_agents_dir(
            &dir,
            Some(name.clone()),
            Some(path.clone()),
            "repo",
            &mut out,
        );
    }
    for (plugin, dir) in crate::scanners::install::plugin_install_dirs() {
        scan_agents_dir(&dir.join("agents"), Some(plugin), None, "plugin", &mut out);
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_agents_dir(
    dir: &Path,
    repo_name: Option<String>,
    repo_path: Option<String>,
    scope: &str,
    out: &mut Vec<ConfigArtifact>,
) {
    if !dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("md") {
            if let Some(art) = build_artifact(&p, repo_name.clone(), repo_path.clone(), scope, None)
            {
                out.push(art);
            }
        }
    }
}

fn build_artifact(
    path: &Path,
    repo_name: Option<String>,
    repo_path: Option<String>,
    scope: &str,
    fallback_name: Option<String>,
) -> Option<ConfigArtifact> {
    let fm = read_frontmatter(path).unwrap_or_default();
    let name = fm
        .name
        .or(fallback_name)
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;
    Some(ConfigArtifact {
        name,
        description: fm.description,
        model: fm.model,
        tools: fm.tools.as_ref().and_then(tools_to_string),
        repo_name,
        repo_path,
        path: path.to_string_lossy().to_string(),
        scope: scope.into(),
    })
}

// ── Hooks (parsed from settings.json) ──────────────────────────────────

pub fn scan_hooks(repo_paths: &[(String, String)]) -> Vec<HookEntry> {
    let mut out = Vec::new();

    if let Some(home) = home_claude_dir() {
        let p = home.join("settings.json");
        if let Some(parsed) = read_hooks_from_settings(&p) {
            for mut h in parsed {
                h.scope = "global".into();
                out.push(h);
            }
        }
    }

    for (name, path) in repo_paths {
        let p = Path::new(path).join(".claude").join("settings.json");
        if let Some(parsed) = read_hooks_from_settings(&p) {
            for mut h in parsed {
                h.repo_name = Some(name.clone());
                h.repo_path = Some(path.clone());
                h.scope = "repo".into();
                out.push(h);
            }
        }
    }

    out.sort_by(|a, b| {
        a.event
            .cmp(&b.event)
            .then_with(|| a.command.cmp(&b.command))
    });
    out
}

/// Settings shape (relevant slice):
/// {
///   "hooks": {
///     "PostToolUse": [
///       { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "..." }] }
///     ]
///   }
/// }
fn read_hooks_from_settings(path: &Path) -> Option<Vec<HookEntry>> {
    let raw = fs::read_to_string(path).ok()?;
    // Strip JSON-with-comments tolerantly: serde_json doesn't accept comments,
    // but Claude's settings.json sometimes has a $schema field — ignore unknown fields.
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let hooks_obj = parsed.get("hooks")?.as_object()?;

    let mut out = Vec::new();
    for (event, val) in hooks_obj {
        let arr = match val {
            Value::Array(a) => a,
            _ => continue,
        };
        for item in arr {
            let matcher = item
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(str::to_owned);
            let hooks = item.get("hooks").and_then(|v| v.as_array());
            match hooks {
                Some(hs) => {
                    for h in hs {
                        if let Some(cmd) = h.get("command").and_then(|v| v.as_str()) {
                            out.push(HookEntry {
                                event: event.clone(),
                                matcher: matcher.clone(),
                                command: cmd.to_string(),
                                repo_name: None,
                                repo_path: None,
                                scope: "repo".into(), // Filled by caller
                                source_path: Some(path.to_string_lossy().into_owned()),
                            });
                        }
                    }
                }
                None => {
                    // older format: { event: { command: "..." } } — best-effort
                    if let Some(cmd) = item.get("command").and_then(|v| v.as_str()) {
                        out.push(HookEntry {
                            event: event.clone(),
                            matcher,
                            command: cmd.to_string(),
                            repo_name: None,
                            repo_path: None,
                            scope: "repo".into(),
                            source_path: Some(path.to_string_lossy().into_owned()),
                        });
                    }
                }
            }
        }
    }
    Some(out)
}

// ── Hygiene + Setup ────────────────────────────────────────────────────

pub fn hygiene_for(repos: &[(String, String)]) -> Vec<HygieneIssue> {
    // Each repo's checks are independent and dominated by subprocess latency
    // (several `git` calls plus a `du` per heavy dir), so fan them out across
    // cores — this per-repo work is the bulk of the Hygiene page's load time.
    let mut out: Vec<HygieneIssue> = repos
        .par_iter()
        .flat_map_iter(|(name, path)| hygiene_for_repo(name, path))
        .collect();

    // Sort: errors first, then warns, then infos
    out.sort_by_key(|i| match i.severity {
        Severity::Error => 0,
        Severity::Warn => 1,
        Severity::Info => 2,
    });
    out
}

/// All hygiene checks for one repo. Pure per-repo work so `hygiene_for` can fan
/// it out across repos in parallel.
fn hygiene_for_repo(name: &str, path: &str) -> Vec<HygieneIssue> {
    let mut out = Vec::new();
    let p = Path::new(path);
    {
        let claude_md = p.join("CLAUDE.md");
        let gitignore = p.join(".gitignore");
        let env_file = p.join(".env");

        // Computed once (it shells out to `git log`) and reused by both the
        // CLAUDE.md and .gitignore advisories below. Scratch dirs, dotfile/notes
        // repos, and dormant archives don't need either nudge.
        let active_project = is_active_project(p);

        // Only nag about a missing CLAUDE.md for active projects.
        if !claude_md.is_file() && active_project {
            out.push(HygieneIssue {
                repo_name: Some(name.to_string()),
                repo_path: Some(path.to_string()),
                kind: "missing-claude-md".into(),
                message: "No CLAUDE.md — Claude has no project memory here".into(),
                severity: Severity::Info,
                command: None,
                target: None,
                details: None,
            });
        }

        if env_file.is_file() {
            let gi = fs::read_to_string(&gitignore).unwrap_or_default();
            let ignored = gi
                .lines()
                .any(|line| matches!(line.trim(), ".env" | ".env.*" | "*.env"));
            if !ignored {
                out.push(HygieneIssue {
                    repo_name: Some(name.to_string()),
                    repo_path: Some(path.to_string()),
                    kind: "env-not-gitignored".into(),
                    message: ".env exists but isn't gitignored".into(),
                    severity: Severity::Error,
                    command: None,
                    target: None,
                    details: None,
                });
            }
        }

        // Only an active project needs this nudge — a bare `.env` leak is still
        // flagged above regardless, so this is purely the best-practice nag.
        if !gitignore.is_file() && active_project {
            out.push(HygieneIssue {
                repo_name: Some(name.to_string()),
                repo_path: Some(path.to_string()),
                kind: "missing-gitignore".into(),
                message: "No .gitignore — secrets and build artifacts can leak into commits".into(),
                severity: Severity::Warn,
                command: None,
                target: None,
                details: None,
            });
        }

        // Stale local branches: any branch (other than the current one or a
        // protected trunk) whose tip commit is older than 90 days.
        for stale in stale_branches_for(p) {
            let cmd = format!("git -C '{}' branch -D '{}'", path, stale.name);
            out.push(HygieneIssue {
                repo_name: Some(name.to_string()),
                repo_path: Some(path.to_string()),
                kind: "stale-branch".into(),
                message: format!("{} ({}d old)", stale.name, stale.days_old),
                severity: Severity::Warn,
                command: Some(cmd),
                target: Some(stale.name),
                details: None,
            });
        }

        // Uncommitted files: one issue per repo with pending changes.
        let uncommitted = git_scanner::read_uncommitted_files(p);
        if uncommitted > 0 {
            out.push(HygieneIssue {
                repo_name: Some(name.to_string()),
                repo_path: Some(path.to_string()),
                kind: "uncommitted-changes".into(),
                message: format!(
                    "{} uncommitted {}",
                    uncommitted,
                    if uncommitted == 1 { "file" } else { "files" }
                ),
                severity: Severity::Warn,
                command: Some(format!("git -C '{}' status -s", path)),
                target: None,
                details: None,
            });
        }

        // Stash entries: one issue per stash so each can be dropped individually.
        for stash in stash_entries_for(p) {
            out.push(HygieneIssue {
                repo_name: Some(name.to_string()),
                repo_path: Some(path.to_string()),
                kind: "stash".into(),
                message: format!("{}: {}", stash.reflog, stash.subject),
                severity: Severity::Info,
                command: Some(format!("git -C '{}' stash drop {}", path, stash.reflog)),
                target: Some(stash.reflog),
                details: None,
            });
        }

        // Disk usage: oversized build/dep dirs (node_modules, target, .next…)
        // inside the repo. Only surfaces directories above DISK_USAGE_THRESHOLD
        // so the section stays signal-rich.
        for entry in heavy_dirs_for(p, name) {
            out.push(HygieneIssue {
                repo_name: Some(name.to_string()),
                repo_path: Some(path.to_string()),
                kind: "disk-usage".into(),
                message: format!("{} — {}", entry.label, entry.size_human),
                severity: Severity::Info,
                command: Some(format!("rm -rf '{}'", entry.path)),
                target: Some(entry.path.clone()),
                details: Some(entry.path),
            });
        }
    }

    out
}

/// Root-level files that mark a directory as a real, buildable project worth
/// giving Claude project memory. Language-spread on purpose.
const PROJECT_MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "composer.json",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
];

/// How recently a repo must have been committed to before we'll nag about
/// project-hygiene niceties (CLAUDE.md, .gitignore) — dormant projects don't
/// need the nudge.
const PROJECT_ACTIVE_DAYS: i64 = 90;

/// A repo is an "active project" when it's a recognizable project *and* still
/// being worked on. Both conditions must hold — a manifest alone could be an
/// archive, and recent activity alone could be a scratch/notes directory.
///
/// Gates the advisory checks (missing CLAUDE.md, missing .gitignore) so they
/// only fire where they're actually worth acting on. Concrete-risk checks
/// (e.g. an unignored `.env`) stay ungated.
fn is_active_project(repo: &Path) -> bool {
    has_project_manifest(repo) && last_commit_within_days(repo, PROJECT_ACTIVE_DAYS)
}

fn has_project_manifest(repo: &Path) -> bool {
    PROJECT_MANIFESTS.iter().any(|m| repo.join(m).is_file())
}

/// True when the repo's most recent commit is within `days`. Returns false for
/// non-git dirs or repos with no commits (the `git log` call fails), which is
/// the conservative choice — we'd rather under-nag than over-nag.
fn last_commit_within_days(repo: &Path, days: i64) -> bool {
    let output = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["log", "-1", "--format=%ct"])
        .output();
    let out = match output {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    let Ok(ts) = String::from_utf8_lossy(&out.stdout).trim().parse::<i64>() else {
        return false;
    };
    let cutoff = chrono::Utc::now().timestamp() - days * 24 * 60 * 60;
    ts >= cutoff
}

const STALE_BRANCH_DAYS: i64 = 90;
const PROTECTED_BRANCHES: &[&str] = &["main", "master", "develop", "trunk"];

struct StaleBranch {
    name: String,
    days_old: i64,
}

/// Local branches whose tip commit is older than `STALE_BRANCH_DAYS`,
/// skipping the currently checked-out branch and the conventional trunk
/// names. Returns an empty list when git output can't be parsed (e.g. a
/// freshly-init'd repo with no commits).
fn stale_branches_for(repo: &Path) -> Vec<StaleBranch> {
    let now = chrono::Utc::now().timestamp();
    let cutoff = now - STALE_BRANCH_DAYS * 24 * 60 * 60;
    let output = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args([
            "for-each-ref",
            "--format=%(refname:short)|%(committerdate:unix)|%(HEAD)",
            "refs/heads",
        ])
        .output();
    let out = match output {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut stale = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(3, '|');
        let Some(name) = parts.next() else { continue };
        let Some(ts_raw) = parts.next() else { continue };
        let head_marker = parts.next().unwrap_or("").trim();
        if head_marker == "*" {
            continue;
        }
        if PROTECTED_BRANCHES.contains(&name) {
            continue;
        }
        let Ok(ts) = ts_raw.trim().parse::<i64>() else {
            continue;
        };
        if ts <= cutoff {
            let days_old = ((now - ts) / (24 * 60 * 60)).max(0);
            stale.push(StaleBranch {
                name: name.to_string(),
                days_old,
            });
        }
    }
    // Oldest first (longest-stale → most worth pruning).
    stale.sort_by(|a, b| b.days_old.cmp(&a.days_old));
    stale
}

/// Build/dep directory names worth surfacing when they balloon. Names match
/// .gitignore folklore — anything you'd rebuild from scratch without grief.
const HEAVY_DIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    ".cache",
];
/// Surface directories above this size only — below that they're just normal.
const DISK_USAGE_THRESHOLD_BYTES: u64 = 500 * 1024 * 1024;

struct HeavyDir {
    /// Display label like `lunopeak/node_modules`.
    label: String,
    /// Absolute path on disk.
    path: String,
    /// Pre-formatted human size, e.g. `3.8GB`.
    size_human: String,
    /// Bytes, kept for sorting.
    size_bytes: u64,
}

/// Heaviest known build/dep directories within `repo`, sorted largest first
/// and gated by `DISK_USAGE_THRESHOLD_BYTES`. Uses `du -sk` for speed; falls
/// back to walking the directory if `du` isn't available (rare on macOS/Linux,
/// expected on Windows).
fn heavy_dirs_for(repo: &Path, repo_name: &str) -> Vec<HeavyDir> {
    let mut out = Vec::new();
    for name in HEAVY_DIR_NAMES {
        let dir = repo.join(name);
        if !dir.is_dir() {
            continue;
        }
        let size = dir_size_bytes(&dir);
        if size < DISK_USAGE_THRESHOLD_BYTES {
            continue;
        }
        out.push(HeavyDir {
            label: format!("{}/{}", repo_name, name),
            path: dir.to_string_lossy().to_string(),
            size_human: human_bytes(size),
            size_bytes: size,
        });
    }
    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

fn dir_size_bytes(dir: &Path) -> u64 {
    // `du -sk` is wildly faster than walking on macOS/Linux. Skip the shell
    // path entirely on Windows.
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("du").no_window().arg("-sk").arg(dir).output();
        if let Ok(out) = output {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if let Some(first) = stdout.split_whitespace().next() {
                    if let Ok(kb) = first.parse::<u64>() {
                        return kb.saturating_mul(1024);
                    }
                }
            }
        }
    }
    // Fallback: walk the directory and sum file sizes.
    let mut total: u64 = 0;
    if let Ok(walker) = walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
    {
        for entry in walker {
            if entry.file_type().is_file() {
                if let Ok(meta) = entry.metadata() {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

fn human_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB {
        let gb = bytes as f64 / GB as f64;
        format!("{gb:.1}GB")
    } else if bytes >= MB {
        let mb = bytes / MB;
        format!("{mb}MB")
    } else if bytes >= KB {
        let kb = bytes / KB;
        format!("{kb}KB")
    } else {
        format!("{bytes}B")
    }
}

struct StashEntry {
    /// Reflog reference, e.g. `stash@{0}`.
    reflog: String,
    /// Reflog subject, e.g. `On main: WIP refactor`.
    subject: String,
}

/// `git stash list` parsed into reflog ref + subject pairs. Empty when no
/// stash exists or git can't be invoked.
fn stash_entries_for(repo: &Path) -> Vec<StashEntry> {
    let output = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo)
        .args(["stash", "list", "--pretty=format:%gd|%gs"])
        .output();
    let out = match output {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let Some((reflog, subject)) = line.split_once('|') else {
            continue;
        };
        entries.push(StashEntry {
            reflog: reflog.trim().to_string(),
            subject: subject.trim().to_string(),
        });
    }
    entries
}

pub fn setup_for(repos: &[(String, String)]) -> Vec<RepoSetup> {
    let mut out = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        let has_claude_md = p.join("CLAUDE.md").is_file();
        let claude_dir = p.join(".claude");
        let has_claude_dir = claude_dir.is_dir();
        let has_skills = claude_dir.join("skills").is_dir();
        let has_agents = claude_dir.join("agents").is_dir();
        let has_hooks = claude_dir
            .join("settings.json")
            .is_file()
            .then(|| {
                fs::read_to_string(claude_dir.join("settings.json"))
                    .ok()
                    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                    .and_then(|v| v.get("hooks").cloned())
                    .is_some()
            })
            .unwrap_or(false);

        let total = 5_u8;
        let hits = [
            has_claude_md,
            has_claude_dir,
            has_skills,
            has_agents,
            has_hooks,
        ]
        .iter()
        .filter(|b| **b)
        .count() as u8;
        let completeness = ((hits as u32 * 100) / total as u32) as u8;

        out.push(RepoSetup {
            repo_name: name.clone(),
            repo_path: path.clone(),
            has_claude_md,
            has_claude_dir,
            has_skills,
            has_agents,
            has_hooks,
            completeness,
            has_agents_md: p.join("AGENTS.md").is_file(),
            has_cursor_rules: p.join(".cursor").join("rules").is_dir() || p.join(".cursorrules").is_file(),
            has_mcp: p.join(".mcp.json").is_file() || p.join(".cursor").join("mcp.json").is_file(),
        });
    }
    out.sort_by_key(|r| r.completeness);
    out
}

// Tiny YAML frontmatter parser. Real YAML is overkill — we only need the
// flat scalar/array fields skills + agents use. Tolerant of stray quotes.
mod serde_yaml_minimal {
    use serde::de::DeserializeOwned;
    use serde_json::{Map, Value};

    pub fn from_str<T: DeserializeOwned>(input: &str) -> Result<T, String> {
        let mut map = Map::new();
        let mut current_key: Option<String> = None;
        let mut current_list: Option<Vec<Value>> = None;

        for raw_line in input.lines() {
            let line = raw_line.trim_end();
            if line.trim().is_empty() || line.trim_start().starts_with('#') {
                continue;
            }

            if let Some(rest) = line.strip_prefix("- ") {
                if let (Some(_key), Some(list)) = (current_key.as_ref(), current_list.as_mut()) {
                    list.push(Value::String(unquote(rest.trim()).to_string()));
                }
                continue;
            }

            // flush any in-progress list
            if let Some(key) = current_key.take() {
                if let Some(list) = current_list.take() {
                    map.insert(key, Value::Array(list));
                }
            }

            let Some((key, val)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim().to_string();
            let val = val.trim();

            if val.is_empty() {
                current_key = Some(key);
                current_list = Some(Vec::new());
            } else {
                map.insert(key, Value::String(unquote(val).to_string()));
            }
        }
        if let (Some(key), Some(list)) = (current_key, current_list) {
            map.insert(key, Value::Array(list));
        }

        let v = Value::Object(map);
        serde_json::from_value(v).map_err(|e| e.to_string())
    }

    fn unquote(s: &str) -> &str {
        let s = s.trim();
        if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
            &s[1..s.len() - 1]
        } else {
            s
        }
    }
}
