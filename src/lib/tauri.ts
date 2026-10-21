import { invoke } from "@tauri-apps/api/core";
import type {
  ActiveProcess,
  AuditManager,
  AuditReport,
  AuditTarget,
  ClaudeMdEntry,
  ClaudeMdLintReport,
  ConfigArtifact,
  CostBreakdown,
  RepoCostDetail,
  DepEntry,
  DiffStat,
  BranchInfo,
  DirtyFile,
  FileDiff,
  RepoStash,
  EnvFile,
  HookEntry,
  HygieneIssue,
  InstalledAgents,
  ListeningPort,
  LiveActivity,
  LiveContext,
  TerminalIntegrations,
  StatuslinePrefs,
  StatuslineSpan,
  LogEntry,
  DashboardSummary,
  PullRequestList,
  Repo,
  RepoActivity,
  RepoDetail,
  ReposOverview,
  RepoSetup,
  Session,
  SessionDetail,
  SessionStats,
  TranscriptMatch,
  Settings,
  SetupOverview,
  Snapshot,
  TimelineEvent,
  ToolStats,
  UsageLimits,
  ProviderStatusList,
  WorktreeEntry,
} from "@/types/api";
import * as demo from "./demoFixtures";
// Logging an IPC failure is deferred to call-time, so this import being part of
// a cycle (logger.ts imports `api` from here) is safe — neither side uses the
// other at module-evaluation time.
import { breadcrumb } from "./logger";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Demo mode: serve the same fixtures the browser-only runtime uses, even
 * when running under `tauri:dev`. Set `VITE_DEMO_MODE=1` to enable.
 *
 * Useful for screenshots and design review — the UI fills with believable
 * data instead of the user's real repos and usage.
 */
const isDemo = () => import.meta.env.VITE_DEMO_MODE === "1";

