use crate::models::{ClaudeMdLintReport, DepEntry, EnvFile, LintIssue, WorktreeEntry};
use crate::process_ext::NoWindow;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

// ── Dependencies ───────────────────────────────────────────────────────

/// Per-repo dependency inventory across the manifests we know about.
/// One entry per (repo, package manager) — a repo with both `package.json`
/// and `Cargo.toml` (a Tauri project, say) yields two entries.
pub fn scan_deps(repos: &[(String, String)]) -> Vec<DepEntry> {
    let mut out = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        if let Some(e) = read_npm(p, name, path) {
            out.push(e);
        }
        if let Some(e) = read_cargo(p, name, path) {
            out.push(e);
        }
        if let Some(e) = read_pyproject(p, name, path) {
            out.push(e);
        }
        if let Some(e) = read_requirements(p, name, path) {
            out.push(e);
        }
        if let Some(e) = read_go_mod(p, name, path) {
            out.push(e);
        }
        if let Some(e) = read_gemfile(p, name, path) {
            out.push(e);
        }
    }
    out.sort_by(|a, b| (b.prod + b.dev).cmp(&(a.prod + a.dev)));
    out
}

fn read_npm(repo: &Path, name: &str, path: &str) -> Option<DepEntry> {
    let manifest = repo.join("package.json");
    let raw = fs::read_to_string(&manifest).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let prod = obj_keys(v.get("dependencies"));
    let dev = obj_keys(v.get("devDependencies"));
    let peer = obj_keys(v.get("peerDependencies"));
    let optional = obj_keys(v.get("optionalDependencies"));
    let total_prod = prod.len() + peer.len() + optional.len();
    Some(DepEntry {
        repo_name: name.into(),
        repo_path: path.into(),
        manager: "npm".into(),
        manifest: manifest.to_string_lossy().into_owned(),
        prod: total_prod as u32,
        dev: dev.len() as u32,
        examples: prod.into_iter().take(6).collect(),
    })
}

fn read_cargo(repo: &Path, name: &str, path: &str) -> Option<DepEntry> {
    let manifest = repo.join("Cargo.toml");
    let raw = fs::read_to_string(&manifest).ok()?;
    let prod = simple_toml_section_keys(&raw, "[dependencies]");
    let dev = simple_toml_section_keys(&raw, "[dev-dependencies]");
    let build = simple_toml_section_keys(&raw, "[build-dependencies]");
    Some(DepEntry {
        repo_name: name.into(),
        repo_path: path.into(),
        manager: "cargo".into(),
        manifest: manifest.to_string_lossy().into_owned(),
        prod: (prod.len() + build.len()) as u32,
        dev: dev.len() as u32,
        examples: prod.into_iter().take(6).collect(),
    })
}

fn read_pyproject(repo: &Path, name: &str, path: &str) -> Option<DepEntry> {
    let manifest = repo.join("pyproject.toml");
    let raw = fs::read_to_string(&manifest).ok()?;
    // PEP 621: [project] dependencies = [...], optional-dependencies.{}.
    // Poetry: [tool.poetry.dependencies] / [tool.poetry.dev-dependencies]
    let pep_prod = parse_array_field(&raw, "[project]", "dependencies");
    let poetry_prod = simple_toml_section_keys(&raw, "[tool.poetry.dependencies]");
    let poetry_dev = simple_toml_section_keys(&raw, "[tool.poetry.dev-dependencies]")
        .into_iter()
        .chain(simple_toml_section_keys(
            &raw,
            "[tool.poetry.group.dev.dependencies]",
        ))
        .collect::<Vec<_>>();
    let prod = if !pep_prod.is_empty() {
        pep_prod
    } else {
        poetry_prod
    };
    Some(DepEntry {
        repo_name: name.into(),
        repo_path: path.into(),
        manager: if raw.contains("[tool.poetry") {
            "poetry".into()
        } else {
            "pip".into()
        },
        manifest: manifest.to_string_lossy().into_owned(),
        prod: prod.len() as u32,
        dev: poetry_dev.len() as u32,
        examples: prod.into_iter().take(6).collect(),
    })
}

fn read_requirements(repo: &Path, name: &str, path: &str) -> Option<DepEntry> {
    let manifest = repo.join("requirements.txt");
    let raw = fs::read_to_string(&manifest).ok()?;
    let prod: Vec<String> = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            l.split(['<', '>', '=', '!', '~', ' '])
                .next()
                .unwrap_or(l)
                .to_string()
        })
        .collect();
    Some(DepEntry {
        repo_name: name.into(),
        repo_path: path.into(),
        manager: "pip".into(),
        manifest: manifest.to_string_lossy().into_owned(),
        prod: prod.len() as u32,
        dev: 0,
        examples: prod.into_iter().take(6).collect(),
    })
}

