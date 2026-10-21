import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, Power, Settings as SettingsIcon, TriangleAlert } from "lucide-react";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  CONTEXT_DANGER_PCT,
  contextFolder,
  contextPctClass,
  contextTitle,
  formatContextPct,
  formatContextTokens,
} from "@/components/ui/ContextMeter";
import { useTheme } from "@/hooks/useTheme";
import {
  describeInstalledAgents,
  useInstalledAgents,
} from "@/hooks/useInstalledAgents";
import { useOnline } from "@/hooks/useOnline";
import { queries } from "@/lib/queries";
import { api } from "@/lib/tauri";
import { formatCount, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LiveContext, ProviderUsage, UsageProvider, UsageWindow } from "@/types/api";
import {
  type Accent,
  cardSurface,
  GroupLabel,
  providerAccent,
  providerAccentSecondary,
  providerLabel,
  StaggerItem,
  useNow,
} from "./shared";
import { TraySettings } from "./TraySettings";

/**
 * Tray-bar popover. Frameless webview window owned by `tray.rs`; opens when
 * the user clicks the menu-bar / system-tray icon and auto-hides on blur.
 * Renders without `AppShell` — it has its own chrome via `App.tsx`'s early
 * return for `#/tray-panel`.
 *
 * Two screens share the window: home (below) and `TraySettings`, opened from
 * the header gear. Home, top → bottom:
 *   - header: brand, last-updated time, settings gear
 *   - update banner, when the background check found a new version
 *   - status banner, only when a limit is getting close
 *   - "Plan limits": one card per enabled provider, every window visible
 *   - "Running now": live sessions and how full each chat's context is
 *   - footer: spend today / 30 days, Open LunoPeak, Quit
 *
 * On macOS the page is hosted in a system NSPopover (`tray_popover.rs`),
 * which draws the arrow, material and rounded corners, so the panel's own
 * surface steps aside (`[data-tray-host="popover"]` in index.css).
 */
