/**
 * Demo fixtures — realistic fake data for screenshots and the browser-only
 * dev runtime. Every value is invented; nothing here references the user's
 * real filesystem, repos, or usage.
 *
 * Activated when:
 *   - the UI is running outside the Tauri runtime (`npm run dev`), or
 *   - `VITE_DEMO_MODE=1` is set (forces fixtures even under `tauri:dev`).
 *
 * Keep all values deterministic so screenshots reproduce. The "now"
 * reference (`NOW`) is captured once at module load.
 */

import type {
  ActiveProcess,
  ClaudeMdEntry,
  ClaudeMdLintReport,
  ConfigArtifact,
  CostBreakdown,
  DepEntry,
  DiffStat,
  BranchInfo,
  DirtyFile,
  FileDiff,
  RepoStash,
  EnvFile,
  HookEntry,
  HygieneIssue,
  ListeningPort,
  LiveActivity,
  LiveContext,
  TerminalIntegrations,
  StatuslinePrefs,
  StatuslineSpan,
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
  WorktreeEntry,
} from "@/types/api";
import type { Conversation } from "@/stores/assistantStore";
import { defaultStatuslinePrefs } from "./statusline";

const NOW = Math.floor(Date.now() / 1000);
const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const HOME = "/Users/timothy";
const CODE = `${HOME}/Code`;

const REPOS = [
  { name: "northstar-web",       branch: "main",            dirty: false },
  { name: "atlas-api",           branch: "feat/auth-2",     dirty: true  },
  { name: "harbor-mobile",       branch: "main",            dirty: false },
  { name: "lighthouse-cli",      branch: "fix/parser",      dirty: true  },
  { name: "signal-design-system",branch: "main",            dirty: false },
  { name: "compass-docs",        branch: "draft/v3",        dirty: true  },
  { name: "orbit-pipelines",     branch: "main",            dirty: false },
  { name: "drift-analytics",     branch: "spike/duckdb",    dirty: false },
] as const;

const repoPath = (name: string) => `${CODE}/${name}`;

// ---- Repos ------------------------------------------------------------

export const repos: Repo[] = REPOS.map((r, i) => ({
  id: `repo-${i + 1}`,
  name: r.name,
  path: repoPath(r.name),
  branch: r.branch,
  hasClaudeMd: i % 4 !== 3, // one missing — feeds hygiene flag
  hasUncommitted: r.dirty,
  lastActivityTs: (NOW - i * 3 * HOUR - 12 * MIN) * 1000,
  sizeKb: 8_000 + i * 4_200,
}));

const COMMIT_SUBJECTS = [
  "fix: clamp pagination cursor to total",
  "feat: cache provider window for 5 minutes",
  "refactor: extract scanner trait",
  "chore: bump tailwind to 4.1",
  "feat: add CSV export to costs view",
  "fix: hide tray icon on Wayland",
  "docs: tighten README quickstart",
  "test: cover diff-truncation edge case",
];

export const reposOverview: ReposOverview = {
  repos: REPOS.map((r, i) => ({
    id: `repo-${i + 1}`,
    name: r.name,
    path: repoPath(r.name),
    branch: r.branch,
    hasClaudeMd: i % 4 !== 3,
    hasUncommitted: r.dirty,
    lastActivityTs: (NOW - i * 3 * HOUR - 12 * MIN) * 1000,
    lastCommitSubject: COMMIT_SUBJECTS[i % COMMIT_SUBJECTS.length],
    unpushedCommits: r.dirty ? (i % 3) + 1 : 0,
    uncommittedFiles: r.dirty ? 3 + (i % 5) : 0,
    stashCount: i === 1 ? 2 : i === 5 ? 1 : 0,
    skillCount: i === 0 ? 4 : i === 2 ? 6 : i === 4 ? 9 : 1,
    activity30d: thirtyDayActivity(i),
  })),
  activeCount: 3,
  dirtyCount: REPOS.filter((r) => r.dirty).length,
  unpushedCount: REPOS.filter((r) => r.dirty).length,
  uncommittedFilesTotal: 18,
  featureBranchCount: REPOS.filter(
    (r) => !["main", "master", "develop"].includes(r.branch),
  ).length,
};

function thirtyDayActivity(seed: number): number[] {
  return Array.from({ length: 30 }, (_, i) => {
    const dow = (i + seed) % 7;
    const isWeekend = dow === 5 || dow === 6;
    const base = isWeekend ? 1 : 4 + ((i * 7 + seed * 3) % 9);
    return base;
  });
}

// ---- Sessions ---------------------------------------------------------

const MODELS = [
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "gpt-5-codex",
  "claude-haiku-4-5",
];

const SESSION_PROMPTS = [
  "Refactor the cost breakdown view to share its header with the dashboard.",
  "Why is the tray icon flashing on Linux?",
  "Add a 'copy as JSON' button to the session detail toolbar.",
  "Find every TODO older than six months and group them by repo.",
  "Help me reason through the new caching layer for usage windows.",
  "Trace where SessionEvent.tool_summary gets populated.",
  "Generate release notes for v1.1.0 from the last 40 commits.",
  "Sketch a Zustand store for ephemeral toast state.",
  "Wire the new editor picker into the repos list.",
  "Suggest a name for the snapshots feature that isn't 'snapshot'.",
  "Investigate why hygiene flags miss repos on Windows.",
  "Draft a CLAUDE.md for the docs site.",
];

export const sessions: Session[] = Array.from({ length: 12 }, (_, i) => {
  const repo = REPOS[i % REPOS.length];
  // Session timestamps are epoch ms, like the real scanner's.
  const startTs = (NOW - i * 5 * HOUR - 17 * MIN) * 1000;
  const dur = (12 * MIN + (i * 73) % (45 * MIN)) * 1000;
  return {
    id: `sess-${i + 1}`,
    projectPath: repoPath(repo.name),
    projectName: repo.name,
    branch: repo.branch,
    model: MODELS[i % MODELS.length],
    startTs,
    endTs: startTs + dur,
    messageCount: 14 + (i * 7) % 60,
    firstPrompt: SESSION_PROMPTS[i % SESSION_PROMPTS.length],
    usage: {
      input: 24_000 + i * 1_800,
      output: 6_000 + i * 480,
      cacheRead: 180_000 + i * 9_000,
      cacheCreation: 12_000 + i * 600,
      cacheCreation1h: 0,
    },
    costUsd: 0.42 + i * 0.18,
    filesEdited: i % 3 === 0
      ? {
          [`${repoPath(repo.name)}/src/lib/usage.rs`]: 3,
          [`${repoPath(repo.name)}/src/views/costs/CostsView.tsx`]: 2,
        }
      : undefined,
  };
});

const HOUR_HISTOGRAM = [
  0, 0, 0, 0, 0, 0, 1, 2, 5, 9, 14, 18,
  17, 16, 19, 22, 20, 15, 10, 6, 4, 2, 1, 0,
];

const DAY_HISTOGRAM_84 = Array.from({ length: 84 }, (_, i) => {
  const dow = i % 7;
  const isWeekend = dow === 5 || dow === 6;
  const base = isWeekend ? 1 : 6 + ((i * 11) % 12);
  return base;
});

