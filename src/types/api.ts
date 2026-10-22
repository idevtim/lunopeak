// Frontend mirror of Rust models in src-tauri/src/models.rs

export interface Repo {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  hasClaudeMd: boolean;
  hasUncommitted: boolean;
  lastActivityTs: number | null;
  sizeKb: number | null;
}

export type AssistantProvider = "anthropic" | "openai" | "gemini" | "xai" | "ollama";

export interface GeneralPrefs {
  launchAtLogin: boolean;
  checkUpdates: boolean;
  /** Download + install the next available update without showing a banner. */
  autoInstallUpdates: boolean;
  /** True after the user has dismissed the first-run update prompt. */
  updatePromptSeen: boolean;
  /**
   * When false (default), scrollbars are fully invisible across the app.
   * When true, a thin always-visible thumb is rendered.
   */
  showScrollbars: boolean;
}

export interface CostBudget {
  dailyUsd: number;
  monthlyUsd: number;
  /** Percent (0–100). 80 means alert when spend hits 80% of the limit. */
  alertThresholdPct: number;
}

export interface UsageAlerts {
  enabled: boolean;
  /** Percent (0–100). 80 means alert when a provider's usage window reaches 80%. */
  thresholdPct: number;
}

export interface AgentSources {
  claudeCode: boolean;
  codex: boolean;
  cursor: boolean;
  /**
   * Opt-in: when true, LunoPeak reads the user's browser cookies to call
   * cursor.com/api/usage-summary and surface real plan utilization +
   * on-demand spend. Off by default because the one-time cookie read
   * triggers an OS Keychain prompt for Chromium-based browsers on macOS.
   */
  cursorWeb: boolean;
  /**
   * One-shot migration sentinel. The Rust loader flips it to true after
   * force-enabling all known agents on first encounter, so any legacy
   * settings.json with `codex: false` from older builds gets forward-fixed.
   */
  initialized: boolean;
}

/**
 * Filesystem probe — which agents the user actually has installed on this
 * machine. Distinct from `AgentSources` (which tracks Settings toggles).
 * Use this to genericize copy and to hide / soft-disable Claude-only
 * features for Codex- or Cursor-only users.
 */
export interface InstalledAgents {
  claudeCode: boolean;
  codex: boolean;
  cursor: boolean;
}

export type TrayPinnedProvider = "auto" | "claude" | "codex" | "cursor";

/**
 * `fable` is Claude's Fable-scoped weekly cap; providers without one fall
 * back to their all-models weekly window.
 */
export type TrayHeadlineWindow = "5h" | "weekly" | "fable";

/** Text beside the menu-bar owl: none, "42%", or "42% 5h". */
export type TrayTitleStyle = "off" | "percent" | "percentWindow";

export interface TrayPrefs {
  enabled: boolean;
  /** Closing the window hides it instead of quitting. */
  closeToTray: boolean;
  pinnedProvider: TrayPinnedProvider;
  /** Which usage window's percent shows next to the tray icon. */
  headlineWindow: TrayHeadlineWindow;
  titleStyle: TrayTitleStyle;
}

export interface EditorPrefs {
  /**
   * Editor id to default to when "Open" is invoked from a row.
   * `null` means "ask each time" — the UI shows a picker on first click
   * and remembers the choice here when the user opts in.
   */
  defaultEditor: string | null;
}

/** When the sidebar's Plan usage card shows. `close` = only at 70%+. */
export type SidebarPlanUsage = "always" | "close" | "off";

export interface SidebarPrefs {
  planUsage: SidebarPlanUsage;
  /** Section ids the user has folded. */
  foldedSections: string[];
}