export function TrayPanelView() {
  const online = useOnline();
  const limits = useQuery({
    ...queries.usageLimits,
    enabled: online,
    refetchInterval: online ? 30 * 1000 : false,
  });
  const costs = useQuery(queries.costs);
  const contexts = useQuery({ ...queries.liveContexts, refetchInterval: 5000 });
  const running = contexts.data ?? [];
  const settings = useQuery(queries.settings);
  const queryClient = useQueryClient();
  const providers = limits.data?.providers ?? [];

  // The tray panel is its own webview window with its own React tree, so
  // `useTheme` has to run here too — `App.tsx`'s call doesn't reach this
  // route (we early-return into `TrayPanelView` above it). This resolves
  // the user's preference (light / dark / system) and re-applies on OS
  // color-scheme changes when set to `system`.
  useTheme(settings.data?.theme ?? "system");

  const [view, setView] = useState<"home" | "settings">("home");
  // Only slide between screens on an actual Back / gear click — not when the
  // panel opens, where the stagger animation is already playing.
  const [switched, setSwitched] = useState(false);
  const go = (next: "home" | "settings") => {
    setSwitched(true);
    setView(next);
  };

  // Replay the staggered entry animation each time the panel is shown. The
  // webview stays alive across show/hide cycles (Rust just toggles window
  // visibility), so changing this counter remounts the keyed wrapper below
  // and the `.lp-tray-item` keyframes restart from frame 0. The panel
  // itself doesn't fade — only the elements inside animate in.
  const [cycle, setCycle] = useState(0);
  const [shown, setShown] = useState(true);

  // The webview is hidden by Rust on blur (popover convention) and re-shown
  // on the next tray click. On that re-show, `window.show()` reveals the
  // React tree in its previous post-animation state (opacity 1) before the
  // `tray-panel://show` event reaches us and bumps `cycle` — so the user
  // briefly sees the panel fully visible, then watches it animate in from
  // scratch. Gate visibility on this flag: blur drops the root to opacity 0
  // (invisible the moment the window is next shown), and the show event
  // lifts it back in the same render that remounts the children.

  // Force the OS scrollbar away so the popover doesn't render a gutter when
  // its body briefly overflows during data refetches. The frameless window
  // is small enough that everything fits at 380×620, so a scrollbar would
  // just be visual noise. (The "Running now" list scrolls on its own.)
  useEffect(() => {
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.getElementById("boot-splash-static")?.remove();
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    void listen("tray-panel://show", () => {
      setShown(true);
      setCycle((c) => c + 1);
      // Every open starts on home, without the screen-switch slide.
      setView("home");
      setSwitched(false);
      // WebKit throttles/pauses timers in hidden webviews, so the
      // `refetchInterval` on usageLimits / costs can't be relied on to
      // keep the panel current while it's tucked away. Invalidate on
      // every show — Rust's cache absorbs the IPC round-trip, and existing
      // data stays painted while the fresh value lands.
      void queryClient.invalidateQueries({ queryKey: queries.usageLimits.queryKey });
      void queryClient.invalidateQueries({ queryKey: queries.costs.queryKey });
      void queryClient.invalidateQueries({ queryKey: queries.liveContexts.queryKey });
    }).then((fn) => unlisteners.push(fn));
    // DOM-native blur on this webview's window — scoped to the tray panel
    // only. We can't use Tauri's global `listen("tauri://blur")` because it
    // also fires for the *main* window losing focus (which happens every
    // time the user clicks the tray icon to open us), and that race would
    // overwrite our `shown=true` back to `false` and leave the panel empty.
    const onBlur = () => setShown(false);
    window.addEventListener("blur", onBlur);
    unlisteners.push(() => window.removeEventListener("blur", onBlur));
    // macOS closes the popover from Rust (tray click, click in another app),
    // and its window may never have been key — so blur alone can't be
    // trusted to fire.
    void listen("tray-panel://hide", () => setShown(false)).then((fn) =>
      unlisteners.push(fn),
    );
    // Escape dismisses, like any menu-bar popover.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.hideTrayPanel();
    };
    window.addEventListener("keydown", onKey);
    unlisteners.push(() => window.removeEventListener("keydown", onKey));
    // Settings live in the main window's React Query cache by default —
    // cross-window cache invalidation isn't a thing, so we listen for the
    // Rust-emitted broadcast on `update_settings` and refetch our copy.
    // Without this, changing the theme in Settings wouldn't reach the tray
    // panel until its 1h staleTime expired.
    void listen("settings://changed", () => {
      void queryClient.invalidateQueries({ queryKey: queries.settings.queryKey });
    }).then((fn) => unlisteners.push(fn));
    // Rust's background update check found (or cleared) an update.
    void listen<string | null>("update://available", (e) => {
      queryClient.setQueryData(queries.availableUpdate.queryKey, e.payload);
    }).then((fn) => unlisteners.push(fn));
    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [queryClient]);

  return (
    <div
      key={cycle}
      className={cn(
        "flex h-screen w-screen flex-col text-zinc-900 dark:text-zinc-50",
        !shown && "opacity-0",
      )}
    >
      <div className="lp-tray-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-zinc-100/70 dark:bg-zinc-950/85">
        {view === "home" ? (
          <div
            key="home"
            className={cn("flex min-h-0 flex-1 flex-col", switched && "lp-tray-view")}
            style={{ ["--lp-tray-slide" as string]: "-6px" }}
          >
            <Home
              providers={providers}
              running={running}
              loading={limits.isLoading}
              updatedAt={limits.dataUpdatedAt}
              byDay={costs.data?.byDay}
              onOpenSettings={() => go("settings")}
            />
          </div>
        ) : (
          <div key="settings" className="lp-tray-view flex min-h-0 flex-1 flex-col">
            <TraySettings
              settings={settings.data}
              providers={providers}
              onBack={() => go("home")}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Home ─────────────────────────────────────────────────────────────

function Home({
  providers,
  running,
  loading,
  updatedAt,
  byDay,
  onOpenSettings,
}: {
  providers: ProviderUsage[];
  running: LiveContext[];
  loading: boolean;
  updatedAt: number;
  byDay: number[] | undefined;
  onOpenSettings: () => void;
}) {
  const banner = useMemo(() => pickBanner(providers), [providers]);
  const update = useQuery(queries.availableUpdate).data;
  // Delays: header 0, banners 50 each, then 50ms per block below them.
  const bannerDelay = update ? 100 : 50;
  const cardsDelay = bannerDelay + (banner ? 50 : 0);
  const cardCount = Math.max(providers.length, loading ? 2 : 1);
  const runningDelay = cardsDelay + 50 * (cardCount + 1);

  return (
    <>
      <StaggerItem delay={0}>
        <Header updatedAt={updatedAt} onOpenSettings={onOpenSettings} />
      </StaggerItem>
      <div className="flex flex-1 flex-col gap-2.5 overflow-hidden px-4 pb-2.5 pt-0.5">
        {update && (
          <StaggerItem delay={50}>
            <UpdateBanner version={update} />
          </StaggerItem>
        )}
        {banner && (
          <StaggerItem delay={bannerDelay}>
            <StatusBanner banner={banner} />
          </StaggerItem>
        )}
        <PlanLimits providers={providers} loading={loading} delayBase={cardsDelay} />
        <RunningNow running={running} delay={runningDelay} />
      </div>
      <StaggerItem delay={runningDelay + 50}>
        {/* No data yet (a fresh agent is still scanning history) reads as a
            dash, not a misleading $0.00. */}
        <Footer
          today={byDay ? costFor(byDay, 1) : null}
          thirty={byDay ? costFor(byDay, 30) : null}
        />
      </StaggerItem>
    </>
  );
}

// ── Header ───────────────────────────────────────────────────────────

function Header({
  updatedAt,
  onOpenSettings,
}: {
  updatedAt: number;
  onOpenSettings: () => void;
}) {
  const now = useNow();
  // No drag region: popovers don't get dragged around — they're anchored to
  // the tray icon. `data-tauri-drag-region` is also unreliable on macOS with
  // vibrancy + custom chrome (see useWindowDrag for the longer story).
  return (
    <div className="flex items-center gap-2 pb-2 pl-4 pr-3 pt-3">
      <img src="/app-icon.png" alt="" aria-hidden className="h-5 w-5 rounded" />
      <span className="text-[13px] font-semibold tracking-tight">LunoPeak</span>
      <span className="flex-1" />
      {updatedAt > 0 && (
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Updated {updatedAgo(updatedAt, now)}
        </span>
      )}
      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="grid size-[26px] place-items-center rounded-md text-zinc-600 transition hover:bg-black/[0.06] dark:text-zinc-400 dark:hover:bg-white/[0.08]"
      >
        <SettingsIcon size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

// ── Update banner ────────────────────────────────────────────────────

/**
 * "LunoPeak X is ready" with a Restart button — the popover's take on the
 * main window's `UpdateBar`. Restart downloads, installs and relaunches in
 * Rust (`install_update`), so it works with no main window open.
 */
function UpdateBanner({ version }: { version: string }) {
  const [installing, setInstalling] = useState(false);
  // The popover has no toaster, so a failed install reads in the banner.
  const [failed, setFailed] = useState(false);
  const restart = async () => {
    setInstalling(true);
    setFailed(false);
    try {
      // Relaunches on success, so returning at all means it failed.
      await api.installUpdate();
    } catch (e) {
      console.error("install_update failed", e);
      setFailed(true);
    }
    setInstalling(false);
  };
  return (
    <div
      role="status"
      className="flex items-center gap-2.5 rounded-xl bg-zinc-900 py-2 pl-3 pr-2 text-white dark:bg-zinc-800 dark:ring-1 dark:ring-white/10"
    >
      <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
        <div className="truncate font-semibold">LunoPeak {version} is ready</div>
        <div className={failed ? "text-rose-300" : "text-zinc-400"}>
          {installing
            ? "Installing…"
            : failed
              ? "Couldn't install. Try again."
              : "Restart to update."}
        </div>
      </div>
      <button
        type="button"
        disabled={installing}
        onClick={() => void restart()}
        className="shrink-0 rounded-[7px] bg-white px-3 py-1.5 text-[12px] font-semibold text-zinc-900 hover:bg-zinc-200 disabled:opacity-60"
      >
        Restart
      </button>
    </div>
  );
}

// ── Status banner ────────────────────────────────────────────────────

interface Banner {
  kind: "warn" | "danger";
  provider: UsageProvider;
  pct: number;
  /** How the window reads mid-sentence: "this session", "this week", … */
  scope: string;
  resetsAt: number | null;
}

/** A provider's plan-limit windows, named the way the panel says them. */
export function limitWindows(p: ProviderUsage): Array<{ scope: string; w: UsageWindow }> {
  if (p.provider === "cursor") {
    // Cursor's headline is the current chat's context fill unless the
    // cursor.com plan read is on, in which case it's the billing period
    // (and carries that period's reset). Chat fill isn't a plan limit —
    // "Running now" covers it.
    return p.fiveHour.resetsAt != null
      ? [{ scope: "this billing period", w: p.fiveHour }]
      : [];
  }
  return [
    { scope: "this session", w: p.fiveHour },
    { scope: "this week", w: p.weekly },
    ...(p.modelLimits ?? []).map((l) => ({
      scope: `this week's ${l.model} limit`,
      w: l.window,
    })),
  ];
}

/**
 * The single most-pressing window across enabled providers, or null when
 * everything is healthy. Thresholds match the cards' status pills (70 / 85),
 * so the banner never warns about a provider whose pill reads "Healthy".
 * Highest percent wins; ties go to the earlier window (session before week)
 * so "you're about to run out right now" beats "next week".
 */
function pickBanner(providers: ProviderUsage[]): Banner | null {
  let worst: Banner | null = null;
  for (const p of providers) {
    for (const { scope, w } of limitWindows(p)) {
      if (w.usedPercent == null) continue;
      if (!worst || w.usedPercent > worst.pct) {
        worst = {
          kind: "warn",
          provider: p.provider,
          pct: w.usedPercent,
          scope,
          resetsAt: w.resetsAt,
        };
      }
    }
  }
  if (!worst || worst.pct < CLOSE_PCT) return null;
  return { ...worst, kind: worst.pct >= OUT_PCT ? "danger" : "warn" };
}

function StatusBanner({ banner }: { banner: Banner }) {
  const danger = banner.kind === "danger";
  const name = providerLabel(banner.provider);
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3 py-2.5",
        danger
          ? "border-rose-500/30 bg-rose-500/10 dark:bg-rose-500/12"
          : "border-amber-500/30 bg-amber-500/10 dark:bg-amber-500/12",
      )}
    >
      <TriangleAlert
        size={16}
        strokeWidth={2}
        className={cn("mt-px shrink-0", danger ? "text-rose-500" : "text-amber-500")}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-[13.5px] font-semibold",
            danger ? "text-rose-700 dark:text-rose-300" : "text-amber-800 dark:text-amber-200",
          )}
        >
          {danger ? `${name} is almost out` : `${name} is getting close to its limit`}
        </div>
        <div className="text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
          {Math.round(banner.pct)}% of {banner.scope} is used.
          {resetSentence(banner.resetsAt)}
        </div>
      </div>
    </div>
  );
}

// ── Plan limits ──────────────────────────────────────────────────────

function PlanLimits({
  providers,
  loading,
  delayBase,
}: {
  providers: ProviderUsage[];
  loading: boolean;
  delayBase: number;
}) {
  const installed = useInstalledAgents();
  const agents = useQuery(queries.settings).data?.agents;
  if (providers.length === 0 && loading) {
    // Same cards, in the order `usage::collect` returns them, for the agents
    // that are switched on — so the real ones land without the panel jumping.
    const pending = (
      [
        ["claude", agents?.claudeCode ?? true],
        ["codex", agents?.codex ?? true],
        ["cursor", agents?.cursor ?? true],
      ] as const
    )
      .filter(([, on]) => on)
      .map(([provider]) => provider);
    return (
      <div className="flex flex-col gap-2">
        <StaggerItem delay={delayBase}>
          <GroupLabel>Plan limits</GroupLabel>
        </StaggerItem>
        {pending.map((provider, i) => (
          <StaggerItem key={provider} delay={delayBase + 50 * (i + 1)}>
            {provider === "cursor" ? (
              <CursorCardSkeleton />
            ) : (
              <ProviderCardSkeleton provider={provider} />
            )}
          </StaggerItem>
        ))}
      </div>
    );
  }
  if (providers.length === 0) {
    const detected = describeInstalledAgents(installed);
    return (
      <StaggerItem delay={delayBase}>
        <div className="flex items-center justify-center rounded-xl border border-dashed border-black/10 px-4 py-8 text-center dark:border-white/10">
          <div className="space-y-1">
            <div className="text-[12px] font-medium">No agents enabled</div>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {detected
                ? `Turn on ${detected} in Settings.`
                : "Install Claude Code, Codex, or Cursor to start."}
            </div>
          </div>
        </div>
      </StaggerItem>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <StaggerItem delay={delayBase}>
        <GroupLabel>Plan limits</GroupLabel>
      </StaggerItem>
      {providers.map((p, i) => (
        <StaggerItem key={p.provider} delay={delayBase + 50 * (i + 1)}>
          {p.provider === "cursor" ? <CursorCard usage={p} /> : <ProviderCard usage={p} />}
        </StaggerItem>
      ))}
    </div>
  );
}

function ProviderChip({ provider }: { provider: UsageProvider }) {
  const accent = providerAccent(provider);
  return (
    <span
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
        accent.chip,
      )}
    >
      <ProviderIcon provider={provider} size={12} className={accent.text} />
    </span>
  );
}