export const sessionStats: SessionStats = {
  totalSessions: 142,
  totalMessages: 3_186,
  totalCostUsd: 334.90,
  totalTokens: 26_400_000,
  usage: {
    input: 1_240_000,
    output: 380_000,
    cacheRead: 22_800_000,
    cacheCreation: 1_980_000,
    cacheCreation1h: 0,
  },
  hourHistogram: HOUR_HISTOGRAM,
  dayHistogram: DAY_HISTOGRAM_84,
  byModel: [
    // cacheReadSavingsUsd is $0.75 per 1M cached tokens on Fable 5.1 and
    // $0.20 per 1M on Opus 5.5; zero everywhere else.
    { model: "claude-opus-5",      sessions: 40, costUsd:  46.00, tokens:  9_000_000, cacheReadTokens: 7_400_000, cacheReadSavingsUsd: 0 },
    { model: "claude-opus-5-5",    sessions: 24, costUsd:  22.00, tokens:  5_200_000, cacheReadTokens: 4_100_000, cacheReadSavingsUsd: 0.82 },
    { model: "claude-fable-5-1",   sessions: 12, costUsd:  63.10, tokens:  2_900_000, cacheReadTokens: 4_600_000, cacheReadSavingsUsd: 3.45 },
    { model: "claude-sonnet-5",    sessions: 31, costUsd:  45.80, tokens:  5_800_000, cacheReadTokens: 3_500_000, cacheReadSavingsUsd: 0 },
    { model: "claude-sonnet-4-6",  sessions: 17, costUsd:  24.40, tokens:  3_100_000, cacheReadTokens: 2_200_000, cacheReadSavingsUsd: 0 },
    { model: "gpt-5-codex",        sessions: 22, costUsd:  34.50, tokens:  2_700_000, cacheReadTokens: 900_000, cacheReadSavingsUsd: 0 },
    { model: "claude-haiku-4-5",   sessions:  8, costUsd:   9.70, tokens:    600_000, cacheReadTokens: 100_000, cacheReadSavingsUsd: 0 },
  ],
};

export const sessionDetail = (id: string): SessionDetail => {
  const base = sessions.find((s) => s.id === id) ?? sessions[0];
  return {
    id: base.id,
    projectPath: base.projectPath,
    projectName: base.projectName,
    branch: base.branch,
    model: base.model,
    startTs: base.startTs,
    endTs: base.endTs,
    messageCount: base.messageCount,
    costUsd: base.costUsd,
    usage: base.usage,
    firstPrompt: base.firstPrompt,
    filesModified: [
      `${base.projectPath}/src/lib/usage.rs`,
      `${base.projectPath}/src/views/costs/CostsView.tsx`,
      `${base.projectPath}/README.md`,
    ],
    events: [
      {
        ts: base.startTs,
        kind: "user",
        text: base.firstPrompt,
        toolName: null,
        toolSummary: null,
        toolResult: null,
        isError: false,
      },
      {
        ts: base.startTs + 30_000,
        kind: "assistant",
        text: "Reading the relevant files to understand the current shape.",
        toolName: null,
        toolSummary: null,
        toolResult: null,
        isError: false,
      },
      {
        ts: base.startTs + 60_000,
        kind: "tool_use",
        text: null,
        toolName: "Read",
        toolSummary: `${base.projectPath}/src/lib/usage.rs`,
        toolResult: null,
        isError: false,
      },
      {
        ts: base.startTs + 62_000,
        kind: "tool_result",
        text: null,
        toolName: null,
        toolSummary: null,
        toolResult: "212 lines",
        isError: false,
      },
      {
        ts: base.startTs + 90_000,
        kind: "tool_use",
        text: null,
        toolName: "Edit",
        toolSummary: `${base.projectPath}/src/lib/usage.rs`,
        toolResult: null,
        isError: false,
      },
      {
        ts: base.startTs + 91_000,
        kind: "tool_result",
        text: null,
        toolName: null,
        toolSummary: null,
        toolResult: "Updated 1 hunk",
        isError: false,
      },
      {
        ts: base.startTs + 120_000,
        kind: "tool_use",
        text: null,
        toolName: "Bash",
        toolSummary: "pnpm vitest usage",
        toolResult: null,
        isError: false,
      },
      {
        ts: base.startTs + 140_000,
        kind: "tool_result",
        text: null,
        toolName: null,
        toolSummary: null,
        toolResult: "2 failed, 14 passed",
        isError: true,
      },
      {
        ts: base.startTs + 150_000,
        kind: "assistant",
        text: "Two tests still expect the old shape. Updating them now, then I'll rerun the suite.",
        toolName: null,
        toolSummary: null,
        toolResult: null,
        isError: false,
      },
    ],
  };
};

/** Browser-mode stand-in for `search_transcripts`: scans the demo details. */
export const transcriptMatches = (query: string): TranscriptMatch[] => {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return sessions.flatMap((s) => {
    const matches = sessionDetail(s.id).events.reduce(
      (n, e) => n + ((e.text ?? "").toLowerCase().split(q).length - 1),
      0,
    );
    return matches > 0 ? [{ sessionId: s.id, matches }] : [];
  });
};

// ---- Costs ------------------------------------------------------------

export const costs: CostBreakdown = {
  totalUsd: 334.90,
  totalTokens: 12_400_000,
  totalMessages: 2_840,
  byModel: sessionStats.byModel,
  byRepo: REPOS.slice(0, 6).map((r, i) => ({
    repoName: r.name,
    repoPath: repoPath(r.name),
    costUsd: 88.00 - i * 12.30,
    sessions: 32 - i * 4,
    tokens: (3_100_000 - i * 420_000) | 0,
    messages: (720 - i * 90) | 0,
  })),
  byDay: Array.from({ length: 30 }, (_, i) => {
    const dow = i % 7;
    const isWeekend = dow === 5 || dow === 6;
    return Number(((isWeekend ? 2.5 : 12.0 + (i % 5) * 1.2)).toFixed(2));
  }),
};

