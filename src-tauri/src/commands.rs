use crate::models::{
    ActiveProcess, BranchInfo, ClaudeMdEntry, ClaudeMdLintReport, ConfigArtifact, CostBreakdown,
    DashboardSummary, DepEntry, DiffStat, DirtyFile, FileDiff, EnvFile, HookEntry, HygieneIssue,
    InstalledAgents, ListeningPort, LiveActivity, LiveContext, StatuslinePrefs, StatuslineSpan, TerminalIntegrations, PullRequestList, Repo, RepoActivity,
    RepoCostDetail, RepoDetail, RepoOverviewEntry, RepoSetup, RepoStash, ReposOverview, Session,
    SessionDetail, SessionStats, Settings, SetupOverview, Snapshot, TimelineEvent, ToolStats,
    TranscriptMatch,
    UsageLimits, WorktreeEntry,
};
use crate::process_ext::NoWindow;
use crate::scanners::codex::Cache as CodexCache;
use crate::scanners::sessions::Cache as SessionsCache;
use crate::{app_menu, scanners, settings, tray};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

// ── State (Cloneable so it can move into spawn_blocking) ──────────────

const REPO_CACHE_TTL: Duration = Duration::from_secs(5);
const SETTINGS_CACHE_TTL: Duration = Duration::from_secs(2);
/// PR fetches fan out one `gh` process per GitHub repo and each one hits the
/// network, so the wall-clock cost scales with repo count. A 2-min TTL keeps
/// the Work Graph view snappy on revisits without going so stale that a freshly
/// merged or opened PR lingers visibly.
const GITHUB_CACHE_TTL: Duration = Duration::from_secs(120);

/// How long a dependency-audit result stays fresh. Audits hit the network and
/// the page auto-runs one per repo on load, so we cache aggressively — a day
/// is plenty for "are my deps still vulnerable?".
const AUDIT_CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const AUDIT_CACHE_FILE: &str = "audit-cache.json";

/// Disk-backed cache of audit results, keyed by `(repo_path, manager)`. Backs
/// the auto-run-on-load behavior: the first visit (or any visit past the 24h
/// TTL) runs the audit; later visits — even across app restarts — return the
/// stored report instantly. The in-memory map is the write path; it's
/// persisted to `audit-cache.json` write-through so concurrent auto-runs can't
/// corrupt the file (the mutex serializes writes).
#[derive(Default, Clone)]
pub struct AuditCache(Arc<Mutex<AuditCacheInner>>);

#[derive(Default)]
struct AuditCacheInner {
    loaded: bool,
    entries: std::collections::HashMap<String, crate::models::AuditReport>,
}

impl AuditCache {
    fn key(repo_path: &str, manager: &str) -> String {
        // Unit separator — can't appear in a path or a manager name.
        format!("{repo_path}\u{1f}{manager}")
    }

    fn file_path(app: &AppHandle) -> Option<std::path::PathBuf> {
        app.path()
            .app_config_dir()
            .ok()
            .map(|d| d.join(AUDIT_CACHE_FILE))
    }

    /// Read the on-disk cache once per process; later calls are no-ops.
    fn ensure_loaded(&self, app: &AppHandle) {
        let mut inner = self.0.lock().unwrap();
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        if let Some(path) = Self::file_path(app) {
            if let Ok(raw) = std::fs::read_to_string(&path) {
                if let Ok(map) = serde_json::from_str(&raw) {
                    inner.entries = map;
                }
            }
        }
    }

    /// A cached report still within the TTL, if any.
    fn get_fresh(&self, repo_path: &str, manager: &str) -> Option<crate::models::AuditReport> {
        let now = chrono::Utc::now().timestamp_millis();
        let inner = self.0.lock().unwrap();
        let report = inner.entries.get(&Self::key(repo_path, manager))?;
        match report.checked_at {
            Some(ts) if now - ts < AUDIT_CACHE_TTL_MS => Some(report.clone()),
            _ => None,
        }
    }

    /// Store a fresh report and write the whole cache back to disk.
    fn put(
        &self,
        app: &AppHandle,
        repo_path: &str,
        manager: &str,
        report: &crate::models::AuditReport,
    ) {
        self.ensure_loaded(app);
        let mut inner = self.0.lock().unwrap();
        inner
            .entries
            .insert(Self::key(repo_path, manager), report.clone());
        if let Some(path) = Self::file_path(app) {
            if let Ok(json) = serde_json::to_string_pretty(&inner.entries) {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&path, json);
            }
        }
    }
}

/// TTL-cached result of `scanners::git::scan_roots`. Many commands need the
/// repo list within the same user interaction (the dashboard alone fans out
/// 3+ concurrent calls); coalescing them behind one mutex turns N filesystem
/// walks into 1.
#[derive(Default, Clone)]
pub struct RepoCache(Arc<Mutex<RepoCacheInner>>);

#[derive(Default)]
struct RepoCacheInner {
    cached_at: Option<Instant>,
    dirs_hash: u64,
    repos: Vec<Repo>,
}

fn dirs_hash(dirs: &[String]) -> u64 {
    let mut h = DefaultHasher::new();
    for d in dirs {
        d.hash(&mut h);
    }
    h.finish()
}

impl RepoCache {
    /// Returns the cached scan if still fresh and the dirs match. Otherwise
    /// rescans inside the lock so concurrent callers coalesce on one walk.
    pub fn get_or_scan(&self, dirs: &[String]) -> Result<Vec<Repo>, String> {
        let mut inner = self.0.lock().unwrap();
        let h = dirs_hash(dirs);
        if let Some(t) = inner.cached_at {
            if h == inner.dirs_hash && t.elapsed() < REPO_CACHE_TTL {
                return Ok(inner.repos.clone());
            }
        }
        let repos = scanners::git::scan_roots(dirs).map_err(|e| e.to_string())?;
        inner.cached_at = Some(Instant::now());
        inner.dirs_hash = h;
        inner.repos = repos.clone();
        Ok(repos)
    }

    pub fn snapshot(&self) -> Vec<Repo> {
        self.0.lock().unwrap().repos.clone()
    }

    pub fn invalidate(&self) {
        self.0.lock().unwrap().cached_at = None;
    }
}

/// TTL-cached `Settings`. Same pattern — coalesces the JSON read+parse that
/// every command was doing independently. Invalidated on `update_settings`.
#[derive(Default, Clone)]
pub struct SettingsCache(Arc<Mutex<SettingsCacheInner>>);

#[derive(Default)]
struct SettingsCacheInner {
    cached_at: Option<Instant>,
    settings: Option<Settings>,
}

impl SettingsCache {
    pub fn load(&self, app: &AppHandle) -> Result<Settings, String> {
        let mut inner = self.0.lock().unwrap();
        if let (Some(t), Some(s)) = (inner.cached_at, &inner.settings) {
            if t.elapsed() < SETTINGS_CACHE_TTL {
                return Ok(s.clone());
            }
        }
        let s = settings::load(app).map_err(|e| e.to_string())?;
        inner.cached_at = Some(Instant::now());
        inner.settings = Some(s.clone());
        Ok(s)
    }

