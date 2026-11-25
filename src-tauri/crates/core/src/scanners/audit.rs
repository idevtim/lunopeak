//! On-demand dependency vulnerability audits for JS (npm/yarn/pnpm) and PHP
//! (composer) projects.
//!
//! Detection (`audit_targets`) is cheap and offline — it only looks at which
//! lockfiles a repo has. Running an audit (`run_audit`) or a fix
//! (`run_audit_fix`) shells out to the package manager, which is slow and hits
//! the network, so those are driven on demand from the Hygiene page rather than
//! during the regular hygiene scan.
//!
//! Audit tools exit non-zero *when they find vulnerabilities* — that's a normal
//! result, not a failure — so we parse stdout regardless of exit status. A
//! genuine failure (missing binary, offline, unparseable output) surfaces in
//! `AuditReport::error` rather than being swallowed.

use crate::models::{AuditReport, AuditTarget};
use crate::process_ext::NoWindow;
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Audits can pull advisory data over the network; give them room but don't
/// hang the worker thread forever.
const AUDIT_TIMEOUT: Duration = Duration::from_secs(180);
/// Fixes may resolve and download new package versions, so they get longer.
const FIX_TIMEOUT: Duration = Duration::from_secs(300);

/// Severity tallies in the five buckets npm/yarn/pnpm/composer all map onto.
#[derive(Default, Clone, Copy)]
struct VulnCounts {
    critical: u32,
    high: u32,
    moderate: u32,
    low: u32,
    info: u32,
}

impl VulnCounts {
    fn total(&self) -> u32 {
        self.critical + self.high + self.moderate + self.low + self.info
    }

    /// Increment the bucket for a severity string. `medium` (composer) folds
    /// into `moderate`; anything unrecognized lands in `info`.
    fn add(&mut self, severity: &str) {
        match severity.to_lowercase().as_str() {
            "critical" => self.critical += 1,
            "high" => self.high += 1,
            "medium" | "moderate" => self.moderate += 1,
            "low" => self.low += 1,
            _ => self.info += 1,
        }
    }
}

impl AuditReport {
    fn ok(manager: &str, c: VulnCounts) -> Self {
        Self {
            manager: manager.to_string(),
            critical: c.critical,
            high: c.high,
            moderate: c.moderate,
            low: c.low,
            info: c.info,
            total: c.total(),
            error: None,
            message: None,
            // Stamped by the command layer when it runs/caches the report.
            checked_at: None,
        }
    }

    fn failed(manager: &str, error: String) -> Self {
        Self {
            manager: manager.to_string(),
            critical: 0,
            high: 0,
            moderate: 0,
            low: 0,
            info: 0,
            total: 0,
            error: Some(error),
            message: None,
            checked_at: None,
        }
    }
}

// ── Target detection (cheap, offline) ──────────────────────────────────

/// One auditable target per (repo, package manager). A repo with both a
/// `package.json` and a `composer.json` yields two targets.
pub fn audit_targets(repos: &[(String, String)]) -> Vec<AuditTarget> {
    let mut out = Vec::new();
    for (name, path) in repos {
        let p = Path::new(path);
        if p.join("package.json").is_file() {
            if let Some(manager) = node_manager(p) {
                out.push(AuditTarget {
                    repo_name: name.clone(),
                    repo_path: path.clone(),
                    manager: manager.to_string(),
                    // yarn has no equivalent of `npm audit fix`, so it's
                    // audit-only — the UI hides the Fix button for it.
                    can_fix: manager != "yarn",
                });
            }
        }
        if p.join("composer.json").is_file() && p.join("composer.lock").is_file() {
            out.push(AuditTarget {
                repo_name: name.clone(),
                repo_path: path.clone(),
                manager: "composer".into(),
                can_fix: true,
            });
        }
    }
    out
}

/// Pick the JS package manager from the lockfile present. `npm audit` and
/// friends need a lockfile, so a bare `package.json` is not auditable.
fn node_manager(repo: &Path) -> Option<&'static str> {
    if repo.join("pnpm-lock.yaml").is_file() {
        return Some("pnpm");
    }
    if repo.join("yarn.lock").is_file() {
        return Some("yarn");
    }
    if repo.join("package-lock.json").is_file() || repo.join("npm-shrinkwrap.json").is_file() {
        return Some("npm");
    }
    None
}

// ── Running audits ─────────────────────────────────────────────────────