fn read_go_mod(repo: &Path, name: &str, path: &str) -> Option<DepEntry> {
    let manifest = repo.join("go.mod");
    let raw = fs::read_to_string(&manifest).ok()?;
    let mut prod = Vec::new();
    let mut in_block = false;
    for line in raw.lines() {
        let l = line.trim();
        if l.starts_with("require (") {
            in_block = true;
            continue;
        }
        if in_block {
            if l == ")" {
                in_block = false;
                continue;
            }
            // "<module>/path <version>" possibly with "// indirect"
            let stripped = l.split("//").next().unwrap_or("").trim();
            if let Some(name_) = stripped.split_whitespace().next() {
                if !name_.is_empty() {
                    prod.push(name_.to_string());
                }
            }
        } else if let Some(rest) = l.strip_prefix("require ") {
            if let Some(name_) = rest.split_whitespace().next() {
                prod.push(name_.to_string());
            }
        }
    }
    Some(DepEntry {
        repo_name: name.into(),
        repo_path: path.into(),
        manager: "go".into(),
        manifest: manifest.to_string_lossy().into_owned(),
        prod: prod.len() as u32,
        dev: 0,
        examples: prod.into_iter().take(6).collect(),
    })
}

fn read_gemfile(repo: &Path, name: &str, path: &str) -> Option<DepEntry> {
    let manifest = repo.join("Gemfile");
    let raw = fs::read_to_string(&manifest).ok()?;
    let mut prod = Vec::new();
    let mut dev = Vec::new();
    let mut in_dev_group = false;
    for line in raw.lines() {
        let l = line.trim();
        if l.starts_with("group :development") || l.starts_with("group :test") {
            in_dev_group = true;
            continue;
        }
        if l == "end" {
            in_dev_group = false;
            continue;
        }
        if let Some(rest) = l.strip_prefix("gem ") {
            let name_ = rest
                .trim_matches(|c: char| c.is_whitespace() || c == ',')
                .trim_matches(|c| c == '"' || c == '\'')
                .split(['"', '\'', ','])
                .next()
                .unwrap_or("");
            if !name_.is_empty() {
                if in_dev_group {
                    dev.push(name_.to_string());
                } else {
                    prod.push(name_.to_string());
                }
            }
        }
    }
    Some(DepEntry {
        repo_name: name.into(),
        repo_path: path.into(),
        manager: "bundler".into(),
        manifest: manifest.to_string_lossy().into_owned(),
        prod: prod.len() as u32,
        dev: dev.len() as u32,
        examples: prod.into_iter().take(6).collect(),
    })
}

fn obj_keys(v: Option<&Value>) -> Vec<String> {
    v.and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

/// Minimal-toml line scanner: pulls out all key names under a section header.
/// Stops at the next `[section]` heading. Skips inline arrays / tables —
/// good enough for `[dependencies]`-style flat key=value blocks.
fn simple_toml_section_keys(raw: &str, header: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut in_section = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = trimmed == header;
            continue;
        }
        if !in_section || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, _)) = trimmed.split_once('=') {
            let k = key.trim();
            if !k.is_empty() {
                keys.push(k.to_string());
            }
        }
    }
    keys
}

fn parse_array_field(raw: &str, header: &str, field: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut in_section = false;
    let mut in_array = false;
    let mut buffer = String::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_section = trimmed == header;
            continue;
        }
        if !in_section {
            continue;
        }
        if !in_array {
            if let Some(rest) = trimmed.strip_prefix(field) {
                let rest = rest.trim_start_matches(|c: char| c == '=' || c.is_whitespace());
                if rest.starts_with('[') {
                    buffer.push_str(rest);
                    in_array = true;
                    if rest.contains(']') {
                        break;
                    }
                }
            }
        } else {
            buffer.push_str(trimmed);
            if trimmed.contains(']') {
                break;
            }
        }
    }
    if !buffer.is_empty() {
        let inner = buffer.trim_start_matches('[').trim_end_matches(']');
        for raw_dep in inner.split(',') {
            let dep = raw_dep
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .split(['<', '>', '=', '!', '~', ' ', ';', '['])
                .next()
                .unwrap_or("")
                .trim();
            if !dep.is_empty() {
                keys.push(dep.to_string());
            }
        }
    }
    keys
}

// ── Worktrees ──────────────────────────────────────────────────────────