    pub fn invalidate(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.cached_at = None;
        inner.settings = None;
    }
}

/// TTL-cached pull-request list. `gh pr list` is slow (process startup +
/// network) and the user may navigate to Work Graph repeatedly within a
/// short window — coalescing on one cache makes that snappy.
#[derive(Default, Clone)]
pub struct GithubCache(Arc<Mutex<GithubCacheInner>>);

#[derive(Default)]
struct GithubCacheInner {
    cached_at: Option<Instant>,
    list: Option<PullRequestList>,
}

impl GithubCache {
    pub fn get_or_fetch(&self, repos: &[(String, String)]) -> PullRequestList {
        let mut inner = self.0.lock().unwrap();
        if let (Some(t), Some(list)) = (inner.cached_at, &inner.list) {
            if t.elapsed() < GITHUB_CACHE_TTL {
                return list.clone();
            }
        }
        let list = scanners::github::list_open(repos);
        inner.cached_at = Some(Instant::now());
        inner.list = Some(list.clone());
        list
    }
}

// ── Helpers ────────────────────────────────────────────────────────────

fn repo_index(
    app: &AppHandle,
    settings_cache: &SettingsCache,
    repo_cache: &RepoCache,
) -> Result<Vec<(String, String)>, String> {
    let s = settings_cache.load(app)?;
    let repos = repo_cache.get_or_scan(&s.scan_dirs)?;
    Ok(repos.into_iter().map(|r| (r.name, r.path)).collect())
}

fn repo_index_with_branch(
    app: &AppHandle,
    settings_cache: &SettingsCache,
    repo_cache: &RepoCache,
) -> Result<Vec<(String, String, Option<String>)>, String> {
    let s = settings_cache.load(app)?;
    let repos = repo_cache.get_or_scan(&s.scan_dirs)?;
    Ok(repos
        .into_iter()
        .map(|r| (r.name, r.path, r.branch))
        .collect())
}

/// Run a synchronous, potentially-blocking closure on the Tauri async
/// runtime's blocking thread pool. Keeps the OS main thread free so the
/// webview can keep painting (no beach ball).
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task panicked: {e}"))?
}

/// Whether the Claude Code data source is enabled in settings. Defaults to
/// true when settings can't be loaded so we never silently hide data due to
/// a config read error.
fn claude_enabled(app: &AppHandle, cache: &SettingsCache) -> bool {
    cache
        .load(app)
        .map(|s| s.agents.claude_code)
        .unwrap_or(true)
}

/// Whether the Codex data source is enabled in settings. Defaults to true
/// when settings can't be loaded so a transient config-read error doesn't
/// silently hide data — matches `claude_enabled` and `AgentSources::default`.
fn codex_enabled(app: &AppHandle, cache: &SettingsCache) -> bool {
    cache.load(app).map(|s| s.agents.codex).unwrap_or(true)
}

/// Whether the Cursor data source is enabled in settings. Defaults to true
/// on settings-load failure for the same reason as `claude_enabled`.
fn cursor_enabled(app: &AppHandle, cache: &SettingsCache) -> bool {
    cache.load(app).map(|s| s.agents.cursor).unwrap_or(true)
}

/// True when the branch name is a normal working branch — i.e. not the
/// default trunk and not a detached-HEAD short SHA. Heuristic: a 7-char
/// hex string is treated as detached, names matching common trunks are
/// treated as not-feature.
fn is_feature_branch(branch: Option<&str>) -> bool {
    let Some(b) = branch else {
        return false;
    };
    if matches!(b, "main" | "master" | "develop" | "trunk") {
        return false;
    }
    if b.len() == 7 && b.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    true
}

// ── User identity ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_username() -> Result<Option<String>, String> {
    blocking(move || Ok(detect_username())).await
}

/// Best-effort lookup for the user's display name. On macOS we try `id -F`
/// (returns the GECOS full name like "Timothy Murphy") before falling back
/// to the short login name from the USER / USERNAME env vars.
fn detect_username() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("id")
            .no_window()
            .arg("-F")
            .output()
        {
            if out.status.success() {
                let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
    }
    let short = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|s| !s.is_empty());
    short
}

// ── Settings ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(
    app: AppHandle,
    cache: State<'_, SettingsCache>,
) -> Result<Settings, String> {
    let cache = cache.inner().clone();
    blocking(move || cache.load(&app)).await
}

#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
    settings: Settings,
) -> Result<(), String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    let app_for_tray = app.clone();
    let app_for_event = app.clone();
    blocking(move || {
        settings::save(&app, &settings).map_err(|e| e.to_string())?;
        // Settings drives scan_dirs; invalidate both so the next command
        // resees the new state immediately.
        settings_cache.invalidate();
        repo_cache.invalidate();
        Ok(())
    })
    .await?;
    // Tell every webview (main, tray-panel, about) that settings changed so
    // each can invalidate its own react-query cache. Without this the tray
    // panel keeps stale theme/agent values until its 1h staleTime expires.
    let _ = app_for_event.emit("settings://changed", ());
    // The open tray popover's material and arrow follow Appearance too.
    tray::apply_panel_theme(&app_for_event);
    // Redraw the menu bar text from the last usage right away; the refresh
    // below re-scans usage, which can take seconds.
    tray::retitle(&app_for_event);
    // Tray prefs may have changed (enabled/pinned provider) — re-render on
    // the blocking pool because tray::refresh does I/O (incl. reqwest::blocking,
    // whose runtime panics if dropped on a tokio worker).
    blocking(move || {
        tray::refresh(&app_for_tray);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn refresh_tray(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        tray::refresh(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn open_about_window(app: AppHandle) -> Result<(), String> {
    app_menu::open_about_window(&app).map_err(|e| e.to_string())
}

/// Dismiss the tray popover. Called by the panel's frontend after the user
/// clicks a footer action so the panel collapses before the navigation lands.
#[tauri::command]
pub fn hide_tray_panel(app: AppHandle) {
    tray::hide_panel(&app);
}

/// Pulled once by the frontend (main window) on mount: returns and clears any
/// route the menu-bar agent stashed (e.g. its "Settings" button), so a window
/// opened from the menu bar lands on the right view. macOS two-bundle only —
/// `None` elsewhere.
#[tauri::command]
pub fn take_pending_route(_app: AppHandle) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        crate::macos_agent::read_pending_route(&_app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Bring the main window forward without changing the current route. Used by
/// the tray panel's "Open LunoPeak" footer button — clicking it should land
/// the user wherever they were last, not always on the dashboard.
#[tauri::command]
pub fn open_main_window(app: AppHandle) {
    // Show main first so the OS has a destination focus target before the
    // panel disappears. Hiding an always-on-top panel without that handoff
    // can leave the previous app frontmost on macOS instead of LunoPeak.
    tray::show_main_window(&app);
    tray::hide_panel(&app);
}

/// Navigate the main window to a route and bring it forward. Used by the
/// tray panel's footer (Settings, etc.).
#[tauri::command]
pub fn tray_navigate(app: AppHandle, route: String) {
    // Emit + show before hiding the panel — same focus-handoff reasoning as
    // `open_main_window`.
    tray::navigate_main(&app, &route);
    tray::hide_panel(&app);
}

/// Quit everything. On macOS the app is two processes (window + menu-bar
/// agent); terminate the counterpart before exiting so "Quit" / Cmd+Q closes
/// both — wherever it's invoked from. No-op counterpart on Windows/Linux (one
/// process). Hand-rolled `app.exit` (not `process::exit`) so Tauri runs its
/// usual teardown — window-state save, plugin cleanup — before we exit.
pub fn quit_all(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    crate::macos_agent::terminate_counterpart(app);
    app.exit(0);
}

/// Quit the app (from the tray popover's Quit button or the in-app menu).
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    quit_all(&app);
}

/// Relaunch the app — used after an update finishes installing so the user
/// can apply it with one click instead of manually quitting and reopening.
/// `restart` runs Tauri's teardown, then execs the (now-updated) binary.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    restart_all(&app);
}

/// Restart onto the installed update. On macOS the other process is still
/// running the old binary, so it's stopped first (see
/// `macos_agent::prepare_restart`) and comes back on the new one.
pub fn restart_all(app: &AppHandle) -> ! {
    #[cfg(target_os = "macos")]
    crate::macos_agent::prepare_restart(app);
    app.restart()
}

/// Version of the update the menu bar's background check found, if any.
#[tauri::command]
pub fn get_available_update() -> Option<String> {
    crate::updates::available_version()
}

/// The popover's "Restart to update": install the pending update and relaunch.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    crate::updates::install_and_restart(app).await
}

// ── Repos ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn scan_repos(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<Repo>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let s = settings_cache.load(&app)?;
        repo_cache.get_or_scan(&s.scan_dirs)
    })
    .await
}