pub fn run_audit(repo_path: &str, manager: &str) -> AuditReport {
    match manager {
        "npm" => audit_npm_like(repo_path, "npm", parse_npm_audit),
        "pnpm" => audit_npm_like(repo_path, "pnpm", parse_npm_audit),
        "yarn" => audit_yarn(repo_path),
        "composer" => audit_composer(repo_path),
        other => AuditReport::failed(other, format!("unknown audit manager '{other}'")),
    }
}

/// npm and pnpm share the `metadata.vulnerabilities` JSON shape.
fn audit_npm_like(repo: &str, program: &str, parse: fn(&str) -> Option<VulnCounts>) -> AuditReport {
    match run_capture(program, &["audit", "--json"], repo, AUDIT_TIMEOUT) {
        Ok((_, stdout, stderr)) => match parse(&stdout) {
            Some(counts) => AuditReport::ok(program, counts),
            None => AuditReport::failed(program, parse_failure(program, &stdout, &stderr)),
        },
        Err(e) => AuditReport::failed(program, e),
    }
}

fn audit_yarn(repo: &str) -> AuditReport {
    // Berry (yarn 2+) ships a `.yarnrc.yml` and uses `yarn npm audit`; classic
    // (yarn 1) uses `yarn audit` and streams NDJSON.
    let berry = Path::new(repo).join(".yarnrc.yml").is_file();
    let (args, parse): (&[&str], fn(&str) -> Option<VulnCounts>) = if berry {
        (&["npm", "audit", "--all", "--json"], parse_yarn_berry)
    } else {
        (&["audit", "--json"], parse_yarn_classic)
    };
    match run_capture("yarn", args, repo, AUDIT_TIMEOUT) {
        Ok((_, stdout, stderr)) => match parse(&stdout) {
            Some(counts) => AuditReport::ok("yarn", counts),
            None => AuditReport::failed("yarn", parse_failure("yarn", &stdout, &stderr)),
        },
        Err(e) => AuditReport::failed("yarn", e),
    }
}

fn audit_composer(repo: &str) -> AuditReport {
    match run_capture("composer", &["audit", "--format=json"], repo, AUDIT_TIMEOUT) {
        Ok((_, stdout, stderr)) => match parse_composer_audit(&stdout) {
            Some(counts) => AuditReport::ok("composer", counts),
            None => AuditReport::failed("composer", parse_failure("composer", &stdout, &stderr)),
        },
        Err(e) => AuditReport::failed("composer", e),
    }
}

// ── Running fixes (safe only) ──────────────────────────────────────────

pub fn run_audit_fix(repo_path: &str, manager: &str) -> AuditReport {
    match manager {
        "npm" => fix_then_reaudit(repo_path, "npm", &["audit", "fix"], "Ran npm audit fix"),
        "pnpm" => fix_then_reaudit(
            repo_path,
            "pnpm",
            &["audit", "--fix"],
            "Ran pnpm audit --fix",
        ),
        "composer" => fix_composer(repo_path),
        "yarn" => AuditReport::failed(
            "yarn",
            "yarn has no safe automatic fix — review the advisories and update manually".into(),
        ),
        other => AuditReport::failed(other, format!("unknown audit manager '{other}'")),
    }
}

/// Run a manager's safe fix command, then re-audit so the UI shows the
/// post-fix counts. A spawn failure on the fix surfaces immediately; otherwise
/// the re-audit reports what (if anything) remains.
fn fix_then_reaudit(repo: &str, program: &str, args: &[&str], note: &str) -> AuditReport {
    if let Err(e) = run_capture(program, args, repo, FIX_TIMEOUT) {
        return AuditReport::failed(program, e);
    }
    let mut report = run_audit(repo, program);
    if report.error.is_none() {
        report.message = Some(note.to_string());
    }
    report
}

/// Composer has no `audit fix`; the safe equivalent is updating just the
/// flagged packages within their existing version constraints.
fn fix_composer(repo: &str) -> AuditReport {
    let packages = match run_capture("composer", &["audit", "--format=json"], repo, AUDIT_TIMEOUT) {
        Ok((_, stdout, _)) => composer_vulnerable_packages(&stdout),
        Err(e) => return AuditReport::failed("composer", e),
    };

    if packages.is_empty() {
        let mut report = run_audit(repo, "composer");
        if report.error.is_none() {
            report.message = Some("No advisories to fix".into());
        }
        return report;
    }

    let mut args: Vec<&str> = vec!["update", "--with-dependencies"];
    args.extend(packages.iter().map(String::as_str));
    if let Err(e) = run_capture("composer", &args, repo, FIX_TIMEOUT) {
        return AuditReport::failed("composer", e);
    }

    let mut report = run_audit(repo, "composer");
    if report.error.is_none() {
        report.message = Some(format!(
            "Updated {} package{}",
            packages.len(),
            if packages.len() == 1 { "" } else { "s" }
        ));
    }
    report
}