// Demo fixture for the per-repo drill-down view. Synthesized so the
// browser-only runtime can render a complete page.
export function repoCostDetail(repoKey: string) {
  const target =
    costs.byRepo.find((r) => r.repoName === repoKey || r.repoPath === repoKey) ??
    costs.byRepo[0];
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const startOfTodayLocal = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const byDay = Array.from({ length: 30 }, (_, i) => {
    const dayIdx = 29 - i;
    const start = startOfTodayLocal - dayIdx * dayMs;
    const end = start + dayMs;
    const date = new Date(start);
    const cost = costs.byDay[i] ?? 0;
    const ratio = target.costUsd / Math.max(0.0001, costs.totalUsd);
    const repoCost = cost * (ratio * 6);
    return {
      startTs: start,
      endTs: end,
      label: date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      sessions: Math.max(0, Math.round(repoCost / 4)),
      messages: Math.max(0, Math.round(repoCost * 6)),
      tokens: Math.max(0, Math.round(repoCost * 22_000)),
      costUsd: Number(repoCost.toFixed(2)),
    };
  });
  const fiveHourMs = 5 * 60 * 60 * 1000;
  const byFiveHour = Array.from({ length: 20 }, (_, i) => {
    const start = Math.floor((now - i * fiveHourMs) / fiveHourMs) * fiveHourMs;
    const end = start + fiveHourMs;
    const cost = 1.2 + ((i * 13) % 7) * 0.5;
    return {
      startTs: start,
      endTs: end,
      label: `${new Date(start).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
      })}–${new Date(end).toLocaleString(undefined, { hour: "numeric" })}`,
      sessions: 1 + (i % 3),
      messages: 24 + (i % 6) * 8,
      tokens: 84_000 + (i % 5) * 12_000,
      costUsd: Number(cost.toFixed(2)),
    };
  });
  const byWeek = Array.from({ length: 5 }, (_, i) => {
    const start = startOfTodayLocal - (i * 7 + new Date().getDay()) * dayMs;
    const end = start + 7 * dayMs;
    const cost = 18 + ((i * 5) % 4) * 3.4;
    return {
      startTs: start,
      endTs: end,
      label: `${new Date(start).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })} – ${new Date(end - dayMs).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}`,
      sessions: 12 + i,
      messages: 220 + i * 12,
      tokens: 880_000 + i * 32_000,
      costUsd: Number(cost.toFixed(2)),
    };
  });
  const byWeeklySession = Array.from({ length: 4 }, (_, i) => {
    const start = now - (i * 7 + 1) * dayMs;
    const end = start + 7 * dayMs;
    const cost = 24 + ((i * 7) % 5) * 2.1;
    return {
      startTs: start,
      endTs: end,
      label: `${new Date(start).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })} session`,
      sessions: 8 + i,
      messages: 160 + i * 18,
      tokens: 640_000 + i * 40_000,
      costUsd: Number(cost.toFixed(2)),
    };
  });
  return {
    repoName: target.repoName,
    repoPath: target.repoPath,
    totals: {
      sessions: target.sessions,
      messages: target.messages,
      tokens: target.tokens,
      costUsd: target.costUsd,
    },
    byDay,
    byFiveHour,
    byWeek,
    byWeeklySession,
  };
}

// ---- Live -------------------------------------------------------------

const LIVE_TOOLS: { tool: string; summary: string; agent: "claude" | "codex" | "cursor" }[] = [
  { tool: "Read",   summary: "src/views/costs/CostsView.tsx",            agent: "claude" },
  { tool: "Edit",   summary: "src/lib/tauri.ts:42",                      agent: "claude" },
  { tool: "Bash",   summary: "npm run typecheck",                        agent: "claude" },
  { tool: "Grep",   summary: "queries.usageLimits",                      agent: "claude" },
  { tool: "Read",   summary: "src-tauri/src/commands.rs",                agent: "codex"  },
  { tool: "Write",  summary: "src/lib/demoFixtures.ts",                  agent: "codex"  },
  { tool: "Bash",   summary: "git status",                               agent: "codex"  },
  { tool: "Edit",   summary: "content/intro.md:14",                      agent: "cursor" },
  { tool: "Read",   summary: "content/quickstart.md",                    agent: "cursor" },
  { tool: "Edit",   summary: "src/components/Hero.tsx:88",               agent: "cursor" },
];

const LIVE_AGENT_SESSIONS: Record<"claude" | "codex" | "cursor", string> = {
  claude: "sess-live-1",
  codex:  "sess-live-2",
  cursor: "sess-live-3",
};

const LIVE_AGENT_CWD: Record<"claude" | "codex" | "cursor", string> = {
  claude: repoPath("northstar-web"),
  codex:  repoPath("atlas-api"),
  cursor: repoPath("compass-docs"),
};

export const liveActivity: LiveActivity = {
  feed: LIVE_TOOLS.map((t, i) => ({
    ts: (NOW - i * 12 - 4) * 1000,
    sessionId: LIVE_AGENT_SESSIONS[t.agent],
    cwd: LIVE_AGENT_CWD[t.agent],
    tool: t.tool,
    summary: t.summary,
    agent: t.agent,
  })),
  sessions: [
    {
      sessionId: "sess-live-1",
      cwd: repoPath("northstar-web"),
      lastTs: (NOW - 4) * 1000,
      lastTool: "Edit",
      lastSummary: "src/lib/tauri.ts:42",
      todos: [
        { content: "Wire fixtures into the call() helper", status: "in_progress" },
        { content: "Verify types compile",                  status: "pending"     },
        { content: "Add demo npm script",                   status: "pending"     },
      ],
      agent: "claude",
    },
    {
      sessionId: "sess-live-2",
      cwd: repoPath("atlas-api"),
      lastTs: (NOW - 56) * 1000,
      lastTool: "Bash",
      lastSummary: "git status",
      todos: [
        { content: "Reproduce the auth race",    status: "completed"   },
        { content: "Patch token refresh path",   status: "in_progress" },
        { content: "Add regression test",        status: "pending"     },
      ],
      agent: "codex",
    },
    {
      sessionId: "sess-live-3",
      cwd: repoPath("compass-docs"),
      lastTs: (NOW - 22) * 1000,
      lastTool: "Edit",
      lastSummary: "content/intro.md:14",
      todos: [
        { content: "Tighten the quickstart intro",  status: "completed"   },
        { content: "Rewrite the hero copy",         status: "in_progress" },
        { content: "Pass through review",           status: "pending"     },
      ],
      agent: "cursor",
    },
  ],
};

// ---- Active processes -------------------------------------------------

export const activeProcesses: ActiveProcess[] = [
  {
    pid: 41_822,
    name: "claude",
    cwd: repoPath("northstar-web"),
    runtimeSec: 18 * MIN + 12,
    memoryKb: 480_000,
  },
  {
    pid: 41_901,
    name: "codex",
    cwd: repoPath("atlas-api"),
    runtimeSec: 4 * MIN + 33,
    memoryKb: 312_000,
  },
  {
    pid: 42_104,
    name: "cursor",
    cwd: repoPath("compass-docs"),
    runtimeSec: 11 * MIN + 47,
    memoryKb: 392_000,
  },
];

export const liveContexts: LiveContext[] = [
  {
    agent: "claude",
    sessionId: "sess-live-1",
    pid: 41_822,
    name: "fixtures-wiring",
    cwd: repoPath("northstar-web"),
    model: "claude-opus-5-5",
    usedTokens: 412_300,
    windowTokens: 1_000_000,
    usedPercent: 41.23,
    status: "busy",
    lastTs: (NOW - 4) * 1000,
  },
  {
    agent: "codex",
    sessionId: "sess-live-2",
    pid: 41_901,
    name: "Fix auth token race",
    cwd: repoPath("atlas-api"),
    model: "gpt-5.5-codex",
    usedTokens: 198_400,
    windowTokens: 258_400,
    usedPercent: 76.78,
    status: null,
    lastTs: (NOW - 56) * 1000,
  },
  {
    agent: "cursor",
    sessionId: "sess-live-3",
    pid: 42_104,
    name: "Rewrite quickstart hero",
    cwd: repoPath("compass-docs"),
    model: null,
    usedTokens: null,
    windowTokens: null,
    usedPercent: 23,
    status: null,
    lastTs: (NOW - 22) * 1000,
  },
];