#[tauri::command]
pub fn get_repos(cache: State<'_, RepoCache>) -> Result<Vec<Repo>, String> {
    Ok(cache.snapshot())
}

#[tauri::command]
pub async fn get_repos_overview(
    app: AppHandle,
    sessions: State<'_, SessionsCache>,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<ReposOverview, String> {
    let sessions_cache = sessions.inner().clone();
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let s = settings_cache.load(&app)?;
        let repos = repo_cache.get_or_scan(&s.scan_dirs)?;
        let sessions = if claude_enabled(&app, &settings_cache) {
            scanners::sessions::scan_all(&sessions_cache).unwrap_or_default()
        } else {
            Vec::new()
        };
        let by_repo_path: Vec<(String, String)> = repos
            .iter()
            .map(|r| (r.name.clone(), r.path.clone()))
            .collect();
        let activities = scanners::git_log::repo_activity(&sessions, &by_repo_path);
        let activity_by_path: std::collections::HashMap<String, Vec<u32>> = activities
            .into_iter()
            .map(|a| (a.repo_path, a.days))
            .collect();
        let skills = scanners::config::scan_skills(&by_repo_path);
        let mut skill_count: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        for skill in &skills {
            if let Some(p) = &skill.repo_path {
                *skill_count.entry(p.clone()).or_insert(0) += 1;
            }
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        let week_ms: i64 = 7 * 24 * 60 * 60 * 1000;

        // Run the per-repo git subprocesses in parallel — each repo needs
        // last-subject + unpushed-count + porcelain + stash list, and
        // serially these dominate the overview latency on large monorepo
        // collections.
        use rayon::prelude::*;
        let mut entries: Vec<RepoOverviewEntry> = repos
            .into_par_iter()
            .map(|r| {
                let p = std::path::Path::new(&r.path);
                let last_commit_subject = scanners::git::read_last_commit_subject(p);
                let unpushed = scanners::git::read_unpushed_count(p);
                let uncommitted_files = scanners::git::read_uncommitted_files(p);
                let stash_count = scanners::git::read_stash_count(p);
                let activity = activity_by_path.get(&r.path).cloned().unwrap_or_default();
                let skills = skill_count.get(&r.path).copied().unwrap_or(0);
                RepoOverviewEntry {
                    id: r.id,
                    name: r.name,
                    path: r.path,
                    branch: r.branch,
                    has_claude_md: r.has_claude_md,
                    has_uncommitted: r.has_uncommitted,
                    last_activity_ts: r.last_activity_ts,
                    last_commit_subject,
                    unpushed_commits: unpushed,
                    uncommitted_files,
                    stash_count,
                    skill_count: skills,
                    activity30d: activity,
                }
            })
            .collect();

        let mut active_count = 0u32;
        let mut dirty_count = 0u32;
        let mut unpushed_count = 0u32;
        let mut uncommitted_files_total = 0u32;
        let mut feature_branch_count = 0u32;
        for e in &entries {
            if e.has_uncommitted {
                dirty_count += 1;
            }
            if e.unpushed_commits > 0 {
                unpushed_count += 1;
            }
            if e.last_activity_ts.is_some_and(|ts| now_ms - ts <= week_ms) {
                active_count += 1;
            }
            uncommitted_files_total = uncommitted_files_total.saturating_add(e.uncommitted_files);
            if is_feature_branch(e.branch.as_deref()) {
                feature_branch_count += 1;
            }
        }

        // Newest activity first.
        entries.sort_by(|a, b| {
            b.last_activity_ts
                .unwrap_or(0)
                .cmp(&a.last_activity_ts.unwrap_or(0))
        });

        Ok(ReposOverview {
            repos: entries,
            active_count,
            dirty_count,
            unpushed_count,
            uncommitted_files_total,
            feature_branch_count,
        })
    })
    .await
}

#[tauri::command]
pub async fn get_repo_detail(
    app: AppHandle,
    sessions: State<'_, SessionsCache>,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
    path: String,
) -> Result<Option<RepoDetail>, String> {
    let sessions_cache = sessions.inner().clone();
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let s = settings_cache.load(&app)?;
        let repos = repo_cache.get_or_scan(&s.scan_dirs)?;
        let Some(repo) = repos.iter().find(|r| r.path == path).cloned() else {
            return Ok(None);
        };

        let by_repo_path: Vec<(String, String)> = repos
            .iter()
            .map(|r| (r.name.clone(), r.path.clone()))
            .collect();
        let sessions = if claude_enabled(&app, &settings_cache) {
            scanners::sessions::scan_all(&sessions_cache).unwrap_or_default()
        } else {
            Vec::new()
        };
        let activities = scanners::git_log::repo_activity(&sessions, &by_repo_path);
        let activity30d = activities
            .into_iter()
            .find(|a| a.repo_path == repo.path)
            .map(|a| a.days)
            .unwrap_or_default();

        let all_skills = scanners::config::scan_skills(&by_repo_path);
        let skills: Vec<ConfigArtifact> = all_skills
            .into_iter()
            .filter(|s| s.repo_path.as_deref() == Some(repo.path.as_str()))
            .collect();
        let skill_count = skills.len() as u32;

        let p = std::path::Path::new(&repo.path);
        let last_commit_subject = scanners::git::read_last_commit_subject(p);
        let unpushed_commits = scanners::git::read_unpushed_count(p);
        let uncommitted_files = scanners::git::read_uncommitted_files(p);
        let stash_count = scanners::git::read_stash_count(p);

        let claude_md_path = p.join("CLAUDE.md");
        let claude_md = std::fs::read_to_string(&claude_md_path).ok();

        let entry = RepoOverviewEntry {
            id: repo.id,
            name: repo.name,
            path: repo.path,
            branch: repo.branch,
            has_claude_md: repo.has_claude_md,
            has_uncommitted: repo.has_uncommitted,
            last_activity_ts: repo.last_activity_ts,
            last_commit_subject,
            unpushed_commits,
            uncommitted_files,
            stash_count,
            skill_count,
            activity30d,
        };

        Ok(Some(RepoDetail {
            entry,
            claude_md,
            skills,
        }))
    })
    .await
}