pub fn scan_worktrees(repos: &[(String, String)]) -> Vec<WorktreeEntry> {
    let mut out = Vec::new();
    for (name, path) in repos {
        let output = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(path)
            .args(["worktree", "list", "--porcelain"])
            .output();
        let Ok(out_) = output else { continue };
        if !out_.status.success() {
            continue;
        }
        let raw = String::from_utf8_lossy(&out_.stdout);
        let parsed = parse_worktree_porcelain(&raw, name, path);
        // git always lists at least one worktree (the main one). Skip if
        // it's just that single canonical entry — we only want to surface
        // additional worktrees here.
        if parsed.len() > 1 {
            out.extend(parsed);
        }
    }
    out
}

/// `git worktree prune`: drops the bookkeeping for worktrees whose folder is
/// gone. Branches and commits are untouched.
pub fn prune_worktrees(repo_path: &str) -> Result<(), String> {
    run_worktree_git(repo_path, &["worktree", "prune"])
}

pub fn unlock_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    run_worktree_git(repo_path, &["worktree", "unlock", worktree_path])
}

fn run_worktree_git(repo_path: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .no_window()
        .arg("-C")
        .arg(repo_path)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn parse_worktree_porcelain(raw: &str, repo_name: &str, repo_path: &str) -> Vec<WorktreeEntry> {
    let mut out = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    let canonical_path = std::fs::canonicalize(repo_path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| repo_path.into());

    for line in raw.lines() {
        if line.is_empty() {
            if let Some(mut e) = current.take() {
                e.is_main = std::fs::canonicalize(&e.worktree_path)
                    .map(|p| p.to_string_lossy().into_owned())
                    .map(|p| p == canonical_path)
                    .unwrap_or(false);
                out.push(e);
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            current = Some(WorktreeEntry {
                repo_name: repo_name.into(),
                repo_path: repo_path.into(),
                worktree_path: rest.into(),
                branch: None,
                head: None,
                locked: false,
                prunable: false,
                is_main: false,
            });
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            if let Some(c) = current.as_mut() {
                c.head = Some(rest.chars().take(7).collect());
            }
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            if let Some(c) = current.as_mut() {
                c.branch = Some(rest.into());
            }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(c) = current.as_mut() {
                c.locked = true;
            }
        } else if line == "prunable" || line.starts_with("prunable ") {
            if let Some(c) = current.as_mut() {
                c.prunable = true;
            }
        }
    }
    if let Some(e) = current.take() {
        out.push(e);
    }
    out
}

// ── Env ────────────────────────────────────────────────────────────────

const ENV_FILES: &[&str] = &[
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    ".env.testing",
    ".env.staging",
];

pub fn scan_env(repos: &[(String, String)]) -> Vec<EnvFile> {
    let mut out = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        let gitignore = fs::read_to_string(p.join(".gitignore")).unwrap_or_default();
        let gitignored_globally = gitignore
            .lines()
            .any(|l| matches!(l.trim(), ".env" | ".env.*" | "*.env" | ".env*"));
        let repo_has_example = p.join(".env.example").is_file();

        for fname in ENV_FILES {
            let env_path: PathBuf = p.join(fname);
            let Ok(raw) = fs::read_to_string(&env_path) else {
                continue;
            };
            let keys = parse_env_keys(&raw);
            let gitignored = gitignored_globally || gitignore.lines().any(|l| l.trim() == *fname);
            // "committed_risk" = file exists AND isn't gitignored.
            let committed_risk = !gitignored;
            out.push(EnvFile {
                repo_name: name.clone(),
                repo_path: path.clone(),
                file_name: (*fname).into(),
                keys,
                gitignored,
                committed_risk,
                repo_has_example,
            });
        }
    }
    out.sort_by(|a, b| {
        b.committed_risk
            .cmp(&a.committed_risk)
            .then_with(|| a.repo_name.cmp(&b.repo_name))
    });
    out
}

fn parse_env_keys(raw: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in raw.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if let Some((k, _)) = l.split_once('=') {
            let k = k.trim().trim_start_matches("export ");
            if !k.is_empty() {
                keys.push(k.to_string());
            }
        }
    }
    keys
}

// ── CLAUDE.md lint ─────────────────────────────────────────────────────

/// Claude truncates very long context files; flag anything beyond this.
const MAX_LINES: u32 = 200;
/// Past this size the file noticeably slows down context loading.
const MAX_BYTES: u64 = 10_000;