// ── Parsers (pure — unit tested below) ─────────────────────────────────

/// npm/pnpm: `{ "metadata": { "vulnerabilities": { critical, high, … } } }`.
fn parse_npm_audit(stdout: &str) -> Option<VulnCounts> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    let m = v.get("metadata")?.get("vulnerabilities")?;
    Some(counts_from_bucket(m))
}

/// yarn classic streams NDJSON; the tallies live on the `auditSummary` line.
fn parse_yarn_classic(stdout: &str) -> Option<VulnCounts> {
    let mut found = None;
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) == Some("auditSummary") {
            if let Some(bucket) = v.get("data").and_then(|d| d.get("vulnerabilities")) {
                found = Some(counts_from_bucket(bucket));
            }
        }
    }
    found
}

/// yarn berry returns a single object. Prefer the npm-style metadata bucket;
/// fall back to tallying the `advisories` map by severity.
fn parse_yarn_berry(stdout: &str) -> Option<VulnCounts> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    if let Some(bucket) = v.get("metadata").and_then(|m| m.get("vulnerabilities")) {
        return Some(counts_from_bucket(bucket));
    }
    let advisories = v.get("advisories")?.as_object()?;
    let mut counts = VulnCounts::default();
    for advisory in advisories.values() {
        let severity = advisory
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("");
        counts.add(severity);
    }
    Some(counts)
}

/// composer: `{ "advisories": { "vendor/pkg": [ { "severity": "high" } ] } }`.
///
/// When there are no advisories, composer serializes the empty map as a JSON
/// array (`"advisories": []`) rather than `{}` — a PHP quirk — so a missing or
/// non-object value means "clean", not "unparseable".
fn parse_composer_audit(stdout: &str) -> Option<VulnCounts> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    // Bail to a parse error only when the key is entirely absent (truly
    // unexpected output); an empty `[]` is a valid clean result.
    let advisories = v.get("advisories")?;
    let mut counts = VulnCounts::default();
    if let Some(map) = advisories.as_object() {
        for entries in map.values() {
            let Some(arr) = entries.as_array() else {
                continue;
            };
            for entry in arr {
                let severity = entry.get("severity").and_then(Value::as_str).unwrap_or("");
                counts.add(severity);
            }
        }
    }
    Some(counts)
}

/// Package names with advisories — the set composer should `update` to fix.
fn composer_vulnerable_packages(stdout: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(stdout.trim()) else {
        return Vec::new();
    };
    v.get("advisories")
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

/// Read the standard `{ info, low, moderate, high, critical }` count object.
fn counts_from_bucket(bucket: &Value) -> VulnCounts {
    let n = |k: &str| bucket.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
    VulnCounts {
        critical: n("critical"),
        high: n("high"),
        moderate: n("moderate"),
        low: n("low"),
        info: n("info"),
    }
}

// ── Subprocess plumbing ────────────────────────────────────────────────

/// On Windows the JS package managers are `.cmd` shims that `Command` won't
/// resolve from the bare name; composer is invoked directly.
fn resolve_program(base: &str) -> String {
    #[cfg(windows)]
    if matches!(base, "npm" | "pnpm" | "yarn") {
        return format!("{base}.cmd");
    }
    base.to_string()
}

/// Run a command in `cwd`, draining stdout/stderr on threads so a large audit
/// payload can't deadlock the pipe, and killing it past `timeout`. Returns
/// `(success, stdout, stderr)`; `success` is the exit status (which audit tools
/// set to non-zero when vulnerabilities exist, so callers must ignore it).
fn run_capture(
    program: &str,
    args: &[&str],
    cwd: &str,
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    let mut command = Command::new(resolve_program(program));
    command
        .no_window()
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| spawn_error(program, &e))?;
    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| format!("{program}: no stdout pipe"))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| format!("{program}: no stderr pipe"))?;
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout_pipe.read_to_string(&mut s);
        s
    });
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr_pipe.read_to_string(&mut s);
        s
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let stdout = out_reader.join().unwrap_or_default();
                let stderr = err_reader.join().unwrap_or_default();
                return Ok((status.success(), stdout, stderr));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(format!("{program}: {e}")),
        }
    }
}

fn spawn_error(program: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!("`{program}` not found on PATH — install it or add it to your PATH")
    } else {
        format!("failed to run {program}: {e}")
    }
}