// ── Repo actions: open in external apps, git pull ──────────────────────

#[tauri::command]
pub async fn open_in_terminal(path: String) -> Result<(), String> {
    blocking(move || scanners::processes::open_in_terminal(&path)).await
}

#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), String> {
    blocking(move || scanners::processes::open_in_vscode(&path)).await
}

#[tauri::command]
pub async fn open_in_claude(path: String) -> Result<(), String> {
    blocking(move || scanners::processes::open_in_claude(&path)).await
}

#[tauri::command]
pub async fn open_in_codex(path: String) -> Result<(), String> {
    blocking(move || scanners::processes::open_in_codex(&path)).await
}

#[tauri::command]
pub async fn open_in_cursor(path: String) -> Result<(), String> {
    blocking(move || scanners::processes::open_in_cursor(&path)).await
}

/// Generic "open in editor" entry point used by Skills/Agents/Memory/Hooks
/// and the Repos action bar. `editor` is a stable id from the editor catalog
/// in `processes.rs` (e.g. "vscode", "cursor", "antigravity"), or "system" /
/// `None` to fall back to the OS's default file handler.
#[tauri::command]
pub async fn open_path_in_editor(path: String, editor: Option<String>) -> Result<(), String> {
    blocking(move || scanners::processes::open_path_in_editor(&path, editor.as_deref())).await
}

/// Editor ids that are meaningful on this platform — drives the picker UI
/// so Mac-only entries (Xcode) don't appear on Windows / Linux.
#[tauri::command]
pub async fn get_available_editors() -> Result<Vec<String>, String> {
    blocking(move || Ok(scanners::processes::available_editor_ids())).await
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    blocking(move || scanners::processes::git_pull(&path)).await
}

/// Per-file `git status --porcelain` rows for a single repo. Used by the
/// inline expansion on the Repos list to show what's dirty without making
/// the user navigate into the detail view.
#[tauri::command]
pub async fn get_repo_dirty_files(path: String) -> Result<Vec<DirtyFile>, String> {
    blocking(move || {
        let repo = std::path::PathBuf::from(&path);
        if !repo.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        Ok(scanners::git::read_dirty_files(&repo))
    })
    .await
}

/// Uncommitted changes per file with their unified diff, untracked files
/// included. Backs the inline diffs on Diffs and Repo detail.
#[tauri::command]
pub async fn get_repo_file_diffs(path: String) -> Result<Vec<FileDiff>, String> {
    blocking(move || {
        let repo = std::path::PathBuf::from(&path);
        if !repo.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        Ok(scanners::git::read_file_diffs(&repo))
    })
    .await
}

/// Local branches with ahead/behind counts against the default branch.
#[tauri::command]
pub async fn get_repo_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    blocking(move || {
        let repo = std::path::PathBuf::from(&path);
        if !repo.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        Ok(scanners::git::read_branches(&repo))
    })
    .await
}