export const terminalIntegrations: TerminalIntegrations = {
  claude: {
    available: true,
    installed: false,
    stalePath: false,
    otherCommand: null,
    chainedCommand: null,
    blockedReason: null,
    settingsPath: "~/.claude/settings.json",
  },
  codex: {
    available: true,
    installed: false,
    currentItems: [],
    configPath: "~/.codex/config.toml",
  },
};

/**
 * Browser-mode stand-in for `statusline::preview` — same layout rules over
 * fixed sample values, so the Settings editor stays live without Tauri.
 */
export function previewStatusline(prefs: StatuslinePrefs): StatuslineSpan[] {
  const out: StatuslineSpan[] = [];
  const tone = (p: number) =>
    p >= prefs.dangerPercent ? "danger" : p >= prefs.warnPercent ? "warn" : "ok";
  const sep = { bar: " │ ", dot: " · ", pipe: " | ", space: "   " }[prefs.separator];
  const limit = (label: string, pct: number, reset: string): StatuslineSpan[] => {
    const spans: StatuslineSpan[] = [
      { text: `${label} `, tone: "dim" },
      { text: `${pct}%`, tone: tone(pct) },
    ];
    const show =
      prefs.resetHint === "always" ||
      (prefs.resetHint === "nearLimit" && pct >= prefs.warnPercent);
    if (show) spans.push({ text: ` ↻${reset}`, tone: "dim" });
    return spans;
  };
  const pieces: Record<string, StatuslineSpan[]> = {
    context: [
      { text: "ctx ", tone: "dim" },
      ...(prefs.contextBar ? [{ text: "▓▓▓░░░░░░░ ", tone: tone(34) } as StatuslineSpan] : []),
      { text: "34%", tone: tone(34) },
      ...(prefs.contextTokens ? [{ text: " 340K/1M", tone: "dim" } as StatuslineSpan] : []),
    ],
    fiveHour: limit("5h", 41, "2h"),
    weekly: limit("wk", 28, "4d"),
    modelLimits: limit("Fable", 63, "4d"),
    sessionCost: [{ text: "$1.20", tone: "plain" }],
    todayCost: [
      { text: "$4.21", tone: "plain" },
      { text: " today", tone: "dim" },
    ],
    model: [{ text: "Opus 5.5", tone: "plain" }],
    folder: [{ text: "northstar-web", tone: "plain" }],
    branch: [
      { text: "⎇ ", tone: "dim" },
      { text: "main", tone: "plain" },
    ],
  };
  prefs.segments
    .filter((s) => s.enabled)
    .forEach((s, i) => {
      if (i > 0) out.push({ text: sep, tone: "dim" });
      out.push(...pieces[s.id]);
    });
  return out;
}

// ---- Dashboard --------------------------------------------------------

export const dashboardSummary: DashboardSummary = {
  totalRepos: REPOS.length,
  activeSessions: activeProcesses.length,
  totalCostUsd: costs.totalUsd,
  uncommittedRepos: REPOS.filter((r) => r.dirty).length,
  activity30d: thirtyDayActivity(0).map((v, i) => v + (i > 22 ? 3 : 0)),
};

// ---- Setup / config inventory ----------------------------------------

export const claudeMd: ClaudeMdEntry[] = [
  {
    repoName: null,
    repoPath: null,
    path: `${HOME}/.claude/CLAUDE.md`,
    bytes: 4_212,
    words: 612,
    estimatedTokens: 980,
    scope: "global",
    lines: 84,
    topics: ["Conventions", "Tooling", "Style"],
    body: "# Personal CLAUDE.md\n\n## Conventions\n…",
    kind: "claude-md",
    description: null,
    modifiedMs: (NOW - 3 * 24 * HOUR) * 1000,
  },
  ...REPOS.slice(0, 5).map((r) => ({
    repoName: r.name,
    repoPath: repoPath(r.name),
    path: `${repoPath(r.name)}/CLAUDE.md`,
    bytes: 1_800 + r.name.length * 30,
    words: 280,
    estimatedTokens: 420,
    scope: "repo" as const,
    lines: 48,
    topics: ["Architecture", "Commands", "Gotchas"],
    body: `# ${r.name}\n\n## Architecture\n…`,
    kind: "claude-md" as const,
    description: null,
    modifiedMs: (NOW - (r.name.length % 9) * 24 * HOUR) * 1000,
  })),
  {
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    path: `${HOME}/.claude/projects/-Users-timothy-Code-${REPOS[0].name}/memory/tray.md`,
    bytes: 920,
    words: 140,
    estimatedTokens: 230,
    scope: "repo",
    lines: 12,
    topics: [],
    body: "---\nname: tray\ndescription: Notes about the tray window\n---\n\nThe tray popover is a non-activating panel.\n",
    kind: "memory",
    description: "Notes about the tray window",
    modifiedMs: (NOW - 2 * HOUR) * 1000,
  },
];

export const skills: ConfigArtifact[] = [
  {
    name: "release",
    description: "Build, sign, and publish a release bundle.",
    model: null,
    tools: "Bash, Read, Edit",
    repoName: null,
    repoPath: null,
    path: `${HOME}/.claude/skills/release/SKILL.md`,
    scope: "global",
  },
  {
    name: "review",
    description: "Review a pull request.",
    model: null,
    tools: null,
    repoName: null,
    repoPath: null,
    path: `${HOME}/.claude/skills/review/SKILL.md`,
    scope: "global",
  },
  {
    name: "init",
    description: "Initialize a new CLAUDE.md.",
    model: null,
    tools: null,
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    path: `${repoPath(REPOS[0].name)}/.claude/skills/init/SKILL.md`,
    scope: "repo",
  },
  {
    name: "frontend-design",
    description: "Guidance for building polished interfaces.",
    model: null,
    tools: null,
    repoName: "frontend-design",
    repoPath: null,
    path: `${HOME}/.claude/plugins/cache/claude-plugins-official/frontend-design/1.0.0/skills/frontend-design/SKILL.md`,
    scope: "plugin",
  },
];

export const agents: ConfigArtifact[] = [
  {
    name: "code-reviewer",
    description: "Independent second-opinion code review.",
    model: "claude-opus-4-8",
    tools: "Read, Grep, Bash",
    repoName: null,
    repoPath: null,
    path: `${HOME}/.claude/agents/code-reviewer.md`,
    scope: "global",
  },
  {
    name: "explore",
    description: "Fast read-only search agent.",
    model: "claude-haiku-4-5",
    tools: "Read, Grep, Glob",
    repoName: null,
    repoPath: null,
    path: `${HOME}/.claude/agents/explore.md`,
    scope: "global",
  },
];

export const hooks: HookEntry[] = [
  {
    event: "PostToolUse",
    matcher: "Edit|Write",
    command: "npm run typecheck --silent",
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    scope: "repo",
    sourcePath: `${repoPath(REPOS[0].name)}/.claude/settings.json`,
  },
  {
    event: "Stop",
    matcher: null,
    command: "say done",
    repoName: null,
    repoPath: null,
    scope: "global",
    sourcePath: `${HOME}/.claude/settings.json`,
  },
];