/// Build a useful error when a command ran but its output didn't parse —
/// usually a missing lockfile/install or an offline registry.
fn parse_failure(program: &str, stdout: &str, stderr: &str) -> String {
    if stdout.trim().is_empty() {
        match stderr.lines().find(|l| !l.trim().is_empty()) {
            Some(hint) => format!("{program}: {}", hint.trim()),
            None => format!("{program} returned no audit data — are dependencies installed?"),
        }
    } else {
        format!("couldn't parse {program} audit output")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_audit_counts_from_metadata() {
        let json = r#"{
            "vulnerabilities": {},
            "metadata": { "vulnerabilities":
                { "info": 1, "low": 2, "moderate": 3, "high": 4, "critical": 5, "total": 15 } }
        }"#;
        let c = parse_npm_audit(json).expect("parses");
        assert_eq!(
            (c.critical, c.high, c.moderate, c.low, c.info),
            (5, 4, 3, 2, 1)
        );
        assert_eq!(c.total(), 15);
    }

    #[test]
    fn npm_audit_clean_report() {
        let json = r#"{ "metadata": { "vulnerabilities":
            { "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0 } } }"#;
        let c = parse_npm_audit(json).expect("parses");
        assert_eq!(c.total(), 0);
    }

    #[test]
    fn npm_audit_garbage_is_none() {
        assert!(parse_npm_audit("not json").is_none());
        assert!(parse_npm_audit("{}").is_none());
    }

    #[test]
    fn yarn_classic_reads_audit_summary_line() {
        let ndjson = concat!(
            r#"{"type":"auditAdvisory","data":{"advisory":{"severity":"high"}}}"#,
            "\n",
            r#"{"type":"auditSummary","data":{"vulnerabilities":{"info":0,"low":1,"moderate":0,"high":2,"critical":0}}}"#,
        );
        let c = parse_yarn_classic(ndjson).expect("parses");
        assert_eq!((c.high, c.low), (2, 1));
        assert_eq!(c.total(), 3);
    }

    #[test]
    fn yarn_berry_prefers_metadata_bucket() {
        let json = r#"{ "metadata": { "vulnerabilities":
            { "info": 0, "low": 0, "moderate": 1, "high": 0, "critical": 1 } } }"#;
        let c = parse_yarn_berry(json).expect("parses");
        assert_eq!((c.critical, c.moderate), (1, 1));
    }

    #[test]
    fn yarn_berry_falls_back_to_advisories() {
        let json = r#"{ "advisories": {
            "1": { "severity": "critical" },
            "2": { "severity": "high" },
            "3": { "severity": "high" }
        } }"#;
        let c = parse_yarn_berry(json).expect("parses");
        assert_eq!((c.critical, c.high), (1, 2));
        assert_eq!(c.total(), 3);
    }

    #[test]
    fn composer_counts_and_maps_medium_to_moderate() {
        let json = r#"{ "advisories": {
            "vendor/a": [ { "severity": "high" }, { "severity": "medium" } ],
            "vendor/b": [ { "severity": "critical" } ]
        } }"#;
        let c = parse_composer_audit(json).expect("parses");
        assert_eq!((c.critical, c.high, c.moderate), (1, 1, 1));
        assert_eq!(c.total(), 3);
    }

    #[test]
    fn composer_clean_report() {
        // composer emits an empty *array* for advisories when there's nothing
        // to report (PHP serializes empty assoc arrays as `[]`).
        let real = r#"{ "advisories": [], "abandoned": [], "filter": [] }"#;
        assert_eq!(parse_composer_audit(real).expect("parses").total(), 0);
        // An empty object should behave identically.
        assert_eq!(
            parse_composer_audit(r#"{ "advisories": {} }"#)
                .expect("parses")
                .total(),
            0
        );
    }

    #[test]
    fn composer_missing_advisories_key_is_parse_error() {
        assert!(parse_composer_audit(r#"{ "abandoned": [] }"#).is_none());
        assert!(parse_composer_audit("not json").is_none());
    }

    #[test]
    fn composer_vulnerable_packages_are_advisory_keys() {
        let json = r#"{ "advisories": {
            "vendor/a": [ { "severity": "high" } ],
            "vendor/b": [ { "severity": "low" } ]
        } }"#;
        let mut pkgs = composer_vulnerable_packages(json);
        pkgs.sort();
        assert_eq!(pkgs, vec!["vendor/a".to_string(), "vendor/b".to_string()]);
    }
}