/// Drop a single stash entry (`git -C <path> stash drop <reflog>`). The
/// `reflog` arg must look like `stash@{N}`.
#[tauri::command]
pub async fn git_drop_stash(path: String, reflog: String) -> Result<String, String> {
    blocking(move || {
        if !reflog.starts_with("stash@{") || !reflog.ends_with('}') {
            return Err(format!("invalid stash ref: {reflog}"));
        }
        let repo = std::path::PathBuf::from(&path);
        if !repo.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        let out = std::process::Command::new("git")
            .no_window()
            .arg("-C")
            .arg(&repo)
            .args(["stash", "drop", &reflog])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("git stash drop {reflog} failed")
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/// List every stash entry for a repo (`git stash list`) along with the files
/// each one touches. Empty when the repo has no stashes.
#[tauri::command]
pub async fn get_repo_stashes(path: String) -> Result<Vec<RepoStash>, String> {
    blocking(move || {
        let repo = std::path::PathBuf::from(&path);
        if !repo.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        Ok(scanners::git::read_stashes(&repo))
    })
    .await
}

/// Delete a local branch with `git -C <path> branch -D <branch>`. Refuses
/// trunk branches and the currently checked-out branch.
#[tauri::command]
pub async fn git_delete_branch(path: String, branch: String) -> Result<String, String> {
    blocking(move || {
        const PROTECTED: &[&str] = &["main", "master", "develop", "trunk"];
        if PROTECTED.contains(&branch.as_str()) {
            return Err(format!("refusing to delete protected branch '{branch}'"));
        }
        let repo = std::path::PathBuf::from(&path);
        if !repo.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        // Block deletion of the currently checked-out branch.
        let head = std::process::Command::new("git")
            .no_window()
            .arg("-C")
            .arg(&repo)
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .output()
            .map_err(|e| e.to_string())?;
        if head.status.success() {
            let current = String::from_utf8_lossy(&head.stdout).trim().to_string();
            if current == branch {
                return Err(format!(
                    "refusing to delete the currently checked-out branch '{branch}'"
                ));
            }
        }
        let out = std::process::Command::new("git")
            .no_window()
            .arg("-C")
            .arg(&repo)
            .args(["branch", "-D", &branch])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("git branch -D '{branch}' failed")
            } else {
                stderr
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
}

/// Write a starter CLAUDE.md to the given repo if one isn't already there.
/// Refuses to overwrite — callers should treat "already exists" as a soft
/// success. Invalidates the repo cache so the next scan reflects the change.
#[tauri::command]
pub async fn create_claude_md(
    path: String,
    repo_cache: State<'_, RepoCache>,
) -> Result<(), String> {
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repo_path = std::path::PathBuf::from(&path);
        if !repo_path.is_dir() {
            return Err(format!("repo path does not exist: {path}"));
        }
        let target = repo_path.join("CLAUDE.md");
        if target.exists() {
            return Err("CLAUDE.md already exists".into());
        }
        let name = repo_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Project");
        let stub = format!(
            "# {name}\n\nProject-specific guidance for Claude Code.\n\n## Commands\n\n## Architecture\n\n## Conventions\n",
        );
        std::fs::write(&target, stub).map_err(|e| e.to_string())?;
        repo_cache.invalidate();
        Ok(())
    })
    .await
}

/// Write a user-triggered diagnostics export to disk. The webview already
/// prompted the user via the system save dialog, so the path is trusted —
/// we just guard against accidentally clobbering arbitrary files by
/// requiring a `.json` extension and refusing directories.
/// Append one frontend log entry to the shared diagnostics log. Fire-and-forget
/// from the webview; logging is best-effort so this never returns an error.
#[tauri::command]
pub fn append_log_entry(level: String, scope: String, msg: String, detail: Option<String>) {
    crate::logger::log_frontend(level, scope, msg, detail);
}

/// Read the recent slice of the runtime log for embedding in a diagnostics
/// export. `max_entries` caps how many newest lines are returned.
#[tauri::command]
pub fn read_diagnostics_log(max_entries: usize) -> Vec<crate::logger::LogEntry> {
    crate::logger::read_current(max_entries)
}

#[tauri::command]
pub async fn write_diagnostics_log(path: String, contents: String) -> Result<(), String> {
    blocking(move || {
        let target = std::path::PathBuf::from(&path);
        if target.extension().and_then(|e| e.to_str()) != Some("json") {
            return Err("diagnostics export must be a .json file".into());
        }
        if target.is_dir() {
            return Err(format!("path is a directory: {path}"));
        }
        std::fs::write(&target, contents).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

// ── Sessions / Costs / Live ────────────────────────────────────────────

#[tauri::command]
pub async fn get_sessions(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    settings_cache: State<'_, SettingsCache>,
) -> Result<Vec<Session>, String> {
    if !claude_enabled(&app, settings_cache.inner()) {
        return Ok(Vec::new());
    }
    let cache = cache.inner().clone();
    blocking(move || scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn get_session_stats(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    settings_cache: State<'_, SettingsCache>,
) -> Result<SessionStats, String> {
    if !claude_enabled(&app, settings_cache.inner()) {
        return Ok(scanners::sessions::stats(&[]));
    }
    let cache = cache.inner().clone();
    blocking(move || {
        let sessions = scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?;
        Ok(scanners::sessions::stats(&sessions))
    })
    .await
}

#[tauri::command]
pub async fn get_costs(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    codex_cache: State<'_, CodexCache>,
    settings_cache: State<'_, SettingsCache>,
) -> Result<CostBreakdown, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let codex_on = codex_enabled(&app, settings_cache.inner());
    if !claude_on && !codex_on {
        return Ok(scanners::sessions::costs(&[]));
    }
    let cache = cache.inner().clone();
    let codex_cache = codex_cache.inner().clone();
    blocking(move || {
        let mut sessions = if claude_on {
            scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        if codex_on {
            let codex = scanners::codex::scan_all(&codex_cache).map_err(|e| e.to_string())?;
            sessions.extend(codex);
        }
        let costs = scanners::sessions::costs(&sessions);
        // Fresh numbers in hand — hand today's total to the terminal status line.
        crate::statusline::write_snapshot(&costs.by_day);
        Ok(costs)
    })
    .await
}

#[tauri::command]
pub async fn get_repo_cost_detail(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    codex_cache: State<'_, CodexCache>,
    settings_cache: State<'_, SettingsCache>,
    repo_key: String,
) -> Result<RepoCostDetail, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let codex_on = codex_enabled(&app, settings_cache.inner());
    if !claude_on && !codex_on {
        return Ok(scanners::sessions::repo_cost_detail(&[], &repo_key));
    }
    let cache = cache.inner().clone();
    let codex_cache = codex_cache.inner().clone();
    blocking(move || {
        let mut sessions = if claude_on {
            scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        if codex_on {
            let codex = scanners::codex::scan_all(&codex_cache).map_err(|e| e.to_string())?;
            sessions.extend(codex);
        }
        Ok(scanners::sessions::repo_cost_detail(&sessions, &repo_key))
    })
    .await
}

#[tauri::command]
pub async fn get_session_detail(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    id: String,
) -> Result<Option<SessionDetail>, String> {
    if !claude_enabled(&app, settings_cache.inner()) {
        return Ok(None);
    }
    blocking(move || Ok(scanners::sessions::scan_detail(&id))).await
}

#[tauri::command]
pub async fn search_transcripts(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    query: String,
) -> Result<Vec<TranscriptMatch>, String> {
    if !claude_enabled(&app, settings_cache.inner()) {
        return Ok(Vec::new());
    }
    blocking(move || Ok(scanners::sessions::search_transcripts(&query))).await
}

#[tauri::command]
pub async fn get_active_processes(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
) -> Result<Vec<ActiveProcess>, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let codex_on = codex_enabled(&app, settings_cache.inner());
    let cursor_on = cursor_enabled(&app, settings_cache.inner());
    blocking(move || {
        let mut procs = scanners::processes::scan();
        // Drop rows the user disabled so the live view doesn't surface a PID
        // for a provider whose other data sources are gated off. Strip
        // `.exe` so the match works the same way on Windows and macOS.
        procs.retain(|p| {
            let raw = p.name.to_lowercase();
            let name = raw.strip_suffix(".exe").unwrap_or(&raw);
            let is_claude = name == "claude" || name == "cline" || name.starts_with("claude ");
            let is_codex = name == "codex" || name.starts_with("codex ");
            let is_cursor = name == "cursor" || name.starts_with("cursor ");
            if is_claude {
                claude_on
            } else if is_codex {
                codex_on
            } else if is_cursor {
                cursor_on
            } else {
                true
            }
        });
        Ok(procs)
    })
    .await
}

#[tauri::command]
pub async fn kill_process(pid: u32) -> Result<(), String> {
    blocking(move || scanners::processes::kill(pid)).await
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), String> {
    blocking(move || scanners::processes::reveal_in_finder(&path)).await
}

#[tauri::command]
pub async fn get_live_activity(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    limit: Option<usize>,
) -> Result<LiveActivity, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let codex_on = codex_enabled(&app, settings_cache.inner());
    let cursor_on = cursor_enabled(&app, settings_cache.inner());
    if !claude_on && !codex_on && !cursor_on {
        return Ok(LiveActivity {
            feed: Vec::new(),
            sessions: Vec::new(),
        });
    }
    let limit = limit.unwrap_or(40);
    blocking(move || {
        let mut feed: Vec<crate::models::LiveEvent> = Vec::new();
        let mut sessions: Vec<crate::models::SessionLiveState> = Vec::new();
        if claude_on {
            let mut a = scanners::live::collect(limit);
            feed.append(&mut a.feed);
            sessions.append(&mut a.sessions);
        }
        if codex_on {
            let mut b = scanners::live_codex::collect(limit);
            feed.append(&mut b.feed);
            sessions.append(&mut b.sessions);
        }
        if cursor_on {
            let mut c = scanners::live_cursor::collect(limit);
            feed.append(&mut c.feed);
            sessions.append(&mut c.sessions);
        }
        feed.sort_by_key(|e| std::cmp::Reverse(e.ts));
        feed.truncate(limit);
        sessions.sort_by_key(|s| std::cmp::Reverse(s.last_ts));
        Ok(LiveActivity { feed, sessions })
    })
    .await
}

/// Context-window fill for every running agent session — one row per Claude
/// pid, per claimed Codex rollout, per recently-active Cursor chat. Drives the
/// Live view's per-process meter, the tray's "Running now" list, and the
/// dashboard section.
#[tauri::command]
pub async fn get_live_contexts(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
) -> Result<Vec<LiveContext>, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let codex_on = codex_enabled(&app, settings_cache.inner());
    let cursor_on = cursor_enabled(&app, settings_cache.inner());
    if !claude_on && !codex_on && !cursor_on {
        return Ok(Vec::new());
    }
    blocking(move || {
        let mut out = Vec::new();
        if claude_on {
            out.extend(scanners::live::contexts());
        }
        // Claude maps pids itself; Codex and Cursor pair against the process
        // table, so only pay for the full scan when one of them is on.
        if codex_on || cursor_on {
            let procs = scanners::processes::scan();
            if codex_on {
                out.extend(scanners::live_codex::contexts(&procs));
            }
            if cursor_on {
                out.extend(scanners::live_cursor::contexts(&procs));
            }
        }
        // Busy sessions first, then freshest activity.
        out.sort_by(|a, b| {
            let busy = |c: &LiveContext| c.status.as_deref() == Some("busy");
            busy(b).cmp(&busy(a)).then(b.last_ts.cmp(&a.last_ts))
        });
        Ok(out)
    })
    .await
}

// ── Terminal status lines ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_terminal_integrations() -> Result<TerminalIntegrations, String> {
    blocking(|| Ok(crate::statusline::status())).await
}

/// The line `prefs` would print right now, for Settings' live preview.
#[tauri::command]
pub async fn preview_statusline(prefs: StatuslinePrefs) -> Result<Vec<StatuslineSpan>, String> {
    blocking(move || Ok(crate::statusline::preview(&prefs))).await
}

#[tauri::command]
pub async fn set_claude_statusline(enabled: bool) -> Result<TerminalIntegrations, String> {
    blocking(move || {
        crate::statusline::set_claude(enabled).map_err(|e| format!("{e:#}"))?;
        Ok(crate::statusline::status())
    })
    .await
}

#[tauri::command]
pub async fn set_codex_statusline(enabled: bool) -> Result<TerminalIntegrations, String> {
    blocking(move || {
        crate::statusline::set_codex(enabled).map_err(|e| format!("{e:#}"))?;
        Ok(crate::statusline::status())
    })
    .await
}

// ── Config inventory ───────────────────────────────────────────────────

#[tauri::command]
pub async fn get_claude_md(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<ClaudeMdEntry>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::config::scan_claude_md(&repos))
    })
    .await
}

#[tauri::command]
pub async fn get_skills(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<ConfigArtifact>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::config::scan_skills(&repos))
    })
    .await
}