export const hygiene: HygieneIssue[] = [
  {
    repoName: REPOS[3].name,
    repoPath: repoPath(REPOS[3].name),
    kind: "missing-claude-md",
    message: "No CLAUDE.md — agent context is reduced.",
    severity: "warn",
    command: "lunopeak claude-md create",
    target: null,
    details: null,
  },
  {
    repoName: REPOS[1].name,
    repoPath: repoPath(REPOS[1].name),
    kind: "stale-branch",
    message: "feat/auth-2 hasn't been pushed in 6 days.",
    severity: "info",
    command: null,
    target: "feat/auth-2",
    details: null,
  },
  {
    repoName: null,
    repoPath: null,
    kind: "background-listener",
    message: "Stale Vite dev server on :5173.",
    severity: "warn",
    command: "kill 41822",
    target: "41822",
    details: repoPath("northstar-web"),
  },
];

export const setupRepos: RepoSetup[] = REPOS.map((r, i) => ({
  repoName: r.name,
  repoPath: repoPath(r.name),
  hasClaudeMd: i % 4 !== 3,
  hasClaudeDir: i % 2 === 0,
  hasSkills: i < 3,
  hasAgents: i === 0,
  hasHooks: i === 0 || i === 2,
  completeness: 0.4 + (i % 5) * 0.12,
  hasAgentsMd: i % 3 === 0,
  hasCursorRules: i % 3 === 1,
  hasMcp: i < 2,
}));

export const setupOverview: SetupOverview = {
  claude: {
    path: `${HOME}/.claude/settings.json`,
    model: "opus",
    permissionMode: "default",
  },
  codex: {
    path: `${HOME}/.codex/config.toml`,
    model: "gpt-5-codex",
    reasoningEffort: "medium",
    approvalPolicy: "on-request",
  },
  cursor: {
    path: `${HOME}/.cursor`,
    projectCount: 4,
    ruleCount: 7,
  },
  mcpServers: [
    { name: "filesystem", scope: "global", projectPath: null,
      command: "npx", argsSummary: "@modelcontextprotocol/server-filesystem ~/Code" },
    { name: "github",     scope: "global", projectPath: null,
      command: "uvx", argsSummary: "mcp-server-github" },
    { name: "github",     scope: "cursor", projectPath: null,
      command: "uvx", argsSummary: "mcp-server-github" },
    { name: "linear",     scope: "codex", projectPath: null,
      command: "npx", argsSummary: "-y mcp-remote https://mcp.linear.app/sse" },
    { name: "playwright", scope: "project", projectPath: repoPath("northstar-web"),
      command: "npx", argsSummary: "@executeautomation/playwright-mcp-server" },
  ],
  plugins: [
    { name: "commit-commands", marketplace: "anthropic-builtin", version: "0.4.1", enabled: true },
    { name: "ralph-loop",      marketplace: "community",         version: "1.2.0", enabled: true },
    { name: "figma",           marketplace: "anthropic-builtin", version: "0.6.0", enabled: false },
  ],
  repos: setupRepos,
};

// ---- Misc per-repo lists ---------------------------------------------

export const listeningPorts: ListeningPort[] = [
  { pid: 41_822, port: 5_173, address: "127.0.0.1", process: "node",  cwd: repoPath("northstar-web") },
  { pid: 42_104, port: 4_321, address: "127.0.0.1", process: "node",  cwd: repoPath("compass-docs")  },
  { pid: 41_901, port: 8_080, address: "0.0.0.0",   process: "atlas", cwd: repoPath("atlas-api")     },
];

export const diffs: DiffStat[] = REPOS.filter((r) => r.dirty).map((r) => ({
  repoName: r.name,
  repoPath: repoPath(r.name),
  branch: r.branch,
  filesChanged: 4,
  insertions: 96,
  deletions: 24,
  files: ["src/lib/tauri.ts", "src/views/costs/CostsView.tsx", "README.md", "package.json"],
}));

const DIRTY_SAMPLE: DirtyFile[] = [
  { path: "src/lib/tauri.ts", staged: " ", unstaged: "M" },
  { path: "src/views/repos/ReposView.tsx", staged: "M", unstaged: " " },
  { path: "src/views/repos/RepoDirtyFiles.tsx", staged: "?", unstaged: "?" },
  { path: "README.md", staged: " ", unstaged: "M" },
  { path: "package.json", staged: "M", unstaged: "M" },
];

export const repoDirtyFiles = (path: string): DirtyFile[] => {
  const overview = reposOverview.repos.find((r) => r.path === path);
  if (!overview?.hasUncommitted) return [];
  const n = Math.max(1, overview.uncommittedFiles || DIRTY_SAMPLE.length);
  return DIRTY_SAMPLE.slice(0, Math.min(n, DIRTY_SAMPLE.length));
};

const STASH_SUBJECTS = [
  "WIP on main: half-finished refactor",
  "On feature/auth: debugging session",
  "WIP on main: experimental layout",
];

export const repoStashes = (path: string): RepoStash[] => {
  const overview = reposOverview.repos.find((r) => r.path === path);
  const count = overview?.stashCount ?? 0;
  return Array.from({ length: count }, (_, i) => ({
    reflog: `stash@{${i}}`,
    subject: STASH_SUBJECTS[i % STASH_SUBJECTS.length],
    files: DIRTY_SAMPLE.slice(0, ((i + 1) % DIRTY_SAMPLE.length) + 1).map(
      (f) => f.path,
    ),
  }));
};

const SAMPLE_PATCH = `@@ -40,5 +40,7 @@ export async function handleCallback(req: Request) {
   const session = await loadSession(req);
-  if (!session) return redirect("/login");
+  const returnTo = req.session.returnTo ?? "/home";
+  if (!session) return redirect(\`/login?next=\${returnTo}\`);
   await touch(session);
-  return redirect("/home");
+  return redirect(safePath(returnTo));
 }
`;

export const repoFileDiffs = (path: string): FileDiff[] =>
  repoDirtyFiles(path).map((f, i) => {
    const isNew = f.staged === "?" || f.staged === "A";
    return {
      path: f.path,
      insertions: isNew ? 3 : 4,
      deletions: isNew ? 0 : 2,
      isNew,
      isDeleted: false,
      binary: false,
      patch: isNew
        ? "@@ -0,0 +1,3 @@\n+export function demo() {\n+  return " + i + ";\n+}\n"
        : SAMPLE_PATCH,
      truncated: false,
    };
  });

export const repoBranches = (path: string): BranchInfo[] => {
  const overview = reposOverview.repos.find((r) => r.path === path);
  const current = overview?.branch ?? "main";
  const branches: BranchInfo[] = [
    { name: "main", isCurrent: current === "main", isDefault: true, lastCommitTs: (NOW - 2 * HOUR) * 1000, ahead: 0, behind: 0, merged: false },
  ];
  if (current !== "main") {
    branches.unshift({ name: current, isCurrent: true, isDefault: false, lastCommitTs: (NOW - 3 * HOUR) * 1000, ahead: 5, behind: 2, merged: false });
  }
  branches.push(
    { name: "chore/old-tray", isCurrent: false, isDefault: false, lastCommitTs: (NOW - 18 * DAY) * 1000, ahead: 0, behind: 14, merged: true },
    { name: "spike/charts", isCurrent: false, isDefault: false, lastCommitTs: (NOW - 12 * DAY) * 1000, ahead: 3, behind: 9, merged: false },
  );
  return branches;
};