/// One report per repo CLAUDE.md, including a list of detected issues.
/// Files without a CLAUDE.md are omitted; clean files are reported with an
/// empty `issues` vec so the UI can count them.
pub fn scan_claude_md_lint(repos: &[(String, String)]) -> Vec<ClaudeMdLintReport> {
    let mut out = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        let md_path = p.join("CLAUDE.md");
        let Ok(body) = fs::read_to_string(&md_path) else {
            continue;
        };
        let bytes = body.len() as u64;
        let lines = body.lines().count() as u32;

        let mut issues = Vec::new();
        if lines > MAX_LINES {
            issues.push(LintIssue {
                kind: "too-long".into(),
                message: format!("{lines} lines — Claude truncates after line {MAX_LINES}"),
            });
        }
        if bytes > MAX_BYTES {
            issues.push(LintIssue {
                kind: "large-file".into(),
                message: format!(
                    "{} — large files slow down context loading",
                    format_bytes(bytes)
                ),
            });
        }
        for r in stale_refs(&body, p) {
            issues.push(LintIssue {
                kind: "stale-ref".into(),
                message: format!("References \"{r}\" which doesn't exist"),
            });
        }

        out.push(ClaudeMdLintReport {
            repo_name: name.clone(),
            repo_path: path.clone(),
            path: md_path.to_string_lossy().to_string(),
            bytes,
            lines,
            body,
            issues,
        });
    }
    // Most issues first, then alphabetical.
    out.sort_by(|a, b| {
        b.issues
            .len()
            .cmp(&a.issues.len())
            .then_with(|| a.repo_name.cmp(&b.repo_name))
    });
    out
}

fn format_bytes(b: u64) -> String {
    if b >= 1024 * 1024 {
        format!("{:.1}MB", b as f64 / (1024.0 * 1024.0))
    } else if b >= 1024 {
        format!("{:.1}KB", b as f64 / 1024.0)
    } else {
        format!("{b}B")
    }
}

/// Path-like tokens referenced in the body that don't resolve under `repo_root`.
/// Looks at backtick-wrapped tokens and markdown link targets.
fn stale_refs(body: &str, repo_root: &Path) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut missing = Vec::new();
    for cand in extract_path_candidates(body) {
        if !seen.insert(cand.clone()) {
            continue;
        }
        let abs = repo_root.join(&cand);
        if !abs.exists() {
            missing.push(cand);
        }
    }
    missing
}

fn extract_path_candidates(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();

    // Backtick-wrapped tokens: `path/to/thing`
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            // Skip fenced code block markers (```), they are not inline code.
            if bytes.get(i + 1).copied() == Some(b'`') && bytes.get(i + 2).copied() == Some(b'`') {
                i += 3;
                continue;
            }
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && bytes[end] != b'`' && bytes[end] != b'\n' {
                end += 1;
            }
            if end < bytes.len() && bytes[end] == b'`' && end > start {
                if let Some(token) = std::str::from_utf8(&bytes[start..end]).ok() {
                    if let Some(p) = path_candidate(token) {
                        out.push(p);
                    }
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }

    // Markdown link targets: [text](path)
    let mut j = 0;
    while j < bytes.len() {
        if bytes[j] == b']' && bytes.get(j + 1).copied() == Some(b'(') {
            let start = j + 2;
            let mut end = start;
            while end < bytes.len() && bytes[end] != b')' && bytes[end] != b'\n' {
                end += 1;
            }
            if end < bytes.len() && bytes[end] == b')' && end > start {
                if let Some(token) = std::str::from_utf8(&bytes[start..end]).ok() {
                    if let Some(p) = path_candidate(token) {
                        out.push(p);
                    }
                }
                j = end + 1;
                continue;
            }
        }
        j += 1;
    }

    out
}

/// Filter a raw token down to a likely repo-relative path, or return `None`.
fn path_candidate(raw: &str) -> Option<String> {
    let token = raw
        .trim()
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | ')' | ']' | '"' | '\''));
    if token.is_empty() || token.contains(' ') || token.contains('\t') {
        return None;
    }
    if !token.contains('/') {
        return None;
    }
    // Skip absolute paths, home paths, URLs, scheme-like prefixes.
    if token.starts_with('/')
        || token.starts_with('~')
        || token.starts_with("http://")
        || token.starts_with("https://")
        || token.starts_with("git@")
        || token.starts_with("mailto:")
        || token.starts_with("file://")
        || token.contains("://")
    {
        return None;
    }
    // Skip glob/template patterns — we can't resolve them.
    if token.contains('*') || token.contains('{') || token.contains('<') {
        return None;
    }
    // Heuristic: must look like a repo path segment, not a flag/option.
    if token.starts_with('-') {
        return None;
    }
    Some(token.to_string())
}