/// Read a skill file's body. Validates the path against the current set of
/// scanned skills so callers can't read arbitrary files via this command.
#[tauri::command]
pub async fn read_skill_body(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
    path: String,
) -> Result<String, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        let allowed = scanners::config::scan_skills(&repos);
        if !allowed.iter().any(|s| s.path == path) {
            return Err("path is not a known skill".into());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_agents(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<ConfigArtifact>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::config::scan_agents(&repos))
    })
    .await
}

/// Read an agent file's body. Validates the path against the current set of
/// scanned agents so callers can't read arbitrary files via this command.
#[tauri::command]
pub async fn read_agent_body(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
    path: String,
) -> Result<String, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        let allowed = scanners::config::scan_agents(&repos);
        if !allowed.iter().any(|s| s.path == path) {
            return Err("path is not a known agent".into());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn get_hooks(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<HookEntry>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::config::scan_hooks(&repos))
    })
    .await
}

#[tauri::command]
pub async fn get_hygiene(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<HygieneIssue>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        let mut issues = scanners::config::hygiene_for(&repos);
        for port in scanners::ports::scan() {
            if !is_agent_or_terminal_port(&port, &repos) {
                continue;
            }
            let (repo_name, repo_path) = repo_for_cwd(port.cwd.as_deref(), &repos);
            let process_label = friendly_process_name(&port.process);
            let message = format!("{} on :{}", process_label, port.port);
            let details = port
                .cwd
                .as_deref()
                .map(prettify_path)
                .filter(|d| !d.is_empty());
            issues.push(crate::models::HygieneIssue {
                repo_name,
                repo_path,
                kind: "background-listener".into(),
                message,
                severity: crate::models::Severity::Info,
                command: Some(format!("kill {}", port.pid)),
                target: Some(port.pid.to_string()),
                details,
            });
        }
        Ok(issues)
    })
    .await
}

/// Dependency roots worth auditing (npm/yarn/pnpm/composer), detected cheaply
/// from lockfile presence. The actual audit is run on demand via `run_audit`.
#[tauri::command]
pub async fn list_audit_targets(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<crate::models::AuditTarget>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::audit::audit_targets(&repos))
    })
    .await
}

/// Run a dependency audit for one target. Slow + network-bound, so results are
/// cached for 24h (`AuditCache`): unless `force` is set, a fresh cached report
/// is returned without re-running. A failure (missing binary, offline) lands in
/// `AuditReport::error` rather than rejecting the command, and isn't cached so
/// it retries next time.
#[tauri::command]
pub async fn run_audit(
    app: AppHandle,
    audit_cache: State<'_, AuditCache>,
    repo_path: String,
    manager: String,
    force: bool,
) -> Result<crate::models::AuditReport, String> {
    let audit_cache = audit_cache.inner().clone();
    blocking(move || {
        audit_cache.ensure_loaded(&app);
        if !force {
            if let Some(cached) = audit_cache.get_fresh(&repo_path, &manager) {
                return Ok(cached);
            }
        }
        let mut report = scanners::audit::run_audit(&repo_path, &manager);
        report.checked_at = Some(chrono::Utc::now().timestamp_millis());
        if report.error.is_none() {
            audit_cache.put(&app, &repo_path, &manager, &report);
        }
        Ok(report)
    })
    .await
}

/// Apply the manager's *safe* fix (no breaking major bumps) then re-audit so
/// the caller gets fresh counts. The post-fix result refreshes the cache. yarn
/// has no safe fix and returns an error.
#[tauri::command]
pub async fn run_audit_fix(
    app: AppHandle,
    audit_cache: State<'_, AuditCache>,
    repo_path: String,
    manager: String,
) -> Result<crate::models::AuditReport, String> {
    let audit_cache = audit_cache.inner().clone();
    blocking(move || {
        let mut report = scanners::audit::run_audit_fix(&repo_path, &manager);
        report.checked_at = Some(chrono::Utc::now().timestamp_millis());
        if report.error.is_none() {
            audit_cache.put(&app, &repo_path, &manager, &report);
        }
        Ok(report)
    })
    .await
}