/** True when `call()` should bypass IPC and return the fixture instead. */
export const useFixtures = () => !isTauri() || isDemo();

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
  fallback?: T,
): Promise<T> {
  if (useFixtures()) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Tauri command "${cmd}" called outside Tauri runtime`);
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Breadcrumb every IPC failure for the diagnostics log. `appendLog` calls
    // `invoke` directly (not `call`), so logging here can't recurse.
    breadcrumb("ipc", `${cmd} failed`, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export const api = {
  // Identity
  getUsername: () => call<string | null>("get_username", undefined, "Timothy"),

  // Settings
  getSettings: () =>
    call<Settings>("get_settings", undefined, demo.settingsFixture),
  updateSettings: async (settings: Settings) => {
    // In demo / browser mode there's no Rust backend to persist to —
    // mutate the in-memory fixture so the next `getSettings` reflects the
    // change. Lets demo users actually flip the theme switch (and other
    // toggles) and see the UI react.
    if (useFixtures()) {
      Object.assign(demo.settingsFixture, settings);
      return;
    }
    return invoke<void>("update_settings", { settings });
  },

  // Repos
  scanRepos: () => call<Repo[]>("scan_repos", undefined, demo.repos),
  getRepos: () => call<Repo[]>("get_repos", undefined, demo.repos),
  getReposOverview: () =>
    call<ReposOverview>("get_repos_overview", undefined, demo.reposOverview),
  getRepoDetail: (path: string) =>
    call<RepoDetail | null>("get_repo_detail", { path }, demo.repoDetail(path)),
  openInTerminal: (path: string) => call<void>("open_in_terminal", { path }),
  openInVscode: (path: string) => call<void>("open_in_vscode", { path }),
  openInClaude: (path: string) => call<void>("open_in_claude", { path }),
  openInCodex: (path: string) => call<void>("open_in_codex", { path }),
  openInCursor: (path: string) => call<void>("open_in_cursor", { path }),
  openPathInEditor: (path: string, editor: string | null) =>
    call<void>("open_path_in_editor", { path, editor }),
  getAvailableEditors: () =>
    call<string[]>(
      "get_available_editors",
      undefined,
      ["vscode", "vscode-insiders", "cursor", "antigravity", "windsurf", "zed", "sublime"],
    ),
  gitPull: (path: string) => call<string>("git_pull", { path }, ""),
  getRepoDirtyFiles: (path: string) =>
    call<DirtyFile[]>("get_repo_dirty_files", { path }, demo.repoDirtyFiles(path)),
  getRepoStashes: (path: string) =>
    call<RepoStash[]>("get_repo_stashes", { path }, demo.repoStashes(path)),
  getRepoFileDiffs: (path: string) =>
    call<FileDiff[]>("get_repo_file_diffs", { path }, demo.repoFileDiffs(path)),
  getRepoBranches: (path: string) =>
    call<BranchInfo[]>("get_repo_branches", { path }, demo.repoBranches(path)),
  gitDeleteBranch: (path: string, branch: string) =>
    call<string>("git_delete_branch", { path, branch }, ""),
  gitDropStash: (path: string, reflog: string) =>
    call<string>("git_drop_stash", { path, reflog }, ""),
  createClaudeMd: (path: string) => call<void>("create_claude_md", { path }),

  // Sessions
  getSessions: () => call<Session[]>("get_sessions", undefined, demo.sessions),
  getSessionStats: () =>
    call<SessionStats>("get_session_stats", undefined, demo.sessionStats),
  getSessionDetail: (id: string) =>
    call<SessionDetail | null>("get_session_detail", { id }, demo.sessionDetail(id)),
  searchTranscripts: (query: string) =>
    call<TranscriptMatch[]>("search_transcripts", { query }, demo.transcriptMatches(query)),
  getCosts: () => call<CostBreakdown>("get_costs", undefined, demo.costs),
  getRepoCostDetail: (repoKey: string) =>
    call<RepoCostDetail>(
      "get_repo_cost_detail",
      { repoKey },
      demo.repoCostDetail(repoKey),
    ),
  getActiveProcesses: () =>
    call<ActiveProcess[]>("get_active_processes", undefined, demo.activeProcesses),
  killProcess: (pid: number) => call<void>("kill_process", { pid }),
  revealInFinder: (path: string) => call<void>("reveal_in_finder", { path }),
  getLiveActivity: (limit?: number) =>
    call<LiveActivity>("get_live_activity", { limit: limit ?? null }, demo.liveActivity),
  getLiveContexts: () =>
    call<LiveContext[]>("get_live_contexts", undefined, demo.liveContexts),

  // Terminal status lines
  getTerminalIntegrations: () =>
    call<TerminalIntegrations>(
      "get_terminal_integrations",
      undefined,
      demo.terminalIntegrations,
    ),
  previewStatusline: (prefs: StatuslinePrefs) =>
    call<StatuslineSpan[]>("preview_statusline", { prefs }, demo.previewStatusline(prefs)),
  setClaudeStatusline: (enabled: boolean) =>
    call<TerminalIntegrations>("set_claude_statusline", { enabled }, {
      ...demo.terminalIntegrations,
      claude: { ...demo.terminalIntegrations.claude, installed: enabled },
    }),
  setCodexStatusline: (enabled: boolean) =>
    call<TerminalIntegrations>("set_codex_statusline", { enabled }, {
      ...demo.terminalIntegrations,
      codex: { ...demo.terminalIntegrations.codex, installed: enabled },
    }),

  // Phase 3: config inventory
  getClaudeMd: () => call<ClaudeMdEntry[]>("get_claude_md", undefined, demo.claudeMd),
  getSkills: () => call<ConfigArtifact[]>("get_skills", undefined, demo.skills),
  readSkillBody: (path: string) =>
    call<string>(
      "read_skill_body",
      { path },
      "# Demo skill\n\nThis is a fixture body shown in demo mode.\n",
    ),
  getAgents: () => call<ConfigArtifact[]>("get_agents", undefined, demo.agents),
  readAgentBody: (path: string) =>
    call<string>(
      "read_agent_body",
      { path },
      "# Demo agent\n\nThis is a fixture body shown in demo mode.\n",
    ),
  getHooks: () => call<HookEntry[]>("get_hooks", undefined, demo.hooks),
  getHygiene: () => call<HygieneIssue[]>("get_hygiene", undefined, demo.hygiene),

  // Dependency audits — on-demand, so the fallbacks keep the UI inert (no
  // targets to audit) in browser/demo mode where there's no shell to run them.
  listAuditTargets: () =>
    call<AuditTarget[]>("list_audit_targets", undefined, []),
  runAudit: (repoPath: string, manager: AuditManager, force = false) =>
    call<AuditReport>("run_audit", { repoPath, manager, force }, {
      manager,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      info: 0,
      total: 0,
      error: "Audits require the desktop app",
      message: null,
      checkedAt: null,
    }),
  runAuditFix: (repoPath: string, manager: AuditManager) =>
    call<AuditReport>("run_audit_fix", { repoPath, manager }, {
      manager,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      info: 0,
      total: 0,
      error: "Audits require the desktop app",
      message: null,
      checkedAt: null,
    }),
  getSetup: () => call<RepoSetup[]>("get_setup", undefined, demo.setupRepos),
  getSetupOverview: () =>
    call<SetupOverview>("get_setup_overview", undefined, demo.setupOverview),
  // Browser / demo mode reports every agent as installed so the UI exercises
  // its full set of features. Real Tauri runs read from the filesystem.
  getInstalledAgents: () =>
    call<InstalledAgents>("get_installed_agents", undefined, {
      claudeCode: true,
      codex: true,
      cursor: true,
    }),

  // Phase 2/3 leftovers
  getListeningPorts: () =>
    call<ListeningPort[]>("get_listening_ports", undefined, demo.listeningPorts),
  getDiffs: () => call<DiffStat[]>("get_diffs", undefined, demo.diffs),
  getTimeline: () => call<TimelineEvent[]>("get_timeline", undefined, demo.timeline),
  getRepoActivity: () =>
    call<RepoActivity[]>("get_repo_activity", undefined, demo.repoActivity),
  getPullRequests: () =>
    call<PullRequestList>("get_pull_requests", undefined, demo.pullRequests),

  // Phase 4
  /** `days` limits the breakdowns to sessions started in the last N days; null = all time. */
  getToolStats: (project?: string | null, days?: number | null) =>
    call<ToolStats>(
      "get_tool_stats",
      { project: project ?? null, days: days ?? null },
      demo.toolStats,
    ),
  getDeps: () => call<DepEntry[]>("get_deps", undefined, demo.deps),
  getWorktrees: () => call<WorktreeEntry[]>("get_worktrees", undefined, demo.worktrees),
  /** `git worktree prune` in each repo — drops worktrees whose folder is gone. */
  pruneWorktrees: (repoPaths: string[]) =>
    useFixtures() ? Promise.resolve() : call<void>("prune_worktrees", { repoPaths }),
  unlockWorktree: (repoPath: string, worktreePath: string) =>
    useFixtures()
      ? Promise.resolve()
      : call<void>("unlock_worktree", { repoPath, worktreePath }),
  getEnvFiles: () => call<EnvFile[]>("get_env_files", undefined, demo.envFiles),
  getClaudeMdLintReports: () =>
    call<ClaudeMdLintReport[]>(
      "get_claude_md_lint_reports",
      undefined,
      demo.claudeMdLintReports,
    ),

  // Phase 6 — Snapshots
  takeSnapshot: (name: string, note?: string) =>
    call<Snapshot>("take_snapshot", { name, note: note ?? null }),
  listSnapshots: () => call<Snapshot[]>("list_snapshots", undefined, demo.snapshots),
  deleteSnapshot: (id: string) =>
    useFixtures() ? Promise.resolve() : call<void>("delete_snapshot", { id }),

  // Aggregate
  getDashboardSummary: () =>
    call<DashboardSummary>("get_dashboard_summary", undefined, demo.dashboardSummary),
  // `force` bypasses the Rust remote-usage cache so the dashboard "retry"
  // button can re-ping after a transient failure instead of waiting out the
  // backoff window. Background polls omit it.
  getUsageLimits: (force = false) =>
    call<UsageLimits>("get_usage_limits", { force }, demo.usageLimits),
  getProviderStatus: () =>
    call<ProviderStatusList>("get_provider_status", undefined, {
      providers: [],
    }),

  // Diagnostics
  writeDiagnosticsLog: (path: string, contents: string) =>
    call<void>("write_diagnostics_log", { path, contents }),
  // Bypasses `call()` on purpose: forwarding a log line must never itself emit
  // an IPC-failure breadcrumb (that path lives in `call`), and it's a no-op in
  // browser mode where the in-memory ring buffer is the only sink.
  appendLog: (
    level: LogEntry["level"],
    scope: string,
    msg: string,
    detail?: string,
  ): Promise<void> =>
    useFixtures()
      ? Promise.resolve()
      : invoke<void>("append_log_entry", { level, scope, msg, detail }),
  readDiagnosticsLog: (maxEntries: number) =>
    call<LogEntry[]>("read_diagnostics_log", { maxEntries }, []),

  // Windows
  openAboutWindow: () => call<void>("open_about_window"),
  // Tray-panel actions short-circuit in demo mode (`VITE_DEMO_MODE=1`).
  // `useFixtures()` is true there even under `tauri:demo`, so `call()` would
  // throw on every click with no fallback. We still have a real Tauri
  // runtime under `tauri:demo`, so fall back to the JS API where it gives
  // a reasonable preview (hide / show window); destructive actions (quit)
  // become no-ops to keep the demo session alive.
  hideTrayPanel: async () => {
    if (useFixtures()) {
      if (isTauri()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
      }
      return;
    }
    return invoke<void>("hide_tray_panel");
  },
  trayNavigate: async (route: string) => {
    if (useFixtures()) {
      if (isTauri()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
      }
      // Surface a hash change so any open main-window listener sees the nav.
      if (typeof window !== "undefined") window.location.hash = `#/${route}`;
      return;
    }
    return invoke<void>("tray_navigate", { route });
  },
  openMainWindow: async () => {
    if (useFixtures()) {
      if (isTauri()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
      }
      return;
    }
    return invoke<void>("open_main_window");
  },
  quitApp: async () => {
    if (useFixtures()) return; // Demo keeps running.
    return invoke<void>("quit_app");
  },
  restartApp: async () => {
    if (useFixtures()) return; // No binary to relaunch in browser/demo mode.
    return invoke<void>("restart_app");
  },
  // Version found by the menu bar's own background update check (tray-owning
  // process only — the main window has `updateStore`). Null when up to date.
  getAvailableUpdate: async (): Promise<string | null> => {
    if (useFixtures()) return null;
    return invoke<string | null>("get_available_update");
  },
  // Install that update and relaunch. Only resolves if the install failed.
  installUpdate: async () => {
    if (useFixtures()) return;
    return invoke<void>("install_update");
  },
  // macOS two-process only: a window spawned by the menu bar's "Settings"
  // carries its target route here. The main window pulls it once on mount and
  // navigates. Returns null when there's nothing pending (the usual case).
  takePendingRoute: async (): Promise<string | null> => {
    if (useFixtures()) return null;
    return invoke<string | null>("take_pending_route");
  },
};
