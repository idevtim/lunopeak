import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri";
import { isOnline } from "@/hooks/useOnline";
import type { StatuslinePrefs } from "@/types/api";

/**
 * Single source of truth for query keys + the queryFn for each.
 *
 * Centralizing here means views and the boot-time prefetch agree on the
 * same shape, and rename refactors only touch one place.
 */
export const queries = {
  username: {
    queryKey: ["username"] as const,
    queryFn: api.getUsername,
    staleTime: Infinity, // doesn't change at runtime
  },
  settings: {
    queryKey: ["settings"] as const,
    queryFn: api.getSettings,
    staleTime: 60 * 60 * 1000, // 1h — only changes when user edits
  },
  availableEditors: {
    queryKey: ["available-editors"] as const,
    queryFn: api.getAvailableEditors,
    staleTime: Infinity, // platform doesn't change at runtime
  },
  // Filesystem probe (~/.claude, ~/.codex, ~/.cursor). The user *could*
  // install a new agent mid-session, but it's rare enough that we treat the
  // result as session-stable rather than polling.
  installedAgents: {
    queryKey: ["installed-agents"] as const,
    queryFn: api.getInstalledAgents,
    staleTime: Infinity,
  },
  repos: {
    queryKey: ["repos"] as const,
    queryFn: api.scanRepos,
    staleTime: 5 * 60 * 1000,
  },
  reposOverview: {
    queryKey: ["repos-overview"] as const,
    queryFn: api.getReposOverview,
    staleTime: 5 * 60 * 1000,
  },
  repoDetail: (path: string) => ({
    queryKey: ["repo-detail", path] as const,
    queryFn: () => api.getRepoDetail(path),
    staleTime: 5 * 60 * 1000,
  }),
  repoDirtyFiles: (path: string) => ({
    queryKey: ["repo-dirty-files", path] as const,
    queryFn: () => api.getRepoDirtyFiles(path),
    staleTime: 30 * 1000,
  }),
  repoStashes: (path: string) => ({
    queryKey: ["repo-stashes", path] as const,
    queryFn: () => api.getRepoStashes(path),
    staleTime: 30 * 1000,
  }),
  repoFileDiffs: (path: string) => ({
    queryKey: ["repo-file-diffs", path] as const,
    queryFn: () => api.getRepoFileDiffs(path),
    staleTime: 30 * 1000,
  }),
  repoBranches: (path: string) => ({
    queryKey: ["repo-branches", path] as const,
    queryFn: () => api.getRepoBranches(path),
    staleTime: 60 * 1000,
  }),
  dashboardSummary: {
    queryKey: ["dashboard-summary"] as const,
    queryFn: api.getDashboardSummary,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  },
  sessionStats: {
    queryKey: ["session-stats"] as const,
    queryFn: api.getSessionStats,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  },
  costs: {
    queryKey: ["costs"] as const,
    queryFn: api.getCosts,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  },
  repoCostDetail: (repoKey: string) => ({
    queryKey: ["repo-cost-detail", repoKey] as const,
    queryFn: () => api.getRepoCostDetail(repoKey),
    staleTime: 60 * 1000,
  }),
  sessions: {
    queryKey: ["sessions"] as const,
    queryFn: api.getSessions,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  },
  // Live: short stale, fast poll. Owned by the view's useQuery.
  activeProcesses: {
    queryKey: ["active-processes"] as const,
    queryFn: api.getActiveProcesses,
    staleTime: 1500,
  },
  liveActivity: {
    queryKey: ["live-activity"] as const,
    queryFn: () => api.getLiveActivity(40),
    staleTime: 1500,
  },
  liveContexts: {
    queryKey: ["live-contexts"] as const,
    queryFn: api.getLiveContexts,
    staleTime: 1500,
  },
  terminalIntegrations: {
    queryKey: ["terminal-integrations"] as const,
    queryFn: api.getTerminalIntegrations,
    staleTime: 10 * 1000,
  },
  statuslinePreview: (prefs: StatuslinePrefs) => ({
    queryKey: ["statusline-preview", prefs] as const,
    queryFn: () => api.previewStatusline(prefs),
    staleTime: 30 * 1000,
  }),

  // Phase 3: config inventory
  claudeMd: {
    queryKey: ["claude-md"] as const,
    queryFn: api.getClaudeMd,
    staleTime: 5 * 60 * 1000,
  },
  skills: {
    queryKey: ["skills"] as const,
    queryFn: api.getSkills,
    staleTime: 5 * 60 * 1000,
  },
  skillBody: (path: string) => ({
    queryKey: ["skill-body", path] as const,
    queryFn: () => api.readSkillBody(path),
    staleTime: 5 * 60 * 1000,
  }),
  agents: {
    queryKey: ["agents"] as const,
    queryFn: api.getAgents,
    staleTime: 5 * 60 * 1000,
  },
  agentBody: (path: string) => ({
    queryKey: ["agent-body", path] as const,
    queryFn: () => api.readAgentBody(path),
    staleTime: 5 * 60 * 1000,
  }),
  hooks: {
    queryKey: ["hooks"] as const,
    queryFn: api.getHooks,
    staleTime: 5 * 60 * 1000,
  },
  hygiene: {
    queryKey: ["hygiene"] as const,
    queryFn: api.getHygiene,
    staleTime: 5 * 60 * 1000,
  },
  // Cheap lockfile probe; the audits themselves run on demand (useMutation).
  auditTargets: {
    queryKey: ["audit-targets"] as const,
    queryFn: api.listAuditTargets,
    staleTime: 5 * 60 * 1000,
  },
  setup: {
    queryKey: ["setup"] as const,
    queryFn: api.getSetup,
    staleTime: 5 * 60 * 1000,
  },
  setupOverview: {
    queryKey: ["setup-overview"] as const,
    queryFn: api.getSetupOverview,
    staleTime: 5 * 60 * 1000,
  },

  // Phase 2/3 leftovers
  listeningPorts: {
    queryKey: ["listening-ports"] as const,
    queryFn: api.getListeningPorts,
    staleTime: 10 * 1000, // ports change often; keep this short
  },
  diffs: {
    queryKey: ["diffs"] as const,
    queryFn: api.getDiffs,
    staleTime: 60 * 1000, // diffs change with every save; 1 min is enough
  },
  timeline: {
    queryKey: ["timeline"] as const,
    queryFn: api.getTimeline,
    staleTime: 5 * 60 * 1000,
  },
  repoActivity: {
    queryKey: ["repo-activity"] as const,
    queryFn: api.getRepoActivity,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  },
  // Backed by `gh` CLI calls — slow on first hit, then cached for 2 min in
  // Rust. The 5 min staleTime here is the React Query layer; manual reload
  // (or cache eviction) round-trips for the freshest list.
  pullRequests: {
    queryKey: ["pull-requests"] as const,
    queryFn: api.getPullRequests,
    staleTime: 5 * 60 * 1000,
  },

  // Phase 4
  toolStats: (project: string | null, days: number | null = null) => ({
    queryKey: ["tool-stats", project, days] as const,
    queryFn: () => api.getToolStats(project, days),
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  }),
  deps: {
    queryKey: ["deps"] as const,
    queryFn: api.getDeps,
    staleTime: 10 * 60 * 1000, // manifests rarely change
  },
  worktrees: {
    queryKey: ["worktrees"] as const,
    queryFn: api.getWorktrees,
    staleTime: 60 * 1000,
  },
  envFiles: {
    queryKey: ["env-files"] as const,
    queryFn: api.getEnvFiles,
    staleTime: 5 * 60 * 1000,
  },
  claudeMdLintReports: {
    queryKey: ["claude-md-lint-reports"] as const,
    queryFn: api.getClaudeMdLintReports,
    staleTime: 5 * 60 * 1000,
  },

  // Phase 6
  snapshots: {
    queryKey: ["snapshots"] as const,
    queryFn: api.listSnapshots,
    staleTime: 60 * 1000,
  },

  // Provider rate-limit windows for the dashboard. The Anthropic side is
  // fronted by a cached scanner (see usage.rs): a short success TTL, but the
  // fetch is skipped entirely while no new local Claude JSONL is written, and
  // it backs off for 15 min on 429. Polling faster than the tray buys nothing
  // — poll on the same cadence (REFRESH_SECS in tray.rs) so the dashboard
  // never drifts behind the menu bar when fresh data lands.
  // The menu bar's background update check (`updates.rs`). Pushed by the
  // `update://available` event, so no polling.
  availableUpdate: {
    queryKey: ["available-update"] as const,
    queryFn: api.getAvailableUpdate,
    staleTime: Infinity,
  },
  usageLimits: {
    queryKey: ["usage-limits"] as const,
    // Wrapped (not a bare `api.getUsageLimits`) so TanStack's QueryFunction-
    // Context isn't passed positionally as `force` — background polls must
    // never force-bypass the backoff cache. The retry button forces explicitly.
    queryFn: () => api.getUsageLimits(),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 60 * 1000,
  },

  // Provider StatusPage health. Backend caches for 5 min and fans out across
  // all enabled providers in parallel, so the cost of a refetch is one HTTP
  // pair per provider every 5 min — cheap enough to poll on the same cadence
  // as usage limits.
  providerStatus: {
    queryKey: ["provider-status"] as const,
    queryFn: api.getProviderStatus,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  },
} as const;

/**
 * Warm the heavy queries on app boot so the first navigation to any view
 * paints with cached data. Backend cache means the second call is also
 * fast — this just bridges the *first* render gap.
 */
export async function prefetchOnBoot(qc: QueryClient) {
  const online = isOnline();
  const tasks = [
    qc.prefetchQuery(queries.settings),
    qc.prefetchQuery(queries.repos),
    qc.prefetchQuery(queries.dashboardSummary),
    qc.prefetchQuery(queries.sessionStats),
    qc.prefetchQuery(queries.costs),
    qc.prefetchQuery(queries.liveActivity),
    qc.prefetchQuery(queries.sessions),
    qc.prefetchQuery(queries.toolStats(null)),
    qc.prefetchQuery(queries.listeningPorts),
  ];
  // Skip the network-dependent prefetches when offline — `usageLimits` hits
  // api.anthropic.com / cursor.com, `providerStatus` hits the StatusPages.
  // The views' `enabled: online` flag will re-trigger them on reconnect.
  if (online) {
    tasks.push(
      qc.prefetchQuery(queries.usageLimits),
      qc.prefetchQuery(queries.providerStatus),
    );
  }
  await Promise.all(tasks);
}