/// Map an lsof COMMAND value to a friendlier display name. Falls back to the
/// raw command unchanged when no rule matches.
fn friendly_process_name(raw: &str) -> String {
    let lower = raw.to_lowercase();
    let candidates: &[(&str, &str)] = &[
        ("code helper (plugin)", "VS Code (Plugin)"),
        ("code helper (renderer)", "VS Code (Renderer)"),
        ("code helper", "VS Code Helper"),
        ("cursor helper (plugin)", "Cursor (Plugin)"),
        ("cursor helper (renderer)", "Cursor (Renderer)"),
        ("cursor helper", "Cursor Helper"),
        ("code-insiders", "VS Code Insiders"),
        ("ollama", "Ollama"),
        ("lm studio", "LM Studio"),
        ("lm-studio", "LM Studio"),
        ("claude", "Claude"),
        ("codex", "Codex"),
        ("aider", "Aider"),
        ("windsurf", "Windsurf"),
        ("zed", "Zed"),
        ("iterm2", "iTerm"),
        ("iterm", "iTerm"),
        ("ghostty", "Ghostty"),
        ("alacritty", "Alacritty"),
        ("wezterm-gui", "WezTerm"),
        ("wezterm", "WezTerm"),
    ];
    for (needle, label) in candidates {
        if lower.contains(needle) {
            return (*label).to_string();
        }
    }
    raw.to_string()
}

/// Replace `$HOME` with `~` for compact display. Also collapses long paths
/// to `…/<last 3 components>` past a length threshold.
fn prettify_path(p: &str) -> String {
    let with_home = match dirs::home_dir() {
        Some(home) => {
            let h = home.to_string_lossy().to_string();
            if let Some(rest) = p.strip_prefix(&h) {
                format!("~{rest}")
            } else {
                p.to_string()
            }
        }
        None => p.to_string(),
    };
    const MAX: usize = 60;
    if with_home.len() <= MAX {
        return with_home;
    }
    let parts: Vec<&str> = with_home.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() <= 3 {
        return with_home;
    }
    let tail = &parts[parts.len() - 3..];
    format!("…/{}", tail.join("/"))
}

/// First repo whose path contains the given cwd. Returns `(name, path)` so we
/// can attach a repo badge to the hygiene row.
fn repo_for_cwd(cwd: Option<&str>, repos: &[(String, String)]) -> (Option<String>, Option<String>) {
    let Some(cwd) = cwd else {
        return (None, None);
    };
    for (name, path) in repos {
        if cwd == path || cwd.starts_with(&format!("{path}/")) {
            return (Some(name.clone()), Some(path.clone()));
        }
    }
    (None, None)
}

/// Process-name fragments that mark a listener as belonging to an AI tool or
/// developer terminal. Matched case-insensitively against the lsof COMMAND
/// column, which uses spaces (e.g. "Code Helper", "Cursor Helper").
const AGENT_TERMINAL_HINTS: &[&str] = &[
    // Coding agents / AI CLIs
    "claude",
    "codex",
    "cursor",
    "windsurf",
    "aider",
    "continue",
    "sweep",
    "copilot",
    // Editor + helper processes that host AI integrations
    "code helper",
    "code-insiders",
    "zed",
    // Terminals + multiplexers
    "iterm",
    "terminal",
    "alacritty",
    "kitty",
    "warp",
    "ghostty",
    "wezterm",
    "tmux",
    "hyper",
];

/// True when the listening port is plausibly tied to an AI agent / terminal,
/// either by matching a known process-name fragment, or by living inside a
/// tracked repo (a node/python server spawned during a coding session).
fn is_agent_or_terminal_port(
    port: &crate::models::ListeningPort,
    repos: &[(String, String)],
) -> bool {
    let cmd = port.process.to_lowercase();
    for hint in AGENT_TERMINAL_HINTS {
        if cmd.contains(hint) {
            return true;
        }
    }
    if let Some(cwd) = port.cwd.as_deref() {
        if repos
            .iter()
            .any(|(_, p)| cwd == p || cwd.starts_with(&format!("{p}/")))
        {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn get_setup(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<RepoSetup>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::config::setup_for(&repos))
    })
    .await
}

/// Probe the filesystem for which agents the user has installed. Cheap
/// (three `is_dir` calls), so the frontend caches it for the session rather
/// than this command itself.
#[tauri::command]
pub async fn get_installed_agents() -> Result<InstalledAgents, String> {
    blocking(move || Ok(scanners::install::installed_agents())).await
}

#[tauri::command]
pub async fn get_setup_overview(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<SetupOverview, String> {
    let codex_on = codex_enabled(&app, settings_cache.inner());
    let cursor_on = cursor_enabled(&app, settings_cache.inner());
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        let mut mcp_servers = scanners::install::mcp_servers();
        if codex_on {
            mcp_servers.extend(scanners::install::codex_mcp_servers());
        }
        if cursor_on {
            mcp_servers.extend(scanners::install::cursor_mcp_servers());
        }
        mcp_servers.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(SetupOverview {
            claude: scanners::install::claude_config(),
            codex: codex_on.then(scanners::install::codex_config).flatten(),
            cursor: cursor_on.then(scanners::install::cursor_config).flatten(),
            mcp_servers,
            plugins: scanners::install::plugins(),
            repos: scanners::config::setup_for(&repos),
        })
    })
    .await
}

// ── Phase 2/3 leftovers: ports, diffs, timeline, activity ──────────────

#[tauri::command]
pub async fn get_listening_ports() -> Result<Vec<ListeningPort>, String> {
    blocking(move || Ok(scanners::ports::scan())).await
}

#[tauri::command]
pub async fn get_diffs(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<DiffStat>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index_with_branch(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::git_log::diff_stats(&repos))
    })
    .await
}

#[tauri::command]
pub async fn get_timeline(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<TimelineEvent>, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let cache = cache.inner().clone();
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        let sessions = if claude_on {
            scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        Ok(scanners::git_log::timeline(&sessions, &repos))
    })
    .await
}

#[tauri::command]
pub async fn get_repo_activity(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<RepoActivity>, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let cache = cache.inner().clone();
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        let sessions = if claude_on {
            scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        Ok(scanners::git_log::repo_activity(&sessions, &repos))
    })
    .await
}

// ── Phase 4: Tools + Health ────────────────────────────────────────────

#[tauri::command]
pub async fn get_tool_stats(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    codex_cache: State<'_, CodexCache>,
    settings_cache: State<'_, SettingsCache>,
    project: Option<String>,
    days: Option<u32>,
) -> Result<ToolStats, String> {
    let claude_on = claude_enabled(&app, settings_cache.inner());
    let codex_on = codex_enabled(&app, settings_cache.inner());
    if !claude_on && !codex_on {
        return Ok(scanners::sessions::tool_stats(&[]));
    }
    let cache = cache.inner().clone();
    let codex_cache = codex_cache.inner().clone();
    blocking(move || {
        let mut sessions = if claude_on {
            scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        if codex_on {
            let codex = scanners::codex::scan_all(&codex_cache).map_err(|e| e.to_string())?;
            sessions.extend(codex);
        }
        let filtered: Vec<_> = match project.as_deref() {
            Some(name) if !name.is_empty() => sessions
                .into_iter()
                .filter(|s| s.project_name.as_deref() == Some(name))
                .collect(),
            _ => sessions,
        };
        let Some(days) = days.filter(|d| *d > 0) else {
            return Ok(scanners::sessions::tool_stats(&filtered));
        };
        // Windowed: breakdowns cover sessions started in the last `days`
        // local days, but the day series and week-over-week trend stay
        // computed over everything so the trend has a prior week to compare.
        let cutoff = (chrono::Local::now().date_naive()
            - chrono::Duration::days(days as i64 - 1))
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).earliest())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
        let full = scanners::sessions::tool_stats(&filtered);
        let windowed: Vec<_> = filtered.into_iter().filter(|s| s.start_ts >= cutoff).collect();
        let mut stats = scanners::sessions::tool_stats(&windowed);
        stats.by_day = full.by_day;
        stats.vs_last_week_pct = full.vs_last_week_pct;
        stats.projects = full.projects;
        Ok(stats)
    })
    .await
}