export interface Settings {
  scanDirs: string[];
  apiKeys: {
    anthropic: string | null;
    openai: string | null;
    gemini: string | null;
    xai: string | null;
  };
  defaultModel: string;
  theme: "light" | "dark" | "system";
  telemetry: boolean;
  provider: AssistantProvider;
  /**
   * Base URL of the local Ollama daemon (e.g. `http://localhost:11434`).
   * Overridable for users running Ollama on a custom port or remote host.
   */
  ollamaEndpoint: string;
  /**
   * True only on the very first launch. The assistant probes for a local
   * Ollama daemon and auto-selects it when reachable, then writes
   * `firstRun: false` so subsequent launches don't reprobe.
   */
  firstRun: boolean;
  general: GeneralPrefs;
  costBudget: CostBudget;
  usageAlerts: UsageAlerts;
  agents: AgentSources;
  /** RouteIds the user has hidden from the sidebar. */
  hiddenSidebarItems: string[];
  /**
   * RouteIds in the user's preferred display order. The sidebar groups
   * by section, then sorts within each section by this list. Routes
   * absent from this array keep their default position.
   */
  sidebarOrder: string[];
  sidebar: SidebarPrefs;
  /** False until first-run setup finishes. Upgrades from older builds read true. */
  setupComplete: boolean;
  tray: TrayPrefs;
  editor: EditorPrefs;
  /** What the Claude Code terminal status line shows. */
  statusline: StatuslinePrefs;
}

export type StatuslineSegmentId =
  | "context"
  | "fiveHour"
  | "weekly"
  | "modelLimits"
  | "sessionCost"
  | "todayCost"
  | "model"
  | "folder"
  | "branch";

export interface StatuslineSegment {
  id: StatuslineSegmentId;
  enabled: boolean;
}

export interface StatuslinePrefs {
  /** Display order and on/off per segment. */
  segments: StatuslineSegment[];
  /** Draw a 10-cell bar before the context percentage. */
  contextBar: boolean;
  /** Show "340K/1M" after the context percentage. */
  contextTokens: boolean;
  color: boolean;
  /** Percent at which numbers turn yellow. */
  warnPercent: number;
  /** Percent at which numbers turn red. */
  dangerPercent: number;
  resetHint: "nearLimit" | "always" | "never";
  separator: "bar" | "dot" | "pipe" | "space";
}

export type StatuslineTone = "plain" | "dim" | "ok" | "warn" | "danger";

/** One styled run of status line text. */
export interface StatuslineSpan {
  text: string;
  tone: StatuslineTone;
}

export interface ScanProgress {
  scanned: number;
  total: number | null;
  currentPath: string | null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Total cache-write tokens (5m + 1h ephemeral writes). */
  cacheCreation: number;
  /** Subset of cacheCreation written to the 1h cache (billed higher). */
  cacheCreation1h: number;
}

export interface Session {
  id: string;
  projectPath: string | null;
  projectName: string | null;
  branch: string | null;
  model: string | null;
  startTs: number;
  endTs: number;
  messageCount: number;
  firstPrompt: string | null;
  usage: TokenUsage;
  /** Includes subagent spend; `subagentCostUsd` is that share. */
  costUsd: number;
  /** Subagent transcripts (`<id>/subagents/agent-*.jsonl`) rolled into this session. */
  subagentCount: number;
  subagentCostUsd: number;
  /** file_path → number of Edit/Write/NotebookEdit invocations. May be empty. */
  filesEdited?: Record<string, number>;
}

export interface ModelUsage {
  model: string;
  sessions: number;
  costUsd: number;
  tokens: number;
  /** Tokens served from the prompt cache. Not included in `tokens`. */
  cacheReadTokens: number;
  /**
   * USD saved by this model's discounted cache-read rate versus the standard
   * 0.1x rate for its tier. Zero unless the model carries such a discount —
   * today Fable 5.1, Mythos 5.1 and Opus 5.5 do.
   */
  cacheReadSavingsUsd: number;
}

export interface SessionStats {
  totalSessions: number;
  totalMessages: number;
  totalCostUsd: number;
  totalTokens: number;
  usage: TokenUsage;
  hourHistogram: number[];
  dayHistogram: number[];
  byModel: ModelUsage[];
}

export type SessionEventKind =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system";

export interface SessionEvent {
  ts: number;
  kind: SessionEventKind;
  text: string | null;
  toolName: string | null;
  toolSummary: string | null;
  toolResult: string | null;
  isError: boolean;
}

export interface SessionDetail {
  id: string;
  projectPath: string | null;
  projectName: string | null;
  branch: string | null;
  model: string | null;
  startTs: number;
  endTs: number;
  messageCount: number;
  /** Includes subagent spend; see `Session.subagentCostUsd`. */
  costUsd: number;
  subagentCount: number;
  subagentCostUsd: number;
  usage: TokenUsage;
  firstPrompt: string | null;
  filesModified: string[];
  events: SessionEvent[];
}