export const timeline: TimelineEvent[] = [
  { kind: "session", ts: NOW - 30 * MIN, id: "sess-1", title: SESSION_PROMPTS[0], project: REPOS[0].name, model: "claude-opus-5", costUsd: 0.28, messageCount: 22 },
  { kind: "commit",  ts: NOW -  2 * HOUR, repo: REPOS[0].name, sha: "a1ef98a", author: "timothy", subject: COMMIT_SUBJECTS[0] },
  { kind: "session", ts: NOW -  4 * HOUR, id: "sess-2", title: SESSION_PROMPTS[1], project: REPOS[1].name, model: "gpt-5-codex",      costUsd: 0.31, messageCount: 14 },
  { kind: "commit",  ts: NOW -  6 * HOUR, repo: REPOS[2].name, sha: "7c0c898", author: "timothy", subject: COMMIT_SUBJECTS[2] },
  { kind: "session", ts: NOW -  9 * HOUR, id: "sess-3", title: SESSION_PROMPTS[2], project: REPOS[3].name, model: "claude-sonnet-5", costUsd: 0.62, messageCount: 31 },
];

export const repoActivity: RepoActivity[] = REPOS.map((r, i) => {
  const days = thirtyDayActivity(i);
  // Demo split: pretend 2/3 of commits are mine, drift across repos.
  const mineCommits = Math.max(0, Math.round((24 - i) * (i % 3 === 0 ? 0.4 : 0.7)));
  const mineDays = days.map((v) => Math.round(v * (i % 3 === 0 ? 0.4 : 0.7)));
  return {
    repoName: r.name,
    repoPath: repoPath(r.name),
    days,
    totalSessions: 18 - i,
    totalCommits: 24 - i,
    mineDays,
    mineCommits,
  };
});

// ---- Pull Requests ---------------------------------------------------

const PR_FIXTURES: ReadonlyArray<{
  repoIdx: number;
  number: number;
  title: string;
  author: string;
  headRef: string;
  isDraft?: boolean;
  hoursAgo: number;
}> = [
  { repoIdx: 0, number: 412, title: "Share dashboard header with cost breakdown view", author: "timothy",  headRef: "feat/shared-header", hoursAgo: 0.5 },
  { repoIdx: 1, number: 198, title: "Refresh auth-2 PKCE flow before token expiry",     author: "timothy",  headRef: "feat/auth-2",        hoursAgo: 4 },
  { repoIdx: 1, number: 196, title: "Bump Codex provider window to 5 minutes",            author: "casey",    headRef: "tune/codex-window",  hoursAgo: 28 },
  { repoIdx: 3, number: 87,  title: "Stricter parser for pyproject extras",               author: "timothy",  headRef: "fix/parser",         hoursAgo: 6, isDraft: true },
  { repoIdx: 5, number: 41,  title: "Document v3 migration paths",                        author: "rina",     headRef: "draft/v3",           hoursAgo: 50 },
  { repoIdx: 7, number: 12,  title: "DuckDB window-function spike",                        author: "timothy",  headRef: "spike/duckdb",       hoursAgo: 70, isDraft: true },
];

export const pullRequests: PullRequestList = {
  status: { installed: true, authenticated: true, user: "timothy", message: null },
  githubRepoCount: 6,
  prs: PR_FIXTURES.map((pr) => {
    const repo = REPOS[pr.repoIdx];
    return {
      number: pr.number,
      title: pr.title,
      url: `https://github.com/luno-labs/${repo.name}/pull/${pr.number}`,
      author: pr.author,
      headRef: pr.headRef,
      isDraft: Boolean(pr.isDraft),
      reviewDecision: pr.isDraft ? null : (["REVIEW_REQUIRED", "APPROVED", "CHANGES_REQUESTED"] as const)[pr.number % 3],
      updatedAtMs: (NOW - Math.round(pr.hoursAgo * HOUR)) * 1000,
      repoName: repo.name,
      repoPath: repoPath(repo.name),
      owner: "luno-labs",
      repo: repo.name,
    };
  }),
};

// ---- Tools -----------------------------------------------------------

export const toolStats: ToolStats = {
  totalCalls: 4_812,
  totalErrors: 87,
  totalFilesTouched: 312,
  avgCallsPerSession: 33.9,
  errorRatePct: 1.8,
  vsLastWeekPct: 12,
  projects: REPOS.slice(0, 6).map((r) => r.name),
  byDay: Array.from({ length: 30 }, (_, i) => {
    const date = new Date((NOW - (29 - i) * DAY) * 1000);
    const isoDate = date.toISOString().slice(0, 10);
    return { date: isoDate, calls: 80 + ((i * 13) % 90) };
  }),
  byTool: [
    { name: "Read",   calls: 1_412, errors:  6 },
    { name: "Edit",   calls:   864, errors: 18 },
    { name: "Bash",   calls:   702, errors: 41 },
    { name: "Grep",   calls:   598, errors:  2 },
    { name: "Write",  calls:   312, errors:  4 },
    { name: "WebFetch", calls:  186, errors:  9 },
  ],
  sequences: [
    { from: "Read",  to: "Edit", count: 412 },
    { from: "Edit",  to: "Bash", count: 308 },
    { from: "Bash",  to: "Read", count: 264 },
    { from: "Grep",  to: "Read", count: 198 },
  ],
  errorProne: [
    { tool: "Bash", errors: 41, errorPct: 5.8 },
    { tool: "WebFetch", errors: 9, errorPct: 4.8 },
    { tool: "Edit", errors: 18, errorPct: 2.1 },
  ],
  topFiles: [
    { path: `${repoPath("northstar-web")}/src/lib/tauri.ts`, repo: "northstar-web", count: 38 },
    { path: `${repoPath("atlas-api")}/src/handlers/auth.rs`, repo: "atlas-api",     count: 31 },
    { path: `${repoPath("northstar-web")}/CLAUDE.md`,        repo: "northstar-web", count: 22 },
    { path: `${repoPath("compass-docs")}/content/intro.md`,  repo: "compass-docs",  count: 19 },
  ],
  topCommands: [
    { command: "npm run typecheck", count: 142 },
    { command: "git status",        count: 118 },
    { command: "npm run dev",       count:  76 },
    { command: "cargo check",       count:  44 },
  ],
};

// ---- Deps / worktrees / env / lint -----------------------------------

export const deps: DepEntry[] = [
  {
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    manager: "npm",
    manifest: "package.json",
    prod: 18,
    dev: 12,
    examples: ["react", "@tanstack/react-query", "tailwindcss"],
  },
  {
    repoName: REPOS[1].name,
    repoPath: repoPath(REPOS[1].name),
    manager: "cargo",
    manifest: "Cargo.toml",
    prod: 24,
    dev: 6,
    examples: ["axum", "tokio", "serde"],
  },
];

