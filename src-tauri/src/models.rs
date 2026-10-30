use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub has_claude_md: bool,
    pub has_uncommitted: bool,
    pub last_activity_ts: Option<i64>,
    pub size_kb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeys {
    pub anthropic: Option<String>,
    pub openai: Option<String>,
    pub gemini: Option<String>,
    pub xai: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AssistantProvider {
    #[default]
    Anthropic,
    Openai,
    Gemini,
    Xai,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeneralPrefs {
    pub launch_at_login: bool,
    pub check_updates: bool,
    /// Download + install the next available update without showing a banner.
    /// Only consulted when `check_updates` is also true.
    #[serde(default)]
    pub auto_install_updates: bool,
    /// True after the user has dismissed the first-run "check for updates?"
    /// dialog. Prevents re-prompting on every launch.
    #[serde(default)]
    pub update_prompt_seen: bool,
    /// When false (default) scrollbars are fully invisible. When true, a
    /// thin always-visible thumb is rendered.
    #[serde(default)]
    pub show_scrollbars: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBudget {
    pub daily_usd: f64,
    pub monthly_usd: f64,
    /// Percent (0–100). 80 means alert when spend reaches 80% of the limit.
    pub alert_threshold_pct: u8,
}

impl Default for CostBudget {
    fn default() -> Self {
        Self {
            daily_usd: 0.0,
            monthly_usd: 0.0,
            alert_threshold_pct: 80,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAlerts {
    pub enabled: bool,
    /// Percent (0–100). 80 means alert when a provider's usage window reaches 80%.
    pub threshold_pct: u8,
}

impl Default for UsageAlerts {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold_pct: 80,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSources {
    pub claude_code: bool,
    pub codex: bool,
    #[serde(default = "default_true")]
    pub cursor: bool,
    /// Opt-in: also fetch Cursor plan utilization + on-demand spend from the
    /// cursor.com web API, using browser cookies from any installed browser.
    /// Off by default because the one-time cookie read triggers an OS keychain
    /// prompt on macOS (Chrome encrypts its cookie DB with a Keychain-stored
    /// key). When enabled alongside `cursor: true`, the web data replaces the
    /// SQLite-derived composer context % in the Rate-limits row.
    #[serde(default)]
    pub cursor_web: bool,
    /// First-run sentinel. False on fresh installs and on settings files
    /// written by builds that predate a given agent. The loader flips it to
    /// true after force-enabling all known agents — this forward-fixes users
    /// who carry an old settings.json with `codex: false` from a v1.0/v1.1
    /// install where that was the default.
    #[serde(default)]
    pub initialized: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AgentSources {
    fn default() -> Self {
        Self {
            claude_code: true,
            codex: true,
            cursor: true,
            cursor_web: false,
            initialized: false,
        }
    }
}

/// Filesystem probe result — which agents the user actually has installed on
/// this machine. Distinct from `AgentSources` (which tracks whether the user
/// has *enabled* each agent's data source in Settings). The frontend uses
/// this to genericize copy, hide / soft-disable Claude-only features for
/// users who only run Codex or Cursor, and tailor onboarding text.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgents {
    pub claude_code: bool,
    pub codex: bool,
    pub cursor: bool,
}

/// Which provider's percent the tray-icon title leads with.
/// `Auto` picks the highest-utilized window across enabled providers.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TrayPinnedProvider {
    #[default]
    Auto,
    Claude,
    Codex,
    Cursor,
}

/// Which usage window's percent the tray-icon title shows. The 5h session
/// is the default — it changes faster and is the one users typically need
/// to react to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
pub enum TrayHeadlineWindow {
    #[default]
    #[serde(rename = "5h")]
    FiveHour,
    #[serde(rename = "weekly")]
    Weekly,
    /// Claude's Fable-scoped weekly cap. Providers without one (Codex,
    /// Cursor, or Claude when the API reports no Fable limit) fall back to
    /// their all-models weekly window.
    #[serde(rename = "fable")]
    Fable,
}

/// What sits next to the menu-bar owl. The icon no longer says which
/// provider or limit leads, so `PercentWindow` names the limit ("42% 5h").
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TrayTitleStyle {
    /// Icon only.
    Off,
    /// "42%"
    #[default]
    Percent,
    /// "42% 5h" / "42% Wk" / "42% Fable"
    PercentWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPrefs {
    pub enabled: bool,
    /// When true, closing the window hides it instead of quitting — the
    /// tray stays live so usage keeps refreshing.
    pub close_to_tray: bool,
    pub pinned_provider: TrayPinnedProvider,
    #[serde(default)]
    pub headline_window: TrayHeadlineWindow,
    #[serde(default)]
    pub title_style: TrayTitleStyle,
}

impl Default for TrayPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            close_to_tray: true,
            pinned_provider: TrayPinnedProvider::default(),
            headline_window: TrayHeadlineWindow::default(),
            title_style: TrayTitleStyle::default(),
        }
    }
}

/// Where "Open" buttons send a path. `default_editor` is `None` until the
/// user picks one — the UI prompts on first open and persists the choice
/// here when the user opts to remember it.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorPrefs {
    #[serde(default)]
    pub default_editor: Option<String>,
}

/// When the sidebar's Plan usage card shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SidebarPlanUsage {
    #[default]
    Always,
    /// Only while some tracked agent is at 70% or more of a limit.
    Close,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarPrefs {
    #[serde(default)]
    pub plan_usage: SidebarPlanUsage,
    /// Section ids the user has folded. Agent setup and Backups start folded.
    #[serde(default = "default_folded_sections")]
    pub folded_sections: Vec<String>,
}

fn default_folded_sections() -> Vec<String> {
    vec!["setup".into(), "backups".into()]
}

impl Default for SidebarPrefs {
    fn default() -> Self {
        Self {
            plan_usage: SidebarPlanUsage::default(),
            folded_sections: default_folded_sections(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub scan_dirs: Vec<String>,
    pub api_keys: ApiKeys,
    pub default_model: String,
    pub theme: String,
    pub telemetry: bool,
    #[serde(default)]
    pub provider: AssistantProvider,
    /// Base URL of the local Ollama daemon. The default is the upstream
    /// listen address — overridable when the user runs Ollama on a custom
    /// port or on a remote host.
    #[serde(default = "default_ollama_endpoint")]
    pub ollama_endpoint: String,
    /// True only on the very first launch (when settings.json doesn't yet
    /// exist on disk). The frontend uses this to probe for a local Ollama
    /// daemon and auto-select it as the default provider, then writes
    /// `firstRun: false` back so subsequent launches don't reprobe.
    #[serde(default)]
    pub first_run: bool,
    #[serde(default)]
    pub general: GeneralPrefs,
    #[serde(default)]
    pub cost_budget: CostBudget,
    #[serde(default)]
    pub usage_alerts: UsageAlerts,
    #[serde(default)]
    pub agents: AgentSources,
    /// RouteIds the user has hidden from the sidebar.
    #[serde(default)]
    pub hidden_sidebar_items: Vec<String>,
    /// RouteIds in the user's preferred display order. Sidebar groups by
    /// section, then sorts within each section by this list. Routes not
    /// present here keep their default position.
    #[serde(default)]
    pub sidebar_order: Vec<String>,
    #[serde(default)]
    pub sidebar: SidebarPrefs,
    /// False until the first-run setup window finishes. Settings files from
    /// builds that predate setup deserialize as true so upgrades skip it;
    /// only a fresh install (`Settings::default()`) starts at false.
    #[serde(default = "default_true")]
    pub setup_complete: bool,
    #[serde(default)]
    pub tray: TrayPrefs,
    #[serde(default)]
    pub editor: EditorPrefs,
    /// What the Claude Code terminal status line shows. Read directly from
    /// settings.json by the `statusline` CLI on every repaint.
    #[serde(default)]
    pub statusline: StatuslinePrefs,
}

fn default_ollama_endpoint() -> String {
    "http://localhost:11434".into()
}

impl Default for Settings {
    fn default() -> Self {
        let home = dirs::home_dir().map(|h| h.to_string_lossy().to_string());
        let mut scan_dirs = Vec::new();
        if let Some(home) = home {
            for sub in ["Sites", "Projects", "code"] {
                let p = format!("{home}/{sub}");
                if std::path::Path::new(&p).is_dir() {
                    scan_dirs.push(p);
                }
            }
        }
        Self {
            scan_dirs,
            api_keys: ApiKeys::default(),
            default_model: "claude-opus-4-8".into(),
            theme: "system".into(),
            telemetry: false,
            provider: AssistantProvider::default(),
            ollama_endpoint: default_ollama_endpoint(),
            first_run: false,
            general: GeneralPrefs::default(),
            cost_budget: CostBudget::default(),
            usage_alerts: UsageAlerts::default(),
            agents: AgentSources::default(),
            hidden_sidebar_items: Vec::new(),
            sidebar_order: Vec::new(),
            sidebar: SidebarPrefs::default(),
            setup_complete: false,
            tray: TrayPrefs::default(),
            editor: EditorPrefs::default(),
            statusline: StatuslinePrefs::default(),
        }
    }
}

// ── Terminal status line preferences ──────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatuslineSegmentId {
    Context,
    FiveHour,
    Weekly,
    /// Per-model weekly caps (Fable). One piece per limit on the plan.
    ModelLimits,
    SessionCost,
    TodayCost,
    Model,
    Folder,
    Branch,
    /// A segment id written by a newer build; dropped on load.
    #[serde(other)]
    Unknown,
}

impl StatuslineSegmentId {
    /// Every known segment in default display order.
    pub const ALL: [StatuslineSegmentId; 9] = [
        Self::Context,
        Self::FiveHour,
        Self::Weekly,
        Self::ModelLimits,
        Self::SessionCost,
        Self::TodayCost,
        Self::Model,
        Self::Folder,
        Self::Branch,
    ];

    fn on_by_default(self) -> bool {
        !matches!(self, Self::Model | Self::Folder | Self::Branch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineSegment {
    pub id: StatuslineSegmentId,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatuslineResetHint {
    /// Only once a window passes the warn threshold.
    #[default]
    NearLimit,
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatuslineSeparator {
    #[default]
    Bar,
    Dot,
    Pipe,
    Space,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatuslinePrefs {
    /// Display order and on/off per segment.
    pub segments: Vec<StatuslineSegment>,
    /// Draw a 10-cell bar before the context percentage.
    pub context_bar: bool,
    /// Show "340K/1M" after the context percentage.
    pub context_tokens: bool,
    pub color: bool,
    /// Percent at which numbers turn yellow.
    pub warn_percent: u8,
    /// Percent at which numbers turn red.
    pub danger_percent: u8,
    pub reset_hint: StatuslineResetHint,
    pub separator: StatuslineSeparator,
}

impl Default for StatuslinePrefs {
    fn default() -> Self {
        Self {
            segments: StatuslineSegmentId::ALL
                .iter()
                .map(|&id| StatuslineSegment { id, enabled: id.on_by_default() })
                .collect(),
            context_bar: true,
            context_tokens: true,
            color: true,
            warn_percent: 70,
            danger_percent: 85,
            reset_hint: StatuslineResetHint::default(),
            separator: StatuslineSeparator::default(),
        }
    }
}

impl StatuslinePrefs {
    /// Drop unknown / duplicate segments, append any segment this build knows
    /// that the saved list predates (off, so a new segment never appears
    /// unasked), and keep the thresholds ordered.
    pub fn normalized(mut self) -> Self {
        let mut seen = Vec::new();
        self.segments.retain(|s| {
            let keep = s.id != StatuslineSegmentId::Unknown && !seen.contains(&s.id);
            seen.push(s.id);
            keep
        });
        for id in StatuslineSegmentId::ALL {
            if !self.segments.iter().any(|s| s.id == id) {
                self.segments.push(StatuslineSegment { id, enabled: false });
            }
        }
        self.warn_percent = self.warn_percent.clamp(1, 99);
        self.danger_percent = self.danger_percent.clamp(self.warn_percent + 1, 100);
        self
    }
}

/// One styled run of status line text. The CLI turns tones into ANSI
/// colors; Settings renders the same spans as its live preview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatuslineSpan {
    pub text: String,
    pub tone: StatuslineTone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatuslineTone {
    Plain,
    Dim,
    Ok,
    Warn,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    pub total_repos: usize,
    pub active_sessions: usize,
    pub total_cost_usd: f64,
    pub uncommitted_repos: usize,
    /// Sessions per day for the trailing 30 days, oldest → newest.
    pub activity_30d: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    /// Total cache-write tokens (5m + 1h ephemeral writes).
    pub cache_creation: u64,
    /// Subset of `cache_creation` written to the 1h cache (billed higher).
    pub cache_creation_1h: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub start_ts: i64,
    pub end_ts: i64,
    pub message_count: u32,
    pub first_prompt: Option<String>,
    pub usage: TokenUsage,
    pub cost_usd: f64,
    /// Cost (USD) attributed to each local calendar day this session touched,
    /// summed per assistant message. A session that crosses midnight — or is
    /// resumed days after it started — lands each message's spend on the day
    /// it actually happened instead of dumping the whole session on `start_ts`.
    /// This is what makes the day/today cost buckets agree with the
    /// per-message 5h/weekly windows in `scanners::usage`. Internal only:
    /// `#[serde(skip)]` keeps it off the IPC boundary, so the TS mirror in
    /// `src/types/api.ts` stays 1:1 with the serialized shape.
    #[serde(skip)]
    pub cost_by_day: std::collections::BTreeMap<chrono::NaiveDate, f64>,
    /// Subagent transcripts (`<id>/subagents/agent-*.jsonl`) rolled into this
    /// session. Their tokens and spend are already included in `usage` /
    /// `cost_usd`; `subagent_cost_usd` is that share, for display.
    #[serde(default)]
    pub subagent_count: u32,
    #[serde(default)]
    pub subagent_cost_usd: f64,
    /// Tool name → call count for this session.
    pub tool_uses: std::collections::BTreeMap<String, u32>,
    /// Count of tool_result blocks where is_error=true.
    pub tool_errors: u32,
    /// Tool name → error count (correlated via tool_use_id).
    #[serde(default)]
    pub tool_errors_by_name: std::collections::BTreeMap<String, u32>,
    /// "from→to" → count of consecutive tool_use pairs in chronological order.
    #[serde(default)]
    pub tool_sequences: std::collections::BTreeMap<String, u32>,
    /// file_path → number of Edit/Write/NotebookEdit invocations.
    #[serde(default)]
    pub files_edited: std::collections::BTreeMap<String, u32>,
    /// First-token of Bash commands → count.
    #[serde(default)]
    pub bash_commands: std::collections::BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub total_sessions: usize,
    pub total_messages: u64,
    pub total_cost_usd: f64,
    /// Sum of input + output tokens across all sessions.
    pub total_tokens: u64,
    pub usage: TokenUsage,
    /// Histogram by hour-of-day (0..23).
    pub hour_histogram: [u32; 24],
    /// Sessions per day, oldest → newest. Sized for the Sessions view (84d).
    pub day_histogram: Vec<u32>,
    /// Sessions per model.
    pub by_model: Vec<ModelUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub sessions: u32,
    pub cost_usd: f64,
    /// Sum of input + output tokens used for this model.
    pub tokens: u64,
    /// Tokens served from the prompt cache. Excluded from `tokens` (which is
    /// input + output only) but billed, and the basis for
    /// `cache_read_savings_usd`.
    pub cache_read_tokens: u64,
    /// USD this model's discounted cache-read rate saved versus the standard
    /// 0.1× rate for its tier. Zero for every model without such a discount —
    /// today Fable 5.1, Mythos 5.1 and Opus 5.5 carry one. See `pricing::cache_read_savings_usd`.
    pub cache_read_savings_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    pub total_usd: f64,
    /// Portion of `total_usd` spent by subagent runs.
    pub subagent_usd: f64,
    pub total_tokens: u64,
    pub total_messages: u64,
    pub by_model: Vec<ModelUsage>,
    pub by_repo: Vec<RepoCost>,
    /// Spend per day for the last 30 days, oldest → newest.
    pub by_day: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCost {
    pub repo_name: String,
    pub repo_path: Option<String>,
    pub cost_usd: f64,
    pub sessions: u32,
    pub tokens: u64,
    pub messages: u64,
}

/// Aggregate stats for a single bucket (day, 5h window, week, etc.) used
/// in the per-repo cost-detail view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBucket {
    /// Bucket start, unix millis (UTC).
    pub start_ts: i64,
    /// Bucket end (exclusive), unix millis (UTC). For windows; equals
    /// `start_ts + window_len` so the UI can render durations without
    /// recomputing.
    pub end_ts: i64,
    /// Human-readable label, computed server-side so the UI doesn't have to
    /// reimplement timezone math. e.g. "Mon, May 4" for days,
    /// "May 4, 09:00 – 14:00" for 5h windows.
    pub label: String,
    pub sessions: u32,
    pub messages: u64,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostTotals {
    pub sessions: u32,
    pub messages: u64,
    pub tokens: u64,
    pub cost_usd: f64,
}

/// Breakdown returned by `get_repo_cost_detail`. Buckets cover the
/// trailing-30-day window (matching the main Costs view), oldest → newest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCostDetail {
    pub repo_name: String,
    pub repo_path: Option<String>,
    pub totals: CostTotals,
    pub by_day: Vec<CostBucket>,
    /// Anthropic-style 5h windows: floor(ts / 5h). Only windows with
    /// activity are included.
    pub by_five_hour: Vec<CostBucket>,
    /// Calendar weeks (Monday-start), most recent five.
    pub by_week: Vec<CostBucket>,
    /// Anthropic-style 7d rolling sessions: each starts at the first
    /// activity timestamp following the previous session's end.
    pub by_weekly_session: Vec<CostBucket>,
}

// ── Session replay (full event timeline for a single session) ─────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub ts: i64,
    /// "user" | "assistant" | "tool_use" | "tool_result" | "system"
    pub kind: String,
    pub text: Option<String>,
    pub tool_name: Option<String>,
    pub tool_summary: Option<String>,
    /// Truncated tool result body, if any.
    pub tool_result: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub id: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub branch: Option<String>,
    pub model: Option<String>,
    pub start_ts: i64,
    pub end_ts: i64,
    pub message_count: u32,
    /// Includes subagent spend; see `Session::subagent_cost_usd`.
    pub cost_usd: f64,
    pub subagent_count: u32,
    pub subagent_cost_usd: f64,
    pub usage: TokenUsage,
    pub first_prompt: Option<String>,
    /// Unique file paths touched by Edit/Write/NotebookEdit during this
    /// session, oldest reference first.
    pub files_modified: Vec<String>,
    pub events: Vec<SessionEvent>,
}

/// A transcript with full-text search hits, for the Transcripts view.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMatch {
    pub session_id: String,
    /// Case-insensitive hits across the user and assistant text.
    pub matches: u32,
}

// ── Live activity (tool-use feed + per-session state) ─────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    pub ts: i64,
    pub session_id: String,
    pub cwd: Option<String>,
    pub tool: String,
    pub summary: String,
    /// Source agent — "claude" or "codex". Lets the UI match a process to
    /// sessions of the same agent type when several agents share a cwd.
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTodo {
    pub content: String,
    /// "pending" | "in_progress" | "completed"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLiveState {
    pub session_id: String,
    pub cwd: Option<String>,
    pub last_ts: i64,
    pub last_tool: Option<String>,
    pub last_summary: Option<String>,
    pub todos: Vec<LiveTodo>,
    /// Source agent — "claude" or "codex".
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveActivity {
    pub feed: Vec<LiveEvent>,
    pub sessions: Vec<SessionLiveState>,
}

/// Context-window fill for one running agent session. Claude rows come from
/// `~/.claude/sessions/<pid>.json` (exact pid → session mapping); Codex rows
/// pair a running codex process with its newest rollout by cwd; Cursor rows
/// are recently-touched composers, all attributed to the single Cursor pid.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveContext {
    /// "claude" | "codex" | "cursor"
    pub agent: String,
    pub session_id: String,
    pub pid: Option<u32>,
    /// Session / thread / composer display name, when the agent records one.
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    /// Tokens occupying the window as of the latest turn. `None` for Cursor,
    /// which only persists a percentage.
    pub used_tokens: Option<u64>,
    pub window_tokens: Option<u64>,
    /// 0–100. `None` until the session's first model turn lands.
    pub used_percent: Option<f64>,
    /// "busy" | "idle" when the agent reports it (Claude only).
    pub status: Option<String>,
    /// Epoch ms of the latest activity we saw for this session.
    pub last_ts: i64,
}

// ── Terminal status line integration ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIntegrations {
    pub claude: ClaudeStatusline,
    pub codex: CodexStatusline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatusline {
    /// `~/.claude` exists.
    pub available: bool,
    /// `statusLine` in Claude's settings runs LunoPeak.
    pub installed: bool,
    /// Installed, but pointing at a LunoPeak binary that isn't this one
    /// (the app moved) — reinstalling repairs it.
    pub stale_path: bool,
    /// A non-LunoPeak status line currently configured (would be chained).
    pub other_command: Option<String>,
    /// The user's previous status line that ours runs first.
    pub chained_command: Option<String>,
    /// Why this copy of the app can't be installed (e.g. run from a DMG).
    pub blocked_reason: Option<String>,
    pub settings_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusline {
    /// `~/.codex` exists.
    pub available: bool,
    /// `[tui] status_line` holds LunoPeak's item list.
    pub installed: bool,
    pub current_items: Vec<String>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveProcess {
    pub pid: u32,
    pub name: String,
    pub cwd: Option<String>,
    pub runtime_sec: u64,
    pub memory_kb: u64,
}

// ── Phase 3: config inventory ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdEntry {
    pub repo_name: Option<String>,
    pub repo_path: Option<String>,
    pub path: String,
    pub bytes: u64,
    pub words: u32,
    pub estimated_tokens: u32,
    pub scope: String, // "global" | "repo"
    /// Newline count of the file's content.
    pub lines: u32,
    /// Top-level markdown headings (H1 + H2), in source order.
    pub topics: Vec<String>,
    /// Full file content. CLAUDE.md is generally small (≤ a few KB) so it's
    /// fine to ship eagerly to the UI.
    pub body: String,
    /// "claude-md" | "agents-md" | "memory" (Claude's auto-memory notes).
    pub kind: String,
    /// Frontmatter `description` (auto-memory notes carry one).
    pub description: Option<String>,
    /// File mtime, epoch ms.
    pub modified_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigArtifact {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tools: Option<String>,
    pub repo_name: Option<String>,
    pub repo_path: Option<String>,
    pub path: String,
    /// "global" | "repo" | "plugin". Plugin artifacts carry the plugin's
    /// short name in `repo_name` and no `repo_path`.
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub repo_name: Option<String>,
    pub repo_path: Option<String>,
    pub scope: String,
    /// Absolute path of the settings.json file that declares this hook —
    /// lets the UI open it directly in an editor.
    #[serde(default)]
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HygieneIssue {
    /// `None` for system-scoped issues (e.g. background listeners) that aren't
    /// tied to a particular repo.
    pub repo_name: Option<String>,
    pub repo_path: Option<String>,
    pub kind: String,
    pub message: String,
    pub severity: Severity,
    /// Suggested CLI command for resolving this issue, or `None` when there
    /// isn't one (e.g. informational issues).
    #[serde(default)]
    pub command: Option<String>,
    /// Stable identifier the UI can pass back when invoking an action — branch
    /// name for stale-branch, pid for background-listener, etc.
    #[serde(default)]
    pub target: Option<String>,
    /// Secondary descriptor line — e.g. the working directory of a background
    /// listener. Rendered muted below the main message.
    #[serde(default)]
    pub details: Option<String>,
}

/// An auditable dependency root — one per (repo, package manager). Detected
/// cheaply from lockfile presence; the actual audit runs on demand.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditTarget {
    pub repo_name: String,
    pub repo_path: String,
    /// `"npm" | "yarn" | "pnpm" | "composer"`.
    pub manager: String,
    /// Whether a safe automatic fix exists for this manager (false for yarn).
    pub can_fix: bool,
}

/// Result of running an audit (or a fix + re-audit) against one target.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditReport {
    pub manager: String,
    pub critical: u32,
    pub high: u32,
    pub moderate: u32,
    pub low: u32,
    pub info: u32,
    pub total: u32,
    /// Set when the audit couldn't run — missing binary, offline, or
    /// unparseable output. `None` on a successful run (even with vulns).
    #[serde(default)]
    pub error: Option<String>,
    /// Human-readable summary after a fix run (e.g. "Ran npm audit fix").
    #[serde(default)]
    pub message: Option<String>,
    /// Unix ms when this audit actually ran. Stamped by the command layer and
    /// persisted in the cache, so the UI can show "checked Xh ago" and the
    /// cache can expire it after 24h. `None` until a run completes.
    #[serde(default)]
    pub checked_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSetup {
    pub repo_name: String,
    pub repo_path: String,
    pub has_claude_md: bool,
    pub has_claude_dir: bool,
    pub has_skills: bool,
    pub has_agents: bool,
    pub has_hooks: bool,
    pub completeness: u8, // 0-100
    /// AGENTS.md at the repo root (Codex's project instructions).
    pub has_agents_md: bool,
    /// `.cursor/rules/` or a legacy `.cursorrules` file.
    pub has_cursor_rules: bool,
    /// Project-scoped MCP config: `.mcp.json` or `.cursor/mcp.json`.
    pub has_mcp: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub pid: u32,
    pub port: u16,
    pub address: String,
    pub process: String,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub repo_name: String,
    pub repo_path: String,
    pub branch: Option<String>,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    pub files: Vec<String>,
}

/// One row of `git status --porcelain` for a repo. `staged` is the index
/// status code and `unstaged` is the worktree status code (each a single
/// char, ' ' meaning "no change in that domain"). Untracked files report
/// "??". Renames flatten to the new path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyFile {
    pub path: String,
    pub staged: String,
    pub unstaged: String,
}

/// A single entry from `git stash list`, with the files it touches.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStash {
    /// Reflog reference, e.g. `stash@{0}`.
    pub reflog: String,
    /// Reflog subject, e.g. `On main: WIP refactor`.
    pub subject: String,
    /// Files changed in the stash (`git stash show --name-only`).
    pub files: Vec<String>,
}

/// One file's uncommitted change against HEAD (untracked files included,
/// reported as new). `patch` is the raw unified diff body for this file,
/// capped at `MAX_PATCH_LINES` — `truncated` says when the cap kicked in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Repo-relative path.
    pub path: String,
    pub insertions: u32,
    pub deletions: u32,
    pub is_new: bool,
    pub is_deleted: bool,
    pub binary: bool,
    pub patch: String,
    pub truncated: bool,
}

/// A local branch with its distance from the repo's default branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    /// main / master / develop / trunk — whichever the repo has.
    pub is_default: bool,
    /// Tip commit time, ms since epoch.
    pub last_commit_ts: Option<i64>,
    /// Commits on this branch that aren't on the default branch.
    pub ahead: u32,
    /// Commits on the default branch that this branch doesn't have.
    pub behind: u32,
    /// Fully contained in the default branch (ahead == 0), so safe to delete.
    pub merged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
#[serde(tag = "kind")]
pub enum TimelineEvent {
    Session {
        ts: i64,
        /// Session id — the Replay link's target.
        id: String,
        /// First prompt, trimmed. None when the transcript has none.
        title: Option<String>,
        project: Option<String>,
        model: Option<String>,
        cost_usd: f64,
        message_count: u32,
    },
    Commit {
        ts: i64,
        repo: String,
        sha: String,
        author: String,
        subject: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolBreakdown {
    pub name: String,
    pub calls: u64,
    pub errors: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayBucket {
    /// "YYYY-MM-DD" in local time.
    pub date: String,
    pub calls: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceEntry {
    pub from: String,
    pub to: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntry {
    pub tool: String,
    pub errors: u32,
    /// Errors as a percentage of that tool's total calls (0..100).
    pub error_pct: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub repo: Option<String>,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandEntry {
    pub command: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStats {
    pub total_calls: u64,
    pub total_errors: u64,
    /// Unique file_paths touched across all considered sessions.
    pub total_files_touched: u64,
    /// Average tool_use calls per session (rounded).
    pub avg_calls_per_session: f64,
    /// 0..100.
    pub error_rate_pct: f64,
    /// Last-7-days vs prior-7-days call delta. Positive = up, can be negative.
    /// 0.0 if there's no prior-week data.
    pub vs_last_week_pct: f64,
    /// Distinct project names from the underlying session set, sorted.
    pub projects: Vec<String>,
    /// 365 days back, oldest → newest.
    pub by_day: Vec<DayBucket>,
    /// Top 10 tools by call count.
    pub by_tool: Vec<ToolBreakdown>,
    /// Top 10 from→to consecutive pairs.
    pub sequences: Vec<SequenceEntry>,
    /// Top 10 tools with at least one error, sorted by error count desc.
    pub error_prone: Vec<ErrorEntry>,
    /// Top 10 most-edited files.
    pub top_files: Vec<FileEntry>,
    /// Top 10 first-token Bash commands.
    pub top_commands: Vec<CommandEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepEntry {
    pub repo_name: String,
    pub repo_path: String,
    /// "npm" / "cargo" / "pip" / "poetry" / "go" / "bundler"
    pub manager: String,
    pub manifest: String, // path
    pub prod: u32,
    pub dev: u32,
    pub examples: Vec<String>, // first few names for the tooltip / row
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub repo_name: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub locked: bool,
    pub prunable: bool,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    pub repo_name: String,
    pub repo_path: String,
    pub file_name: String,
    pub keys: Vec<String>,
    pub gitignored: bool,
    pub committed_risk: bool,
    /// True if a `.env.example` exists in the same repo.
    pub repo_has_example: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LintIssue {
    /// "too-long" | "large-file" | "stale-ref"
    pub kind: String,
    pub message: String,
}

/// Health report for a single repo's CLAUDE.md file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeMdLintReport {
    pub repo_name: String,
    pub repo_path: String,
    pub path: String,
    pub bytes: u64,
    pub lines: u32,
    pub body: String,
    pub issues: Vec<LintIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRepo {
    pub repo_name: String,
    pub repo_path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub dirty: bool,
    pub diff_files: Vec<String>,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub name: String,
    pub note: Option<String>,
    pub created_ts: i64,
    pub repos: Vec<SnapshotRepo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoActivity {
    pub repo_name: String,
    pub repo_path: String,
    /// 30-day rolling histogram, oldest → newest. Each cell is the
    /// combined count of sessions started + commits authored that day.
    pub days: Vec<u32>,
    pub total_sessions: u32,
    pub total_commits: u32,
    /// Subset of `days` restricted to commits authored by the local git
    /// user (matched against `git config user.email`). Sessions don't have
    /// an "author" — they're always the local user — so they always
    /// contribute to this bucket too.
    pub mine_days: Vec<u32>,
    pub mine_commits: u32,
}

// ── GitHub pull requests ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub author: String,
    /// Branch the PR is from (`headRefName` in gh's JSON).
    pub head_ref: String,
    pub is_draft: bool,
    /// gh's `reviewDecision`: "APPROVED", "CHANGES_REQUESTED",
    /// "REVIEW_REQUIRED", or None when the repo doesn't require reviews.
    pub review_decision: Option<String>,
    /// `updatedAt` from gh, parsed to ms since epoch. None if parsing fails.
    pub updated_at_ms: Option<i64>,
    /// Repo this PR belongs to, as known to the local scanner.
    pub repo_name: String,
    pub repo_path: String,
    /// "owner/name" on github.com.
    pub owner: String,
    pub repo: String,
}

/// Result of probing the local `gh` CLI. We surface this back to the UI so
/// it can render a precise CTA — install gh, log in, etc. — instead of a
/// generic "couldn't fetch PRs" toast.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub user: Option<String>,
    /// First-line error from `gh auth status` when authentication failed.
    /// Empty when authenticated or when gh isn't installed.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestList {
    pub status: GithubStatus,
    pub prs: Vec<PullRequest>,
    /// Number of repos with a github.com remote that we attempted to query.
    /// 0 means none of the user's tracked repos point at GitHub.
    pub github_repo_count: u32,
}

// ── Provider rate-limit windows (Claude / Codex) ───────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Reported by the provider (Codex). None when we have to derive
    /// usage from raw token spend without knowing the user's plan tier
    /// (Claude — render absolute usage instead of a percent bar).
    pub used_percent: Option<f64>,
    pub tokens: u64,
    pub cost_usd: f64,
    /// Number of assistant messages that contributed to this window.
    pub message_count: u32,
    /// Unix epoch seconds when the window resets, if known.
    pub resets_at: Option<i64>,
    /// Window length in seconds (300*60 for 5h, 7*24*3600 for weekly).
    pub window_seconds: u32,
    /// The plan has no cap on this window (Claude Ultra's 5-hour window,
    /// once the account is verified). Usage still accrues; there's no % to
    /// fill, so the UI says "No limit" rather than "—".
    #[serde(default)]
    pub unlimited: bool,
}

/// A weekly cap scoped to one model family (today: Fable), reported by
/// Anthropic's usage API alongside the all-models weekly window. It fills up
/// independently of `weekly` and can bind first.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLimit {
    /// Model display name as the provider reports it ("Fable").
    pub model: String,
    /// `used_percent` / `resets_at` come from the API; tokens, cost and
    /// message count are the local 7-day scan filtered to this model.
    pub window: UsageWindow,
    /// True when this is the cap currently binding the account.
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageNotice {
    /// "rateLimited" | "authError" | "networkError" | "parseError" | "staleSource"
    pub kind: String,
    pub message: String,
    /// Unix epoch seconds — when the cached failure expires and we'll retry.
    /// None when we don't know (e.g. parse errors).
    pub retry_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// "claude" | "codex"
    pub provider: String,
    /// Subscription tier label when known (e.g. Codex's "plus").
    pub plan: Option<String>,
    pub five_hour: UsageWindow,
    pub weekly: UsageWindow,
    /// Transient warning to surface alongside the bars — e.g. when the
    /// provider's usage API is temporarily unavailable and the `%` columns
    /// can't be filled. None on a clean fetch.
    #[serde(default)]
    pub notice: Option<UsageNotice>,
    /// Per-model weekly caps (Claude only). Empty for other providers and
    /// whenever the API doesn't report any.
    #[serde(default)]
    pub model_limits: Vec<ModelLimit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    pub providers: Vec<ProviderUsage>,
}

// ── Provider service status (StatusPage incidents) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIncident {
    pub name: String,
    /// Lifecycle: "investigating" | "identified" | "monitoring" | "resolved"
    /// | "postmortem". Verbatim from the provider's StatusPage response.
    pub status: String,
    /// Severity: "none" | "minor" | "major" | "critical". Lets the UI tint
    /// each incident independently of the provider's rolled-up indicator.
    pub impact: String,
    pub url: String,
    /// Unix epoch seconds. None when the upstream timestamp couldn't be
    /// parsed — the row still renders, just without a relative-time hint.
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    /// "claude" | "codex" | "cursor"
    pub provider: String,
    /// "none" | "minor" | "major" | "critical" | "unknown". The "unknown"
    /// state covers fetch failures so the UI can show a neutral grey dot
    /// rather than a green one when we have no data.
    pub indicator: String,
    /// Human-readable summary from the provider, e.g. "All Systems Operational".
    pub description: String,
    pub incidents: Vec<ProviderIncident>,
    /// Unix seconds — when this snapshot was produced. Lets the UI add a
    /// "checked Xm ago" hint without re-running the fetch.
    pub fetched_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatusList {
    pub providers: Vec<ProviderStatus>,
}

// ── Setup overview (Claude/Codex installation inventory) ──────────────

/// The few top-level keys of ~/.claude/settings.json the Setup card shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeConfig {
    /// Absolute path to ~/.claude/settings.json.
    pub path: String,
    /// `model` — unset means Claude Code's default.
    pub model: Option<String>,
    /// `permissions.defaultMode`: "default" | "acceptEdits" | "plan" | "bypassPermissions".
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfig {
    /// Absolute path to ~/.codex/config.toml.
    pub path: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub approval_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    /// Project name where this server is configured ("global" for top-level entries).
    pub scope: String,
    /// Project path. None for global scope.
    pub project_path: Option<String>,
    /// First non-flag word of `command`, e.g. "npx" or "php".
    pub command: Option<String>,
    /// Joined args after the command, for a one-line summary.
    pub args_summary: Option<String>,
}

/// Surface-level Cursor installation info. Cursor stores chat history in
/// SQLite (`state.vscdb`), so we don't reconstruct sessions or usage from it
/// the way we do with Claude/Codex JSONL rollouts. For now the Setup card
/// just confirms presence and surfaces the MCP servers / project rules that
/// live as plain JSON / Markdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorConfig {
    /// Absolute path to ~/.cursor.
    pub path: String,
    /// Tracked Cursor project directories (basename) under ~/.cursor/projects.
    pub project_count: u32,
    /// Total project rule files (~/.cursor/projects/<id>/rules/*.md).
    pub rule_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    /// Fully-qualified name "<plugin>@<marketplace>".
    pub name: String,
    pub marketplace: String,
    pub version: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupOverview {
    /// `None` when ~/.claude/settings.json is missing or unreadable.
    #[serde(default)]
    pub claude: Option<ClaudeConfig>,
    pub codex: Option<CodexConfig>,
    /// `None` when ~/.cursor doesn't exist (Cursor not installed) or when
    /// the user has disabled the Cursor data source in Settings.
    #[serde(default)]
    pub cursor: Option<CursorConfig>,
    pub mcp_servers: Vec<McpServerEntry>,
    pub plugins: Vec<PluginEntry>,
    pub repos: Vec<RepoSetup>,
}

// ── Repos overview (rich list with last commit, sparkline, skill count) ─

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOverviewEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub has_claude_md: bool,
    pub has_uncommitted: bool,
    pub last_activity_ts: Option<i64>,
    /// Subject line of HEAD's commit (`git log -1 --pretty=%s`).
    pub last_commit_subject: Option<String>,
    /// Commits ahead of upstream tracking branch (0 when no upstream).
    pub unpushed_commits: u32,
    /// Files with pending changes (staged + unstaged + untracked). 0 when clean.
    pub uncommitted_files: u32,
    /// Entries in `git stash list`.
    pub stash_count: u32,
    /// Skills attached to this repo, counted from the config scanner.
    pub skill_count: u32,
    /// Sessions+commits per day for last 30 days, oldest → newest. Empty
    /// when the repo had no activity in that window.
    pub activity30d: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReposOverview {
    pub repos: Vec<RepoOverviewEntry>,
    /// Repos with activity in the last 7 days.
    pub active_count: u32,
    /// Repos with uncommitted changes.
    pub dirty_count: u32,
    /// Repos with at least one unpushed commit.
    pub unpushed_count: u32,
    /// Sum of `uncommitted_files` across all repos.
    pub uncommitted_files_total: u32,
    /// Repos checked out on something other than `main`/`master`/`develop`,
    /// excluding detached HEAD and unknown.
    pub feature_branch_count: u32,
}

/// Aggregated detail for a single repo: the overview entry plus the raw
/// CLAUDE.md content and any skills attached to the repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDetail {
    pub entry: RepoOverviewEntry,
    /// Raw CLAUDE.md text. None when the file isn't present.
    pub claude_md: Option<String>,
    pub skills: Vec<ConfigArtifact>,
}