/** A transcript with full-text search hits (`search_transcripts`). */
export interface TranscriptMatch {
  sessionId: string;
  /** Case-insensitive hits across the user and assistant text. */
  matches: number;
}

export interface RepoCost {
  repoName: string;
  repoPath: string | null;
  costUsd: number;
  sessions: number;
  tokens: number;
  messages: number;
}

export interface CostBreakdown {
  totalUsd: number;
  /** Portion of `totalUsd` spent by subagent runs. */
  subagentUsd: number;
  totalTokens: number;
  totalMessages: number;
  byModel: ModelUsage[];
  byRepo: RepoCost[];
  byDay: number[];
}

export interface CostBucket {
  /** Unix millis, UTC. */
  startTs: number;
  /** Unix millis, UTC. */
  endTs: number;
  /** Human-readable label computed server-side. */
  label: string;
  sessions: number;
  messages: number;
  tokens: number;
  costUsd: number;
}

export interface CostTotals {
  sessions: number;
  messages: number;
  tokens: number;
  costUsd: number;
}

export interface RepoCostDetail {
  repoName: string;
  repoPath: string | null;
  totals: CostTotals;
  /** Daily buckets for the trailing 30d window, oldest → newest. */
  byDay: CostBucket[];
  /** Anthropic-style aligned 5h windows with activity, newest → oldest. */
  byFiveHour: CostBucket[];
  /** Calendar weeks (Mon-start) covering the window, newest → oldest. */
  byWeek: CostBucket[];
  /** Anthropic-style 7d rolling sessions, newest → oldest. */
  byWeeklySession: CostBucket[];
}

export interface ActiveProcess {
  pid: number;
  name: string;
  cwd: string | null;
  runtimeSec: number;
  memoryKb: number;
}

export type LiveAgent = "claude" | "codex" | "cursor";