export const worktrees: WorktreeEntry[] = [
  {
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    worktreePath: repoPath(REPOS[0].name),
    branch: REPOS[0].branch,
    head: "a1ef98a",
    locked: false,
    prunable: false,
    isMain: true,
  },
  {
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    worktreePath: `${CODE}/${REPOS[0].name}-spike`,
    branch: "spike/router",
    head: "9b3c014",
    locked: false,
    prunable: false,
    isMain: false,
  },
  {
    repoName: REPOS[1].name,
    repoPath: repoPath(REPOS[1].name),
    worktreePath: repoPath(REPOS[1].name),
    branch: REPOS[1].branch,
    head: "0b1c2d3",
    locked: false,
    prunable: false,
    isMain: true,
  },
  {
    repoName: REPOS[1].name,
    repoPath: repoPath(REPOS[1].name),
    worktreePath: `${CODE}/${REPOS[1].name}-limits`,
    branch: "feat/limits",
    head: "7e8f9a0",
    locked: true,
    prunable: false,
    isMain: false,
  },
  {
    repoName: REPOS[1].name,
    repoPath: repoPath(REPOS[1].name),
    worktreePath: `/tmp/${REPOS[1].name}-hotfix`,
    branch: "hotfix/login",
    head: "4d5e6f7",
    locked: false,
    prunable: true,
    isMain: false,
  },
];

export const envFiles: EnvFile[] = [
  {
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    fileName: ".env.local",
    keys: ["VITE_API_URL", "VITE_PUBLIC_KEY", "VITE_FEATURE_X"],
    gitignored: true,
    committedRisk: false,
    repoHasExample: true,
  },
  {
    repoName: REPOS[1].name,
    repoPath: repoPath(REPOS[1].name),
    fileName: ".env",
    keys: ["DATABASE_URL", "JWT_SECRET", "REDIS_URL"],
    gitignored: false,
    committedRisk: true,
    repoHasExample: false,
  },
];

export const claudeMdLintReports: ClaudeMdLintReport[] = [
  {
    repoName: REPOS[0].name,
    repoPath: repoPath(REPOS[0].name),
    path: `${repoPath(REPOS[0].name)}/CLAUDE.md`,
    bytes: 6_400,
    lines: 142,
    body: "# northstar-web\n\n## Architecture\n…",
    issues: [{ kind: "too-long", message: "File exceeds the 5KB soft cap." }],
  },
];

// ---- Snapshots --------------------------------------------------------

export const snapshots: Snapshot[] = [
  {
    id: "snap-1",
    name: "Pre-refactor",
    note: "Saved before the cost view rewrite.",
    createdTs: (NOW - 2 * DAY) * 1000,
    repos: REPOS.slice(0, 4).map((r) => ({
      repoName: r.name,
      repoPath: repoPath(r.name),
      branch: r.branch,
      head: "a1ef98a",
      dirty: r.dirty,
      diffFiles: r.dirty ? ["src/lib/tauri.ts", "src/views/costs/CostsView.tsx"] : [],
      insertions: r.dirty ? 64 : 0,
      deletions:  r.dirty ? 12 : 0,
    })),
  },
];

// ---- Usage limits ----------------------------------------------------

export const usageLimits: UsageLimits = {
  providers: [
    {
      provider: "claude",
      plan: "max",
      fiveHour: {
        usedPercent: 41,
        tokens: 1_240_000,
        costUsd: 8.42,
        messageCount: 96,
        resetsAt: NOW + 2 * HOUR + 18 * MIN,
        windowSeconds: 5 * HOUR,
      },
      weekly: {
        usedPercent: 28,
        tokens: 18_400_000,
        costUsd: 142.10,
        messageCount: 1_812,
        resetsAt: NOW + 4 * DAY,
        windowSeconds: 7 * DAY,
      },
      modelLimits: [
        {
          model: "Fable",
          window: {
            usedPercent: 63,
            tokens: 4_600_000,
            costUsd: 63.10,
            messageCount: 212,
            resetsAt: NOW + 4 * DAY,
            windowSeconds: 7 * DAY,
          },
          isActive: false,
        },
      ],
    },
    {
      provider: "codex",
      plan: "plus",
      fiveHour: {
        usedPercent: 17,
        tokens: 240_000,
        costUsd: 0.0,
        messageCount: 24,
        resetsAt: NOW + 3 * HOUR + 4 * MIN,
        windowSeconds: 5 * HOUR,
      },
      weekly: {
        usedPercent: 22,
        tokens: 3_100_000,
        costUsd: 0.0,
        messageCount: 318,
        resetsAt: NOW + 5 * DAY,
        windowSeconds: 7 * DAY,
      },
    },
    {
      // Cursor doesn't expose 5h/weekly windows — `fiveHour.usedPercent`
      // carries the highest active composer's contextUsagePercent, and
      // `UsageLimitsCard` relabels the bar "Active context" + hides weekly.
      provider: "cursor",
      plan: "pro",
      fiveHour: {
        usedPercent: 64,
        tokens: 0,
        costUsd: 0.0,
        messageCount: 12,
        resetsAt: null,
        windowSeconds: 0,
      },
      weekly: {
        usedPercent: null,
        tokens: 0,
        costUsd: 0.0,
        messageCount: 0,
        resetsAt: null,
        windowSeconds: 0,
      },
    },
  ],
};

// ---- Settings & repo detail -------------------------------------------

export const settingsFixture: Settings = {
  scanDirs: [CODE, `${HOME}/Work`],
  // Demo placeholder — opaque key so AssistantView renders the chat UI
  // (the gate just checks for non-null; calls never fire in demo mode).
  apiKeys: { anthropic: "sk-ant-demo-key-screenshots", openai: null, gemini: null, xai: null },
  defaultModel: "claude-opus-4-8",
  theme: "system",
  telemetry: false,
  provider: "anthropic",
  ollamaEndpoint: "http://localhost:11434",
  firstRun: false,
  general: {
    launchAtLogin: true,
    checkUpdates: true,
    autoInstallUpdates: false,
    updatePromptSeen: true,
    showScrollbars: false,
  },
  costBudget: { dailyUsd: 25, monthlyUsd: 400, alertThresholdPct: 80 },
  usageAlerts: { enabled: true, thresholdPct: 80 },
  agents: {
    claudeCode: true,
    codex: true,
    cursor: true,
    cursorWeb: false,
    initialized: true,
  },
  hiddenSidebarItems: [],
  sidebarOrder: [],
  sidebar: { planUsage: "always", foldedSections: ["setup", "backups"] },
  setupComplete: true,
  tray: {
    enabled: true,
    closeToTray: true,
    pinnedProvider: "auto",
    headlineWindow: "5h",
    titleStyle: "percent",
  },
  editor: { defaultEditor: "vscode" },
  statusline: defaultStatuslinePrefs,
};

export const repoDetail = (path: string): RepoDetail | null => {
  const overview = reposOverview.repos.find((r) => r.path === path);
  if (!overview) return null;
  return {
    entry: overview,
    claudeMd: `# ${overview.name}\n\nLocal-first dev tool. See README for setup.\n`,
    skills: skills.filter((s) => s.repoPath === overview.path),
  };
};

// ---- Assistant conversations -----------------------------------------
//
// Pre-seeded chats that fill the conversations rail in demo mode so the
// Assistant page has history to screenshot. Mix tool-use chats, plain
// markdown answers, and a multi-tool chat to show the breadth of UI
// elements (tool-call rows, result rows, markdown bullet lists, code
// blocks). Stable ids + relative timestamps so screenshots reproduce.