#[tauri::command]
pub async fn get_deps(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<DepEntry>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::health::scan_deps(&repos))
    })
    .await
}

#[tauri::command]
pub async fn get_worktrees(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<WorktreeEntry>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::health::scan_worktrees(&repos))
    })
    .await
}

#[tauri::command]
pub async fn prune_worktrees(repo_paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        // Try every repo, then report all failures — one locked repo
        // shouldn't leave the rest unpruned.
        let failures: Vec<String> = repo_paths
            .iter()
            .filter_map(|repo| {
                scanners::health::prune_worktrees(repo)
                    .err()
                    .map(|e| format!("{repo}: {e}"))
            })
            .collect();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("\n"))
        }
    })
    .await
}

#[tauri::command]
pub async fn unlock_worktree(repo_path: String, worktree_path: String) -> Result<(), String> {
    blocking(move || scanners::health::unlock_worktree(&repo_path, &worktree_path)).await
}

#[tauri::command]
pub async fn get_env_files(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<EnvFile>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::health::scan_env(&repos))
    })
    .await
}

#[tauri::command]
pub async fn get_claude_md_lint_reports(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<Vec<ClaudeMdLintReport>, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(scanners::health::scan_claude_md_lint(&repos))
    })
    .await
}

// ── Snapshots ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn take_snapshot(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
    name: String,
    note: Option<String>,
) -> Result<Snapshot, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        scanners::snapshots::capture(&app, &repos, &name, note.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn list_snapshots(app: AppHandle) -> Result<Vec<Snapshot>, String> {
    blocking(move || scanners::snapshots::list(&app).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn delete_snapshot(app: AppHandle, id: String) -> Result<(), String> {
    blocking(move || scanners::snapshots::delete(&app, &id).map_err(|e| e.to_string())).await
}

// ── GitHub pull requests ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_pull_requests(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
    github_cache: State<'_, GithubCache>,
) -> Result<PullRequestList, String> {
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    let github_cache = github_cache.inner().clone();
    blocking(move || {
        let repos = repo_index(&app, &settings_cache, &repo_cache)?;
        Ok(github_cache.get_or_fetch(&repos))
    })
    .await
}

// ── Usage / rate limits ────────────────────────────────────────────────

#[tauri::command]
pub async fn get_usage_limits(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
    // Set by the dashboard "retry" button to bypass the remote-usage cache so
    // a transient failure (offline blip) can be re-pinged on demand instead of
    // waiting out the backoff window. Background polls omit it (defaults false).
    force: Option<bool>,
) -> Result<UsageLimits, String> {
    let s = settings_cache.load(&app).unwrap_or_default();
    let claude_on = s.agents.claude_code;
    let codex_on = s.agents.codex;
    let cursor_on = s.agents.cursor;
    let agents = s.agents.clone();
    let force = force.unwrap_or(false);
    blocking(move || {
        let mut limits = scanners::usage::collect(&agents, force);
        // Honor the data-source toggles: if a provider is disabled in
        // settings, drop its entry rather than showing stale state.
        limits.providers.retain(|p| match p.provider.as_str() {
            "claude" => claude_on,
            "codex" => codex_on,
            "cursor" => cursor_on,
            _ => true,
        });
        Ok(limits)
    })
    .await
}

#[tauri::command]
pub async fn get_provider_status(
    app: AppHandle,
    settings_cache: State<'_, SettingsCache>,
) -> Result<crate::models::ProviderStatusList, String> {
    let s = settings_cache.load(&app).unwrap_or_default();
    let mut enabled: Vec<&str> = Vec::new();
    if s.agents.claude_code {
        enabled.push("claude");
    }
    if s.agents.codex {
        enabled.push("codex");
    }
    if s.agents.cursor {
        enabled.push("cursor");
    }
    blocking(move || Ok(scanners::status::collect(&enabled))).await
}

// ── Aggregate ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_dashboard_summary(
    app: AppHandle,
    cache: State<'_, SessionsCache>,
    codex_cache: State<'_, CodexCache>,
    settings_cache: State<'_, SettingsCache>,
    repo_cache: State<'_, RepoCache>,
) -> Result<DashboardSummary, String> {
    let cache = cache.inner().clone();
    let codex_cache = codex_cache.inner().clone();
    let settings_cache = settings_cache.inner().clone();
    let repo_cache = repo_cache.inner().clone();
    blocking(move || {
        let s = settings_cache.load(&app)?;
        let repos = repo_cache.get_or_scan(&s.scan_dirs)?;
        let claude_on = s.agents.claude_code;
        let codex_on = s.agents.codex;
        let mut sessions = if claude_on {
            scanners::sessions::scan_all(&cache).map_err(|e| e.to_string())?
        } else {
            Vec::new()
        };
        if codex_on {
            let codex = scanners::codex::scan_all(&codex_cache).map_err(|e| e.to_string())?;
            sessions.extend(codex);
        }
        // `processes::scan` returns claude / codex / cursor / cline rows. We
        // still skip the scan when every gate is off, but otherwise post-filter
        // by enabled agent so Active Sessions stays consistent with the
        // user's settings.
        let cursor_on = s.agents.cursor;
        let active = if claude_on || codex_on || cursor_on {
            let mut procs = scanners::processes::scan();
            procs.retain(|p| {
                let raw = p.name.to_lowercase();
                let n = raw.strip_suffix(".exe").unwrap_or(&raw);
                let is_claude = n == "claude" || n.starts_with("claude ") || n == "cline";
                let is_codex = n == "codex" || n.starts_with("codex ");
                let is_cursor = n == "cursor" || n.starts_with("cursor ");
                (is_claude && claude_on) || (is_codex && codex_on) || (is_cursor && cursor_on)
            });
            procs
        } else {
            Vec::new()
        };

        let total_cost: f64 = sessions.iter().map(|s| s.cost_usd).sum();

        Ok(DashboardSummary {
            total_repos: repos.len(),
            active_sessions: active.len(),
            total_cost_usd: total_cost,
            uncommitted_repos: repos.iter().filter(|r| r.has_uncommitted).count(),
            activity_30d: scanners::sessions::activity_30d(&sessions),
        })
    })
    .await
}
