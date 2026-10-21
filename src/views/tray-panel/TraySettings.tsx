import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { usePlatform } from "@/hooks/usePlatform";
import { getAppVersion } from "@/lib/diagnostics";
import { queries } from "@/lib/queries";
import { api } from "@/lib/tauri";
import { friendlyUpdateError } from "@/lib/updateErrors";
import { cn } from "@/lib/utils";
import type {
  ProviderUsage,
  Settings,
  TrayHeadlineWindow,
  TrayPinnedProvider,
  TrayTitleStyle,
  UsageProvider,
} from "@/types/api";
import { cardSurface, GroupLabel, providerAccent, providerLabel } from "./shared";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * In-panel Settings, opened from the home header's gear. Only what people
 * change from the menu bar: what the menu bar shows, which agents to track,
 * alerts and budgets, and a few basics. Everything else (scan folders,
 * assistant keys, editors, sidebar) stays in the app, one link away.
 *
 * Changes save immediately through `update_settings`, which broadcasts
 * `settings://changed` and refreshes the tray title.
 */
export function TraySettings({
  settings,
  providers,
  onBack,
}: {
  settings: Settings | undefined;
  providers: ProviderUsage[];
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const platform = usePlatform();
  const update = useMutation({
    mutationFn: api.updateSettings,
    // Optimistic, same as SettingsView: switches flip before the IPC
    // round-trip and roll back if it fails.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: queries.settings.queryKey });
      const prev = qc.getQueryData<Settings>(queries.settings.queryKey);
      qc.setQueryData(queries.settings.queryKey, next);
      return { prev };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(queries.settings.queryKey, ctx.prev);
    },
    onSettled: (_data, _err, next, ctx) => {
      void qc.invalidateQueries({ queryKey: queries.settings.queryKey });
      const a = ctx?.prev?.agents;
      const b = next.agents;
      const agentsChanged =
        !a ||
        a.claudeCode !== b.claudeCode ||
        a.codex !== b.codex ||
        a.cursor !== b.cursor ||
        a.cursorWeb !== b.cursorWeb;
      if (agentsChanged) {
        // Agent toggles change which feeds exist; refetch what home shows.
        // Invalidate rather than remove — those queries stay mounted at the
        // panel root, and home keeps painting until fresh data lands.
        for (const queryKey of [
          queries.usageLimits.queryKey,
          queries.costs.queryKey,
          queries.liveContexts.queryKey,
        ]) {
          void qc.invalidateQueries({ queryKey });
        }
      }
    },
  });
  const onChange = (next: Settings) => update.mutate(next);

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-black/[0.06] pb-2 pl-2 pr-3 pt-2.5 dark:border-white/[0.06]">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-0.5 rounded-md py-1 pl-1 pr-2 text-[13px] font-medium text-blue-600 transition hover:bg-black/[0.05] dark:text-blue-400 dark:hover:bg-white/[0.06]"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          Back
        </button>
        <span className="mr-14 flex-1 text-center text-[13px] font-semibold">Settings</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {settings ? (
          <div className="flex flex-col gap-4 px-4 pb-4 pt-3.5">
            {/* Windows draws no text beside tray icons, so there's nothing
                here to choose. */}
            {platform !== "windows" && (
              <MenuBarGroup
                settings={settings}
                providers={providers}
                title={platform === "macos" ? "Menu bar" : "System tray"}
                onChange={onChange}
              />
            )}
            <AgentsGroup settings={settings} onChange={onChange} />
            <AlertsGroup settings={settings} onChange={onChange} />
            <GeneralGroup settings={settings} onChange={onChange} />
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 pb-4 pt-3.5">
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-black/[0.06] py-2.5 pl-4 pr-3 dark:border-white/[0.06]">
        <span className="flex-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          Scan folders, assistant, editors and sidebar are in the app.
        </span>
        <button
          type="button"
          onClick={() => void api.trayNavigate("settings")}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-black/10 bg-white/70 px-2.5 py-1.5 text-[12px] font-medium transition hover:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
        >
          All settings
          <ArrowUpRight size={12} strokeWidth={2} />
        </button>
      </div>
    </>
  );
}

// ── Building blocks ──────────────────────────────────────────────────

function Group({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <GroupLabel caption={caption}>{title}</GroupLabel>
      <div
        className={cn(
          "flex flex-col [&>*:not(:last-child)]:border-b [&>*:not(:last-child)]:border-black/[0.05] dark:[&>*:not(:last-child)]:border-white/[0.06]",
          cardSurface,
        )}
      >
        {children}
      </div>
    </section>
  );
}

function RowText({ label, hint }: { label: string; hint?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-[12.5px] text-zinc-700 dark:text-zinc-300">{label}</span>
      {hint && (
        <span className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</span>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <RowText label={label} hint={hint} />
      <Switch checked={checked} onChange={onChange} disabled={disabled} ariaLabel={label} />
    </div>
  );
}

/** Label with the SettingsView pill options wrapped underneath it. */
function OptionsRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5">
      <span className="text-[12.5px] text-zinc-700 dark:text-zinc-300">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => {
          const active = opt.id === value;
          return (
            <button
              key={opt.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(opt.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                active
                  ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                  : "text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-200",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {hint && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </div>
  );
}

function PercentSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="whitespace-nowrap text-[12px] text-zinc-600 dark:text-zinc-400">
        {label}
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="lp-range min-w-0 flex-1"
        style={{ ["--lp-range-pct" as string]: `${value}%` }}
      />
      <span className="w-9 text-right text-[12.5px] font-semibold tabular-nums text-blue-700 dark:text-blue-400">
        {value}%
      </span>
    </div>
  );
}

// ── Menu bar ─────────────────────────────────────────────────────────

const PROVIDER_OPTIONS: ReadonlyArray<{ id: TrayPinnedProvider; label: string }> = [
  { id: "auto", label: "Highest" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

const WINDOW_OPTIONS: ReadonlyArray<{ id: TrayHeadlineWindow; label: string }> = [
  { id: "5h", label: "This session" },
  { id: "weekly", label: "This week" },
  { id: "fable", label: "Fable" },
];

function MenuBarGroup({
  settings,
  providers,
  title,
  onChange,
}: {
  settings: Settings;
  providers: ProviderUsage[];
  title: string;
  onChange: (next: Settings) => void;
}) {
  const t = settings.tray;
  const setTray = (patch: Partial<Settings["tray"]>) =>
    onChange({ ...settings, tray: { ...t, ...patch } });
  const installed = useInstalledAgents();

  const leading = pickLeading(settings, providers);
  const percent = (leading && headlineFor(leading, t.headlineWindow, false)) ?? "42%";
  const labeled =
    (leading && headlineFor(leading, t.headlineWindow, true)) ??
    `42% ${WINDOW_SHORT[t.headlineWindow]}`;
  const previewText =
    t.titleStyle === "off" ? null : t.titleStyle === "percent" ? percent : labeled;
  const caption = !leading
    ? "No usage to show yet"
    : t.pinnedProvider === "auto"
      ? `Showing ${providerLabel(leading.provider)} (highest right now)`
      : `Showing ${providerLabel(leading.provider)}`;

  const titleOptions: ReadonlyArray<{ id: TrayTitleStyle; label: string }> = [
    { id: "off", label: "Icon only" },
    { id: "percent", label: percent },
    { id: "percentWindow", label: labeled },
  ];

  return (
    <Group title={title} caption="What sits next to the LunoPeak icon">
      <div className="flex flex-col items-center gap-2 px-3 pb-3 pt-3.5">
        <div className="flex h-[30px] w-full items-center justify-end gap-3.5 rounded-lg bg-white/85 px-3 ring-1 ring-black/[0.06] dark:bg-zinc-800/85 dark:ring-white/[0.08]">
          <span className="text-[12px] text-zinc-400 dark:text-zinc-500">Wi‑Fi</span>
          <span className="flex items-center gap-1.5 rounded bg-black/[0.07] px-1.5 py-0.5 dark:bg-white/[0.1]">
            <img
              src="/icons/lunopeak-template.png"
              alt=""
              aria-hidden
              className="size-4 object-contain dark:invert"
            />
            {previewText && (
              <span className="text-[12.5px] font-medium tabular-nums">{previewText}</span>
            )}
          </span>
          <span className="text-[12px] text-zinc-400 dark:text-zinc-500">Mon 10:24</span>
        </div>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</span>
      </div>
      <OptionsRow
        label="Show"
        value={t.titleStyle}
        options={titleOptions}
        onChange={(v) => setTray({ titleStyle: v })}
      />
      <OptionsRow
        label="Percent for"
        value={t.pinnedProvider}
        options={PROVIDER_OPTIONS.filter((o) => o.id !== "cursor" || installed?.cursor !== false)}
        onChange={(v) => setTray({ pinnedProvider: v })}
      />
      <OptionsRow
        label="Which limit"
        hint="Fable falls back to This week when there's no Fable limit."
        value={t.headlineWindow}
        options={WINDOW_OPTIONS}
        onChange={(v) => setTray({ headlineWindow: v })}
      />
    </Group>
  );
}

// Mirrors `tray::pick_leading` / `headline_windows` / `headline_for` so the
// preview reads exactly what the menu bar will.

const WINDOW_SHORT: Record<TrayHeadlineWindow, string> = {
  "5h": "5h",
  weekly: "Wk",
  fable: "Fable",
};

type Labeled = { pct: number | null; tokens: number; label: string };

function headlineWindows(p: ProviderUsage, window: TrayHeadlineWindow): [Labeled, Labeled] {
  const fiveHour = { pct: p.fiveHour.usedPercent, tokens: p.fiveHour.tokens, label: "5h" };
  const weekly = { pct: p.weekly.usedPercent, tokens: p.weekly.tokens, label: "Wk" };
  if (window === "5h") return [fiveHour, weekly];
  if (window === "weekly") return [weekly, fiveHour];
  const fable = p.modelLimits?.find((l) => l.model.toLowerCase() === "fable");
  return [
    fable
      ? { pct: fable.window.usedPercent, tokens: fable.window.tokens, label: "Fable" }
      : weekly,
    fiveHour,
  ];
}

function headlineFor(
  p: ProviderUsage,
  window: TrayHeadlineWindow,
  labeled: boolean,
): string | null {
  const [primary, secondary] = headlineWindows(p, window);
  const shown = [primary, secondary].find((w) => w.pct != null);
  if (shown && shown.pct != null) {
    const pct = `${shown.pct.toFixed(0)}%`;
    return labeled ? `${pct} ${shown.label}` : pct;
  }
  if (primary.tokens > 0) {
    return `${compactCount(primary.tokens)} tok / ${primary.label.toLowerCase()}`;
  }
  return null;
}

function pickLeading(settings: Settings, providers: ProviderUsage[]): ProviderUsage | null {
  const enabled = providers.filter((p) =>
    p.provider === "claude"
      ? settings.agents.claudeCode
      : p.provider === "codex"
        ? settings.agents.codex
        : p.provider === "cursor"
          ? settings.agents.cursor
          : true,
  );
  const window = settings.tray.headlineWindow;
  if (settings.tray.pinnedProvider !== "auto") {
    return enabled.find((p) => p.provider === settings.tray.pinnedProvider) ?? null;
  }
  let best: ProviderUsage | null = null;
  let bestPct = -Infinity;
  for (const p of enabled) {
    const pct = headlineWindows(p, window)[0].pct ?? -1;
    // `>=` keeps the last of equals, like Rust's `max_by`.
    if (pct >= bestPct) {
      best = p;
      bestPct = pct;
    }
  }
  return best;
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Agents ───────────────────────────────────────────────────────────

function AgentsGroup({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const agents = settings.agents;
  const setAgents = (patch: Partial<Settings["agents"]>) =>
    onChange({ ...settings, agents: { ...agents, ...patch } });
  // Optimistic while the probe loads; hidden only once Cursor is known absent.
  const showCursor = useInstalledAgents()?.cursor !== false;

  return (
    <Group title="Agents to track" caption="Turned-off agents disappear everywhere">
      <AgentRow
        name="Claude Code"
        provider="claude"
        path="~/.claude"
        checked={agents.claudeCode}
        onChange={(v) => setAgents({ claudeCode: v })}
      />
      <AgentRow
        name="Codex"
        provider="codex"
        path="~/.codex"
        checked={agents.codex}
        onChange={(v) => setAgents({ codex: v })}
      />
      {showCursor && (
        // One bordered block: the cursor.com read sits under Cursor's row.
        <div>
          <AgentRow
            name="Cursor"
            provider="cursor"
            path="~/.cursor"
            checked={agents.cursor}
            onChange={(v) => setAgents({ cursor: v })}
            compact
          />
          <div className="flex items-start gap-2.5 pb-2.5 pl-9 pr-3 pt-1">
            <div className={cn("min-w-0 flex-1", !agents.cursor && "opacity-40")}>
              <RowText
                label="Read plan usage from cursor.com"
                hint="Uses your browser sign-in. macOS asks for Keychain access the first time."
              />
            </div>
            <Switch
              checked={agents.cursorWeb}
              disabled={!agents.cursor}
              onChange={(v) => setAgents({ cursorWeb: v })}
              ariaLabel="Read plan usage from cursor.com"
            />
          </div>
        </div>
      )}
    </Group>
  );
}

function AgentRow({
  name,
  provider,
  path,
  checked,
  onChange,
  compact,
}: {
  name: string;
  provider: UsageProvider;
  path: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Tighter bottom padding when a sub-row follows. */
  compact?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 px-3 pt-2.5", compact ? "pb-1.5" : "pb-2.5")}>
      <ProviderIcon
        provider={provider}
        size={14}
        className={cn("shrink-0", providerAccent(provider).text)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[12.5px] font-medium">{name}</span>
        <span className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
          {path}
        </span>
      </div>
      <Switch checked={checked} onChange={onChange} ariaLabel={`${name} data source`} />
    </div>
  );
}

// ── Alerts ───────────────────────────────────────────────────────────

function AlertsGroup({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const alerts = settings.usageAlerts;
  const budget = settings.costBudget;
  const setAlerts = (patch: Partial<Settings["usageAlerts"]>) =>
    onChange({ ...settings, usageAlerts: { ...alerts, ...patch } });
  const setBudget = (patch: Partial<Settings["costBudget"]>) =>
    onChange({ ...settings, costBudget: { ...budget, ...patch } });

  return (
    <Group title="Alerts" caption="Get a notification before you run out">
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <RowText label="Warn me when a limit is nearly used" />
          <Switch
            checked={alerts.enabled}
            onChange={(v) => setAlerts({ enabled: v })}
            ariaLabel="Warn me when a limit is nearly used"
          />
        </div>
        <div className={cn(!alerts.enabled && "pointer-events-none opacity-40")}>
          <PercentSlider
            label="At"
            value={alerts.thresholdPct}
            onChange={(v) => setAlerts({ thresholdPct: v })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        <span className="text-[12.5px] text-zinc-700 dark:text-zinc-300">Spending budget</span>
        <div className="grid grid-cols-2 gap-2">
          <BudgetInput
            label="Per day"
            value={budget.dailyUsd}
            onChange={(v) => setBudget({ dailyUsd: v })}
          />
          <BudgetInput
            label="Per month"
            value={budget.monthlyUsd}
            onChange={(v) => setBudget({ monthlyUsd: v })}
          />
        </div>
        <PercentSlider
          label="Warn at"
          value={budget.alertThresholdPct}
          onChange={(v) => setBudget({ alertThresholdPct: v })}
        />
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Leave at $0 for no budget.
        </span>
      </div>
    </Group>
  );
}

function BudgetInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="flex items-center gap-0.5 rounded-lg border border-black/[0.08] bg-white/80 px-2 py-1.5 text-[12.5px] focus-within:border-blue-500/50 dark:border-white/[0.08] dark:bg-white/[0.04]">
        <span className="text-zinc-500 dark:text-zinc-400">$</span>
        <input
          type="number"
          min={0}
          step="1"
          value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className="min-w-0 flex-1 bg-transparent tabular-nums text-zinc-900 focus:outline-none dark:text-zinc-100"
        />
      </span>
    </label>
  );
}

// ── General ──────────────────────────────────────────────────────────

const THEME_OPTIONS: ReadonlyArray<{ id: Settings["theme"]; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match system" },
];

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string }
  | { kind: "error"; message: string };

function GeneralGroup({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (next: Settings) => void;
}) {
  const general = settings.general;
  const [version, setVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  // The panel has no toast host, so launch-at-login failures show inline.
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    void getAppVersion().then(setVersion);
  }, []);

  const onToggleLaunchAtLogin = async (v: boolean) => {
    setLoginError(null);
    onChange({ ...settings, general: { ...general, launchAtLogin: v } });
    if (!isTauri()) return;
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (v) await enable();
      else await disable();
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e));
      // Revert the toggle if the OS rejected it.
      onChange({ ...settings, general: { ...general, launchAtLogin: !v } });
    }
  };

  const checkNow = async () => {
    if (!isTauri()) {
      setUpdateState({ kind: "error", message: "Not available in browser mode" });
      return;
    }
    setUpdateState({ kind: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const result = await check();
      setUpdateState(result ? { kind: "available", version: result.version } : { kind: "uptodate" });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setUpdateState({ kind: "error", message: friendlyUpdateError(raw) });
    }
  };

  const updateLine =
    updateState.kind === "checking" ? (
      "Checking…"
    ) : updateState.kind === "uptodate" ? (
      <span className="text-emerald-700 dark:text-emerald-400">You're up to date</span>
    ) : updateState.kind === "available" ? (
      // The panel can't host the install banner; the app shows it.
      <span className="text-blue-700 dark:text-blue-400">
        Version {updateState.version} is out. Open LunoPeak to install it.
      </span>
    ) : updateState.kind === "error" ? (
      updateState.message
    ) : version ? (
      `Version ${version}`
    ) : null;

  return (
    <Group title="General">
      <OptionsRow
        label="Appearance"
        value={settings.theme}
        options={THEME_OPTIONS}
        onChange={(v) => onChange({ ...settings, theme: v })}
      />
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <RowText
          label="Open at login"
          hint={
            loginError ? (
              <span className="text-rose-700 dark:text-rose-300">
                Couldn't change this: {loginError}
              </span>
            ) : undefined
          }
        />
        <Switch
          checked={general.launchAtLogin}
          onChange={(v) => void onToggleLaunchAtLogin(v)}
          ariaLabel="Open at login"
        />
      </div>
      <ToggleRow
        label="Keep running when window closes"
        hint="Usage keeps updating up here."
        checked={settings.tray.closeToTray}
        onChange={(v) => onChange({ ...settings, tray: { ...settings.tray, closeToTray: v } })}
      />
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <RowText label="Install updates automatically" hint={updateLine} />
        <button
          type="button"
          onClick={() => void checkNow()}
          disabled={updateState.kind === "checking"}
          className="shrink-0 whitespace-nowrap rounded-md border border-black/[0.08] bg-white/80 px-2 py-0.5 text-[11.5px] font-medium text-zinc-700 transition hover:bg-white disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.1]"
        >
          Check now
        </button>
        <Switch
          checked={general.autoInstallUpdates}
          disabled={!general.checkUpdates}
          onChange={(v) => onChange({ ...settings, general: { ...general, autoInstallUpdates: v } })}
          ariaLabel="Install updates automatically"
        />
      </div>
    </Group>
  );
}