export interface LiveEvent {
  ts: number;
  sessionId: string;
  cwd: string | null;
  tool: string;
  summary: string;
  agent: LiveAgent;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface LiveTodo {
  content: string;
  status: TodoStatus;
}

export interface SessionLiveState {
  sessionId: string;
  cwd: string | null;
  lastTs: number;
  lastTool: string | null;
  lastSummary: string | null;
  todos: LiveTodo[];
  agent: LiveAgent;
}

export interface LiveActivity {
  feed: LiveEvent[];
  sessions: SessionLiveState[];
}

/** Context-window fill for one running agent session. */
export interface LiveContext {
  agent: LiveAgent;
  sessionId: string;
  pid: number | null;
  /** Session / thread / composer display name, when the agent records one. */
  name: string | null;
  cwd: string | null;
  model: string | null;
  /** Null for Cursor, which only persists a percentage. */
  usedTokens: number | null;
  windowTokens: number | null;
  /** 0–100; null until the session's first model turn lands. */
  usedPercent: number | null;
  /** "busy" | "idle" when the agent reports it (Claude only). */
  status: "busy" | "idle" | null;
  /** Epoch ms of the latest activity seen for this session. */
  lastTs: number;
}

/** Claude Code `statusLine` integration state. */
export interface ClaudeStatusline {
  /** `~/.claude` exists. */
  available: boolean;
  /** Claude's `statusLine` runs LunoPeak. */
  installed: boolean;
  /** Installed but pointing at a LunoPeak binary that has since moved. */
  stalePath: boolean;
  /** A non-LunoPeak status line currently configured (would be chained). */
  otherCommand: string | null;
  /** The user's previous status line that LunoPeak's runs first. */
  chainedCommand: string | null;
  /** Why this copy of the app can't be installed (e.g. run from a DMG). */
  blockedReason: string | null;
  settingsPath: string;
}

/** Codex `[tui] status_line` integration state. */
export interface CodexStatusline {
  available: boolean;
  installed: boolean;
  currentItems: string[];
  configPath: string;
}

export interface TerminalIntegrations {
  claude: ClaudeStatusline;
  codex: CodexStatusline;
}

export interface DashboardSummary {
  totalRepos: number;
  activeSessions: number;
  totalCostUsd: number;
  uncommittedRepos: number;
  activity30d: number[];
}

export interface ClaudeMdEntry {
  repoName: string | null;
  repoPath: string | null;
  path: string;
  bytes: number;
  words: number;
  estimatedTokens: number;
  scope: "global" | "repo";
  /** Newline count of the file's content. */
  lines: number;
  /** Top-level markdown headings (H1 + H2), in source order. */
  topics: string[];
  /** Full file content. CLAUDE.md is generally small. */
  body: string;
  /** CLAUDE.md, AGENTS.md, or one of Claude's auto-saved memory notes. */
  kind: "claude-md" | "agents-md" | "memory";
  /** Frontmatter `description` (auto-memory notes carry one). */
  description: string | null;
  /** File mtime, epoch ms. */
  modifiedMs: number | null;
}

export interface ConfigArtifact {
  name: string;
  description: string | null;
  model: string | null;
  tools: string | null;
  repoName: string | null;
  repoPath: string | null;
  path: string;
  /** Plugin artifacts carry the plugin's short name in `repoName` and no `repoPath`. */
  scope: "global" | "repo" | "plugin";
}

export interface HookEntry {
  event: string;
  matcher: string | null;
  command: string;
  repoName: string | null;
  repoPath: string | null;
  scope: "global" | "repo";
  /** Absolute path of the settings.json that declared this hook. */
  sourcePath: string | null;
}

export type Severity = "info" | "warn" | "error";

export interface HygieneIssue {
  /** null for system-scoped issues that aren't tied to a repo. */
  repoName: string | null;
  repoPath: string | null;
  kind: string;
  message: string;
  severity: Severity;
  /** Suggested CLI command for resolving this issue. */
  command?: string | null;
  /** Stable identifier (branch name, pid, etc.) the UI passes back to actions. */
  target?: string | null;
  /** Secondary descriptor line (e.g. cwd of a background listener). */
  details?: string | null;
}

export type AuditManager = "npm" | "yarn" | "pnpm" | "composer";

export interface AuditTarget {
  repoName: string;
  repoPath: string;
  manager: AuditManager;
  /** Whether a safe automatic fix exists for this manager (false for yarn). */
  canFix: boolean;
}

export interface AuditReport {
  manager: AuditManager;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
  total: number;
  /** Set when the audit couldn't run (missing binary, offline, parse error). */
  error?: string | null;
  /** Human summary after a fix run (e.g. "Ran npm audit fix"). */
  message?: string | null;
  /** Unix ms when the audit actually ran — drives "checked Xh ago" and the 24h cache. */
  checkedAt?: number | null;
}

export interface RepoSetup {
  repoName: string;
  repoPath: string;
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
  hasSkills: boolean;
  hasAgents: boolean;
  hasHooks: boolean;
  completeness: number;
  /** AGENTS.md at the repo root. */
  hasAgentsMd: boolean;
  /** `.cursor/rules/` or a legacy `.cursorrules`. */
  hasCursorRules: boolean;
  /** `.mcp.json` or `.cursor/mcp.json`. */
  hasMcp: boolean;
}

export interface ListeningPort {
  pid: number;
  port: number;
  address: string;
  process: string;
  cwd: string | null;
}

export interface DiffStat {
  repoName: string;
  repoPath: string;
  branch: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export interface DirtyFile {
  path: string;
  /** Single-char index status (`' '` = unchanged, `'?'` = untracked). */
  staged: string;
  /** Single-char worktree status. */
  unstaged: string;
}

/** One file's uncommitted change against HEAD; untracked files come back as new. */
export interface FileDiff {
  /** Repo-relative path. */
  path: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  /** Unified diff body (hunks only), capped server-side. */
  patch: string;
  truncated: boolean;
}

/** A local branch with its distance from the default branch. */
export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isDefault: boolean;
  /** Tip commit time, ms since epoch. */
  lastCommitTs: number | null;
  ahead: number;
  behind: number;
  /** Fully contained in the default branch, so safe to delete. */
  merged: boolean;
}

export interface RepoStash {
  /** Reflog reference, e.g. `stash@{0}`. */
  reflog: string;
  /** Reflog subject, e.g. `On main: WIP refactor`. */
  subject: string;
  /** Files changed in the stash. */
  files: string[];
}

export type TimelineEvent =
  | {
      kind: "session";
      ts: number;
      /** Session id — the Replay link target. */
      id: string;
      /** First prompt, trimmed. Null when the transcript has none. */
      title: string | null;
      project: string | null;
      model: string | null;
      costUsd: number;
      messageCount: number;
    }
  | {
      kind: "commit";
      ts: number;
      repo: string;
      sha: string;
      author: string;
      subject: string;
    };

export interface RepoActivity {
  repoName: string;
  repoPath: string;
  days: number[];
  totalSessions: number;
  totalCommits: number;
  /** `days` filtered to commits authored by the local git user, plus all sessions. */
  mineDays: number[];
  mineCommits: number;
}

export interface ToolBreakdown {
  name: string;
  calls: number;
  errors: number;
}

export interface DayBucket {
  /** "YYYY-MM-DD" in local time. */
  date: string;
  calls: number;
}

export interface SequenceEntry {
  from: string;
  to: string;
  count: number;
}

export interface ErrorEntry {
  tool: string;
  errors: number;
  errorPct: number;
}

export interface FileEntry {
  path: string;
  repo: string | null;
  count: number;
}

export interface CommandEntry {
  command: string;
  count: number;
}

export interface ToolStats {
  totalCalls: number;
  totalErrors: number;
  totalFilesTouched: number;
  avgCallsPerSession: number;
  errorRatePct: number;
  vsLastWeekPct: number;
  projects: string[];
  byDay: DayBucket[];
  byTool: ToolBreakdown[];
  sequences: SequenceEntry[];
  errorProne: ErrorEntry[];
  topFiles: FileEntry[];
  topCommands: CommandEntry[];
}

export interface DepEntry {
  repoName: string;
  repoPath: string;
  manager: string;
  manifest: string;
  prod: number;
  dev: number;
  examples: string[];
}

export interface WorktreeEntry {
  repoName: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export interface EnvFile {
  repoName: string;
  repoPath: string;
  fileName: string;
  keys: string[];
  gitignored: boolean;
  committedRisk: boolean;
  repoHasExample: boolean;
}

export interface LintIssue {
  /** "too-long" | "large-file" | "stale-ref" */
  kind: string;
  message: string;
}

export interface ClaudeMdLintReport {
  repoName: string;
  repoPath: string;
  path: string;
  bytes: number;
  lines: number;
  body: string;
  issues: LintIssue[];
}

export interface SnapshotRepo {
  repoName: string;
  repoPath: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  diffFiles: string[];
  insertions: number;
  deletions: number;
}

export interface Snapshot {
  id: string;
  name: string;
  note: string | null;
  createdTs: number;
  repos: SnapshotRepo[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  /** Branch the PR is from (`headRefName` in gh's JSON). */
  headRef: string;
  isDraft: boolean;
  /** gh `reviewDecision`: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when reviews aren't required. */
  reviewDecision: string | null;
  /** ms since epoch, parsed from gh's `updatedAt`. Null when missing. */
  updatedAtMs: number | null;
  repoName: string;
  repoPath: string;
  /** "owner/name" on github.com. */
  owner: string;
  repo: string;
}

export interface GithubStatus {
  installed: boolean;
  authenticated: boolean;
  user: string | null;
  /** First-line error from `gh auth status` when authentication failed. */
  message: string | null;
}

export interface PullRequestList {
  status: GithubStatus;
  prs: PullRequest[];
  /** Number of tracked repos with a github.com remote. */
  githubRepoCount: number;
}

export interface UsageWindow {
  /**
   * Provider-reported percent (0..100). null when we have to derive
   * usage from raw token spend without knowing the user's plan tier
   * (e.g. Claude — render absolute usage instead).
   */
  usedPercent: number | null;
  tokens: number;
  costUsd: number;
  messageCount: number;
  /** Unix epoch seconds when the window resets, if known. */
  resetsAt: number | null;
  /** Window length in seconds. */
  windowSeconds: number;
}

export type UsageProvider = "claude" | "codex" | "cursor";

export type UsageNoticeKind =
  | "rateLimited"
  | "authError"
  | "networkError"
  | "parseError"
  | "staleSource";

export interface UsageNotice {
  kind: UsageNoticeKind;
  message: string;
  /** Unix epoch seconds when the cached failure expires and we'll retry. */
  retryAt: number | null;
}

/**
 * A weekly cap scoped to one model family (today: Fable), reported by
 * Anthropic alongside the all-models weekly window. It fills independently
 * and can bind first.
 */
export interface ModelLimit {
  /** Model display name as the provider reports it ("Fable"). */
  model: string;
  /** API-reported percent + reset; local 7-day spend for this model. */
  window: UsageWindow;
  /** True when this is the cap currently binding the account. */
  isActive: boolean;
}

export interface ProviderUsage {
  provider: UsageProvider;
  /** Subscription tier label when known (e.g. Codex's "plus"). */
  plan: string | null;
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  /**
   * Transient warning to surface alongside the bars — e.g. when the
   * provider's usage API is rate-limiting us and the `%` columns can't be
   * filled. null on a clean fetch.
   */
  notice?: UsageNotice | null;
  /** Per-model weekly caps (Claude only). Empty when none are reported. */
  modelLimits?: ModelLimit[];
}

export interface UsageLimits {
  providers: ProviderUsage[];
}

// ── Provider service status ──────────────────────────────────────────────

export interface ProviderIncident {
  name: string;
  /** "investigating" | "identified" | "monitoring" | "resolved" | "postmortem" */
  status: string;
  /** "none" | "minor" | "major" | "critical" */
  impact: string;
  url: string;
  startedAt: number | null;
  updatedAt: number | null;
}

export interface ProviderStatus {
  /** "claude" | "codex" | "cursor" */
  provider: string;
  /** "none" | "minor" | "major" | "critical" | "unknown" */
  indicator: string;
  description: string;
  incidents: ProviderIncident[];
  fetchedAt: number;
}

export interface ProviderStatusList {
  providers: ProviderStatus[];
}

export interface ClaudeConfig {
  path: string;
  model: string | null;
  /** `permissions.defaultMode`. */
  permissionMode: string | null;
}

export interface CodexConfig {
  path: string;
  model: string | null;
  reasoningEffort: string | null;
  approvalPolicy: string | null;
}

export interface CursorConfig {
  path: string;
  projectCount: number;
  ruleCount: number;
}

export interface McpServerEntry {
  name: string;
  scope: string;
  projectPath: string | null;
  command: string | null;
  argsSummary: string | null;
}

export interface PluginEntry {
  name: string;
  marketplace: string;
  version: string | null;
  enabled: boolean;
}

export interface SetupOverview {
  claude: ClaudeConfig | null;
  codex: CodexConfig | null;
  cursor: CursorConfig | null;
  mcpServers: McpServerEntry[];
  plugins: PluginEntry[];
  repos: RepoSetup[];
}

export interface RepoOverviewEntry {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  hasClaudeMd: boolean;
  hasUncommitted: boolean;
  lastActivityTs: number | null;
  lastCommitSubject: string | null;
  unpushedCommits: number;
  /** Files with pending changes (staged + unstaged + untracked). 0 when clean. */
  uncommittedFiles: number;
  /** Entries in `git stash list`. */
  stashCount: number;
  skillCount: number;
  /** Sessions+commits per day for last 30 days, oldest → newest. */
  activity30d: number[];
}

export interface ReposOverview {
  repos: RepoOverviewEntry[];
  activeCount: number;
  dirtyCount: number;
  unpushedCount: number;
  /** Sum of `uncommittedFiles` across all repos. */
  uncommittedFilesTotal: number;
  /** Repos checked out on something other than `main`/`master`/`develop`. */
  featureBranchCount: number;
}

export interface RepoDetail {
  entry: RepoOverviewEntry;
  /** Raw CLAUDE.md text. Null when the file isn't present. */
  claudeMd: string | null;
  skills: ConfigArtifact[];
}

/** Mirrors `LogEntry` in `src-tauri/src/logger.rs`. One runtime log line. */
export interface LogEntry {
  /** RFC3339 timestamp. */
  ts: string;
  level: Severity;
  source: "backend" | "frontend";
  /** Subsystem tag, e.g. "window", "react", "ipc". */
  scope: string;
  msg: string;
  detail?: string;
}