export type Status = "healthy" | "close" | "out";

export const CLOSE_PCT = 70;
export const OUT_PCT = 85;

/** Worst window decides: under 70% healthy, 70–84 getting close, 85+ out. */
export function providerStatus(p: ProviderUsage): Status | null {
  const pcts = limitWindows(p)
    .map(({ w }) => w.usedPercent)
    .filter((v): v is number => v != null);
  if (pcts.length === 0) return null;
  const worst = Math.max(...pcts);
  if (worst >= OUT_PCT) return "out";
  if (worst >= CLOSE_PCT) return "close";
  return "healthy";
}

const STATUS_PILL: Record<Status, { label: string; className: string }> = {
  healthy: {
    label: "Healthy",
    className: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  close: {
    label: "Getting close",
    className: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
  },
  out: {
    label: "Almost out",
    className: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  },
};

function ProviderCard({ usage }: { usage: ProviderUsage }) {
  const name = providerLabel(usage.provider);
  const status = providerStatus(usage);
  const secondary = providerAccentSecondary(usage.provider);
  // Per-model weekly limits (Claude's Fable) sit behind a chevron to keep the
  // card short. One that's getting close, or is the limit currently holding
  // the account, opens on its own so a hidden meter can't be the one about
  // to run out.
  const modelLimits = usage.modelLimits ?? [];
  const modelPressing = modelLimits.some(
    (l) => l.isActive || (l.window.usedPercent ?? 0) >= CLOSE_PCT,
  );
  const [showModels, setShowModels] = useState(false);
  const modelsOpen = showModels || modelPressing;
  const modelNames = modelLimits.map((l) => l.model).join(", ");
  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2.5", cardSurface)}>
      <div className="flex items-center gap-2">
        <ProviderChip provider={usage.provider} />
        <span className="text-[13px] font-semibold">{name}</span>
        {usage.plan && (
          <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {capitalize(usage.plan)} plan
          </span>
        )}
        <span className="flex-1" />
        {status && (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
              STATUS_PILL[status].className,
            )}
          >
            {STATUS_PILL[status].label}
          </span>
        )}
        {modelLimits.length > 0 && !modelPressing && (
          <button
            type="button"
            aria-expanded={modelsOpen}
            title={modelsOpen ? `Hide ${modelNames} limit` : `Show ${modelNames} limit`}
            aria-label={modelsOpen ? `Hide ${modelNames} limit` : `Show ${modelNames} limit`}
            onClick={() => setShowModels((v) => !v)}
            className="-mr-1 grid size-[22px] shrink-0 place-items-center rounded-md text-zinc-500 transition hover:bg-black/[0.06] hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-200"
          >
            <ChevronDown
              size={14}
              strokeWidth={2}
              className={cn("transition-transform duration-200", modelsOpen && "rotate-180")}
            />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3.5">
        <Meter
          label="This session"
          usage={usage.fiveHour}
          accent={providerAccent(usage.provider)}
          tooltip={`Rolling 5-hour window tied to your ${name} plan's session limit.`}
        />
        <Meter
          label="This week"
          usage={usage.weekly}
          accent={secondary}
          tooltip={`Rolling 7-day window tied to your ${name} plan's weekly limit. It won't match the Costs page's "Last 7 days", which counts calendar days across all tools.`}
        />
        {modelsOpen && modelLimits.map((l) => (
          <Meter
            key={l.model}
            label={`This week · ${l.model}`}
            usage={l.window}
            accent={secondary}
            tooltip={`A separate weekly limit for ${l.model} models. It fills on its own and can run out before the all-models week${l.isActive ? ", and it's the limit holding your account right now" : ""}.`}
          />
        ))}
      </div>
    </div>
  );
}