const MS = 1000;
const NOW_MS = NOW * MS;

export const demoConversations: Conversation[] = [
  {
    id: "demo-conv-1",
    title: "Which repo did I spend the most on this month?",
    createdAt: NOW_MS - 5 * 60 * MS,
    updatedAt: NOW_MS - 4 * 60 * MS,
    messages: [
      {
        role: "user",
        content: "Which repo did I spend the most on this month?",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Pulling the cost breakdown for you." },
          {
            type: "tool_use",
            id: "toolu_01_costs",
            name: "cost_breakdown",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_01_costs",
            content: JSON.stringify(
              {
                totalUsd: 334.90,
                byRepo: costs.byRepo.slice(0, 5),
              },
              null,
              2,
            ),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "**northstar-web** was your top spender at **$88.00** across 32 sessions — about 26% of your $335 month-to-date.\n\nTop three:\n\n1. `northstar-web` — $88.00 (32 sessions)\n2. `atlas-api` — $75.70 (28 sessions)\n3. `harbor-mobile` — $63.40 (24 sessions)\n\nThose three together account for roughly two-thirds of this month's spend.",
          },
        ],
      },
    ],
  },
  {
    id: "demo-conv-2",
    title: "Where am I burning time on errors?",
    createdAt: NOW_MS - 30 * 60 * MS,
    updatedAt: NOW_MS - 28 * 60 * MS,
    messages: [
      { role: "user", content: "Where am I burning time on errors?" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Checking tool error rates across your sessions.",
          },
          {
            type: "tool_use",
            id: "toolu_02_tools",
            name: "tool_usage",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_02_tools",
            content: JSON.stringify(
              {
                totalCalls: 4_812,
                totalErrors: 87,
                errorRatePct: 1.8,
                errorProne: toolStats.errorProne,
                byTool: toolStats.byTool,
              },
              null,
              2,
            ),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Your overall error rate is healthy — **1.8%** across 4.8k tool calls — but a couple of tools skew high:\n\n- **Bash** — 41 errors out of 702 calls (5.8%)\n- **WebFetch** — 9 / 186 (4.8%)\n- **Edit** — 18 / 864 (2.1%)\n\nBash is the one I'd look at first. The pattern usually points at brittle commands (missing args, paths that don't exist) rather than environment issues. Want me to pull the most common Bash error messages so we can group them?",
          },
        ],
      },
    ],
  },
  {
    id: "demo-conv-3",
    title: "What did I work on yesterday?",
    createdAt: NOW_MS - 2 * 60 * 60 * MS - 30 * 60 * MS,
    updatedAt: NOW_MS - 2 * 60 * 60 * MS - 12 * 60 * MS,
    messages: [
      { role: "user", content: "What did I work on yesterday?" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Let me grab your recent sessions and find yesterday's.",
          },
          {
            type: "tool_use",
            id: "toolu_03_sessions",
            name: "recent_sessions",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_03_sessions",
            content: JSON.stringify(
              sessions.slice(0, 6).map((s) => ({
                projectName: s.projectName,
                model: s.model,
                messageCount: s.messageCount,
                costUsd: Number(s.costUsd.toFixed(2)),
                firstPrompt: s.firstPrompt,
                startTs: s.startTs,
              })),
              null,
              2,
            ),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Yesterday you ran **four** sessions across three repos:\n\n- **northstar-web** — refactoring the cost-breakdown view to share its header with the dashboard. ~22 messages, $0.84 with Opus.\n- **atlas-api** — debugging why the tray icon flashes on Linux. Short follow-up under Codex, ~14 messages.\n- **harbor-mobile** — added a *copy as JSON* button to the session detail toolbar. Quick Sonnet pass.\n- **lighthouse-cli** — looking for TODOs older than 6 months grouped by repo.\n\nThe northstar-web session was the longest. Do you want a one-line recap of each, or just expand on that one?",
          },
        ],
      },
    ],
  },
  {
    id: "demo-conv-4",
    title: "Any hygiene issues I should clean up?",
    createdAt: NOW_MS - 22 * 60 * 60 * MS,
    updatedAt: NOW_MS - 21 * 60 * 60 * MS - 50 * 60 * MS,
    messages: [
      { role: "user", content: "Any hygiene issues I should clean up?" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Scanning across your tracked repos.",
          },
          {
            type: "tool_use",
            id: "toolu_04_hygiene",
            name: "hygiene_issues",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_04_hygiene",
            content: JSON.stringify(hygiene, null, 2),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Three things stand out — one worth fixing today, two FYIs:\n\n1. **`lighthouse-cli` is missing a CLAUDE.md.** Your other repos all have one, and agents that work in this repo are running with reduced context. The Hygiene view has a one-click *add stub* button.\n2. **Stale Vite dev server on port 5173** in `northstar-web` (PID 41822). Looks like a leftover from a previous session — safe to kill.\n3. `atlas-api`'s `feat/auth-2` branch hasn't been pushed in 6 days. Just an FYI in case you want to rebase or open a PR.\n\nWant me to draft the CLAUDE.md for lighthouse-cli?",
          },
        ],
      },
    ],
  },
  {
    id: "demo-conv-5",
    title: "Structuring CLAUDE.md for Tauri + Rust",
    createdAt: NOW_MS - 3 * 24 * 60 * 60 * MS,
    updatedAt: NOW_MS - 3 * 24 * 60 * 60 * MS + 4 * 60 * MS,
    messages: [
      {
        role: "user",
        content:
          "How should I structure a CLAUDE.md for a Tauri + Rust + React project? Want it short but useful.",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Three sections cover most of what an agent needs, in this order:\n\n## 1. Commands\nThe handful you actually run — agents lean on these instead of guessing. Include what each does and any first-time gotchas (e.g. \"first Rust compile takes minutes\").\n\n```\nnpm run dev          # Vite-only — UI runs in a browser tab\nnpm run tauri:dev    # full app (slow first run)\nnpm run typecheck    # tsc -b --noEmit\nnpm run tauri:build  # bundles to src-tauri/target/release/bundle/\n```\n\n## 2. Architecture\nHigh-signal pointers, not a full tour. Two or three sentences each:\n\n- **IPC boundary:** where Rust commands are exposed and how the TS side calls them.\n- **Serde contract:** any `rename_all` rules, plus where the TS mirrors live.\n- **Routing source of truth:** the file an agent should add a new view to.\n\n## 3. Gotchas\nThings that will bite an unfamiliar agent. A few examples that translate well to Tauri projects:\n\n- New IPC commands must be added to `capabilities/default.json` or they fail at runtime.\n- App icons are not committed — `tauri:build` needs them generated first.\n- The frontend must keep working in plain browser mode, so any new `api.*` call needs a fallback.\n\nKeep it under ~5KB. If it grows past that, break per-area details out into nested `CLAUDE.md` files in the relevant subdirectories — Claude picks them up automatically.",
          },
        ],
      },
    ],
  },
];

/** Conversation that's selected by default when the demo seed is applied. */
export const demoCurrentConversationId = demoConversations[0].id;