function Meter({
  label,
  usage,
  accent,
  tooltip,
}: {
  label: string;
  usage: UsageWindow;
  accent: Accent;
  tooltip: string;
}) {
  const pct = usage.usedPercent != null ? clamp(usage.usedPercent, 0, 100) : null;
  const caption =
    pct == null
      ? usage.tokens > 0
        ? `${formatCount(usage.tokens)} tokens used`
        : "No data yet"
      : resetLabel(usage.resetsAt);
  return (
    <div title={tooltip} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="text-[13px] font-semibold tabular-nums">
          {pct != null ? `${pct.toFixed(0)}%` : "—"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.05]">
        {pct != null && (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", accent.bar)}
            style={{ width: `${Math.max(pct, 1.5)}%` }}
          />
        )}
      </div>
      <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
        {caption || " "}
      </span>
    </div>
  );
}

function CursorCard({ usage }: { usage: ProviderUsage }) {
  const w = usage.fiveHour;
  const pct = w.usedPercent != null ? clamp(w.usedPercent, 0, 100) : null;
  // With the cursor.com read on, the headline is plan usage for the billing
  // period; otherwise it's the most active chat's context fill.
  const plan = w.resetsAt != null;
  const caption =
    pct == null
      ? "Send a message in Cursor to see how full the chat is"
      : plan
        ? `${pct.toFixed(0)}% of this billing period's plan used`
        : `Current chat is ${pct.toFixed(0)}% full`;
  return (
    <div className={cn("flex items-center gap-2 px-3 py-2.5", cardSurface)}>
      <ProviderChip provider="cursor" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">Cursor</div>
        <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</div>
      </div>
      <div className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.05]">
        {pct != null && (
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              providerAccent("cursor").bar,
            )}
            style={{ width: `${Math.max(pct, 1.5)}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** `ProviderCard` with its data blanked: the chip, name and meter labels are
 *  known up front, so only the plan, status and numbers shimmer. */
function ProviderCardSkeleton({ provider }: { provider: UsageProvider }) {
  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2.5", cardSurface)}>
      <div className="flex items-center gap-2">
        <ProviderChip provider={provider} />
        <span className="text-[13px] font-semibold">{providerLabel(provider)}</span>
        <Skeleton className="h-2.5 w-14" />
        <span className="flex-1" />
        <Skeleton className="h-[18px] w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-2 gap-3.5">
        <MeterSkeleton label="This session" />
        <MeterSkeleton label="This week" />
      </div>
    </div>
  );
}

function MeterSkeleton({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[12px] text-zinc-700 dark:text-zinc-300">{label}</span>
        <Skeleton className="h-3 w-7" />
      </div>
      <Skeleton className="h-1.5 rounded-full" />
      <div className="flex items-center text-[11px]">
        <Skeleton className="h-2.5 w-20" />
        <span className="invisible">&nbsp;</span>
      </div>
    </div>
  );
}

function CursorCardSkeleton() {
  return (
    <div className={cn("flex items-center gap-2 px-3 py-2.5", cardSurface)}>
      <ProviderChip provider="cursor" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold">Cursor</div>
        <div className="flex items-center text-[11px]">
          <Skeleton className="h-2.5 w-40" />
          <span className="invisible">&nbsp;</span>
        </div>
      </div>
      <Skeleton className="h-1.5 w-20 shrink-0 rounded-full" />
    </div>
  );
}

// ── Running now ──────────────────────────────────────────────────────

/**
 * Live agent sessions with how full each one's context window is. These are
 * per-conversation, unlike the account-wide plan limits above. Takes the
 * leftover height and scrolls on its own so a busy machine can't push the
 * footer off the panel.
 */
function RunningNow({ running, delay }: { running: LiveContext[]; delay: number }) {
  if (running.length === 0) return null;
  return (
    <StaggerItem delay={delay} className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex items-baseline justify-between px-0.5">
        <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">
          Running now · {running.length}
        </span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">Chat memory used</span>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {running.map((c) => (
          <RunningRow key={`${c.agent}:${c.sessionId}`} ctx={c} />
        ))}
      </ul>
    </StaggerItem>
  );
}

function RunningRow({ ctx }: { ctx: LiveContext }) {
  const title = contextTitle(ctx);
  const folder = contextFolder(ctx);
  const distinctFolder = folder && folder !== title ? folder : null;
  const busy = ctx.status === "busy";
  const full = ctx.usedPercent != null && ctx.usedPercent >= CONTEXT_DANGER_PCT;
  const state = busy ? "Working" : ctx.status === "idle" ? "Idle" : null;
  const subline = full
    ? "Almost full — start a new chat soon"
    : [state, distinctFolder].filter(Boolean).join(" · ") || providerLabel(ctx.agent);
  return (
    <li
      title={[
        title,
        distinctFolder,
        ctx.pid != null ? `PID ${ctx.pid}` : null,
        formatContextTokens(ctx),
      ]
        .filter(Boolean)
        .join(" · ")}
      className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          busy ? "animate-pulse bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600",
        )}
      />
      <ProviderIcon
        provider={ctx.agent}
        size={11}
        className={cn("shrink-0", providerAccent(ctx.agent).text)}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px]">{title}</div>
        <div
          className={cn(
            "truncate text-[11px]",
            full ? "text-rose-700 dark:text-rose-300" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          {subline}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 text-right text-[12px] font-semibold tabular-nums",
          contextPctClass(ctx.usedPercent),
        )}
      >
        {formatContextPct(ctx)}
      </span>
    </li>
  );
}

// ── Footer ───────────────────────────────────────────────────────────

function Footer({ today, thirty }: { today: number | null; thirty: number | null }) {
  return (
    <div className="flex items-center gap-2 border-t border-black/[0.06] px-3 py-2.5 dark:border-white/[0.06]">
      {/* Estimated spend across all tools by local calendar day — broader
          than the per-provider plan limits, so the two won't add up. */}
      <div
        title="Estimated spend across all tools, by calendar day. Plan limits above track each provider's rolling window separately, so the numbers won't match."
        className="min-w-0 flex-1 pl-1"
      >
        <div className="truncate">
          <span className="text-[13px] font-semibold tabular-nums">
            {today != null ? formatUsd(today) : "—"}
          </span>{" "}
          <span className="text-[12px] text-zinc-500 dark:text-zinc-400">spent today</span>
        </div>
        <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          <span className="tabular-nums">{thirty != null ? formatUsd(thirty) : "—"}</span> in the
          last 30 days
        </div>
      </div>
      <button
        type="button"
        onClick={() => void api.openMainWindow()}
        className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-[12px] font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Open LunoPeak
      </button>
      <button
        type="button"
        title="Quit LunoPeak"
        aria-label="Quit LunoPeak"
        onClick={() => void api.quitApp()}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-600 transition hover:bg-black/[0.06] dark:text-zinc-400 dark:hover:bg-white/[0.08]"
      >
        <Power size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2h 10m", "45m". */
function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function weekday(d: Date): string {
  return d.toLocaleDateString([], { weekday: "long" });
}

/** Meter caption: "Resets in 2h 10m" within a day, else "Resets Monday". */
export function resetLabel(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const diff = resetsAt * 1000 - Date.now();
  if (diff <= 0) return "Resetting now";
  if (diff < DAY_MS) return `Resets in ${duration(diff)}`;
  return `Resets ${weekday(new Date(resetsAt * 1000))}`;
}

/** Banner tail: " It resets at 3:40 PM, in 2h 10m." (leading space included). */
export function resetSentence(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt * 1000);
  const diff = at.getTime() - Date.now();
  if (diff <= 0) return " It's resetting now.";
  if (diff < DAY_MS) return ` It resets at ${clock(at)}, in ${duration(diff)}.`;
  return ` It resets ${weekday(at)} at ${clock(at)}.`;
}

/** "just now", "3m ago", "2h ago". */
function updatedAgo(at: number, now: number): string {
  const sec = Math.max(0, (now - at) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/// Sum the last `days` entries of `byDay` (oldest → newest); the trailing
/// value is "today", so `days=1` reads the most recent bucket.
function costFor(byDay: number[] | undefined, days: number): number {
  if (!byDay || byDay.length === 0) return 0;
  return byDay.slice(-days).reduce((sum, v) => sum + v, 0);
}
