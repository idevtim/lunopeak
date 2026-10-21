import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search } from "lucide-react";
import { sections, settingsRoute, type Route, type RouteId } from "@/routes";
import { queries } from "@/lib/queries";
import { formatTimeUntil } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/hooks/usePlatform";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { useUpdateSettings } from "@/hooks/useUpdateSettings";
import { usePaletteStore } from "@/stores/paletteStore";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { providerAccent, providerLabel } from "@/views/tray-panel/shared";
import type { ProviderUsage, Settings, UsageProvider } from "@/types/api";

interface SidebarProps {
  current: RouteId;
  onNavigate: (id: RouteId) => void;
  /** Reserved space at the top for native traffic lights / window controls. */
  topInset?: number;
}

type BadgeTone = "live" | "blue" | "amber";

/** At or above this, a limit counts as "close" for the Plan usage card. */
const CLOSE_PCT = 70;

export function Sidebar({ current, onNavigate, topInset = 0 }: SidebarProps) {
  const ref = useRef<HTMLElement>(null);
  useWindowDrag(ref);
  const platform = usePlatform();
  // macOS gets extra breathing room below the traffic-light strip so the
  // logo doesn't crowd the controls. Windows / Linux have empty drag space
  // there, so we tuck the logo right up under it.
  const isMac = platform === "macos";
  const { settings, update } = useUpdateSettings();
  const openPalette = usePaletteStore((s) => s.setOpen);

  // Badge sources. Each reuses the cache its view already keeps warm —
  // share the key, don't double-poll.
  const activeProcs = useQuery({ ...queries.activeProcesses, refetchInterval: 5000 });
  const repos = useQuery(queries.repos);
  const hygiene = useQuery(queries.hygiene);
  const badges: Partial<Record<RouteId, { count: number; tone: BadgeTone }>> = {
    live: { count: activeProcs.data?.length ?? 0, tone: "live" },
    repos: { count: repos.data?.filter((r) => r.hasUncommitted).length ?? 0, tone: "blue" },
    hygiene: { count: hygiene.data?.length ?? 0, tone: "amber" },
  };

  const hidden = useMemo(
    () => new Set(settings?.hiddenSidebarItems ?? []),
    [settings?.hiddenSidebarItems],
  );
  const order = settings?.sidebarOrder ?? [];
  const folded = new Set(
    settings?.sidebar?.foldedSections ??
      sections.filter((s) => s.foldedByDefault).map((s) => s.id),
  );

  // Drop hidden items, sort visible items by the user's saved order
  // (within each section), then drop sections that became empty. Routes
  // absent from `order` are appended in their default position.
  const visibleSections = useMemo(() => {
    const orderIndex = (id: RouteId) => {
      const i = order.indexOf(id);
      return i === -1 ? Number.POSITIVE_INFINITY : i;
    };
    return sections
      .map((section) => ({
        ...section,
        routes: section.routes
          .filter((r) => !hidden.has(r.id))
          .slice()
          .sort((a, b) => orderIndex(a.id) - orderIndex(b.id)),
      }))
      .filter((section) => section.routes.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, order.join(",")]);

  // After a section expands, bring its items into view — a section near the
  // bottom of the nav would otherwise open below the fold.
  const navRef = useRef<HTMLElement>(null);
  const [justOpened, setJustOpened] = useState<string | null>(null);
  useEffect(() => {
    // The fold state saves asynchronously; wait until the section is open.
    if (!justOpened || settings?.sidebar?.foldedSections?.includes(justOpened)) return;
    const frame = requestAnimationFrame(() => {
      navRef.current
        ?.querySelector<HTMLElement>(`[data-section="${justOpened}"]`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      setJustOpened(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [justOpened, settings?.sidebar?.foldedSections]);

  const toggleSection = (id: string, open: boolean) => {
    if (!open) setJustOpened(id);
    update((s) => {
      const current = new Set(
        s.sidebar?.foldedSections ?? sections.filter((x) => x.foldedByDefault).map((x) => x.id),
      );
      if (open) current.add(id);
      else current.delete(id);
      return {
        ...s,
        sidebar: { planUsage: s.sidebar?.planUsage ?? "always", foldedSections: [...current] },
      };
    });
  };

  const renderItem = (route: Route) => {
    const badge = badges[route.id];
    return (
      <SidebarItem
        key={route.id}
        route={route}
        active={route.id === current}
        badge={badge && badge.count > 0 ? <ItemBadge {...badge} /> : null}
        onClick={() => onNavigate(route.id)}
      />
    );
  };

  return (
    <aside
      ref={ref}
      className={cn(
        "flex w-[232px] shrink-0 select-none flex-col",
        // Wash on top of the OS vibrancy: still translucent (wallpaper
        // color reads through), but content stops competing with the backdrop.
        // Saturation boost keeps the Tahoe Liquid Glass color signature.
        "bg-zinc-200/[0.92] dark:bg-[#05070f]/85 backdrop-saturate-150 backdrop-blur-xl dark:backdrop-blur-none",
        // Hairline divider + 1px top rim highlight: reads as a glass panel
        // edge instead of an empty translucent rectangle.
        "border-r border-black/[0.08] dark:border-white/[0.06]",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
        // Linux compositors lack a window-level material — paint a solid panel.
        "[[data-platform=linux]_&]:bg-zinc-300/95 dark:[[data-platform=linux]_&]:bg-[#0c1020]/90",
      )}
      style={{ paddingTop: topInset + (isMac ? 0 : -8) }}
    >
      <div className="flex items-center gap-2.5 px-[18px] pb-3 pt-2">
        <img
          src="/app-icon.png"
          alt=""
          draggable={false}
          className="size-7 shrink-0 select-none rounded-[7px]"
        />
        <span className="text-base font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
          Luno<span className="text-[#3a52a8] dark:text-[#8497d4]">Peak</span>
        </span>
      </div>

      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          data-no-drag
          onClick={() => openPalette(true)}
          className="flex w-full items-center gap-2 rounded-[9px] border border-black/[0.08] bg-white/65 py-1.5 pl-2.5 pr-2 text-left text-[12.5px] text-zinc-500 transition-colors hover:bg-white/90 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-zinc-400 dark:hover:bg-white/[0.08]"
        >
          <Search size={14} strokeWidth={2} />
          <span className="flex-1">Go to…</span>
          <kbd className="rounded-[5px] border border-black/[0.08] bg-white px-[5px] font-sans text-[11px] text-zinc-400 dark:border-white/[0.1] dark:bg-white/[0.06]">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      </div>

      <nav ref={navRef} className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-3 [scrollbar-width:none]">
        {visibleSections.map((section) => {
          if (!section.label) {
            return <div key={section.id} className="flex flex-col gap-0.5">{section.routes.map(renderItem)}</div>;
          }
          const hasActive = section.routes.some((r) => r.id === current);
          // A section holding the active route is always open.
          const open = hasActive || !folded.has(section.id);
          const badgeSum = section.routes.reduce((a, r) => a + (badges[r.id]?.count ?? 0), 0);
          const amber = section.routes.some((r) => badges[r.id]?.tone === "amber" && badges[r.id]!.count > 0);
          return (
            <div key={section.id} data-section={section.id} className="flex flex-col gap-0.5 pt-3">
              <button
                type="button"
                data-no-drag
                aria-expanded={open}
                onClick={() => !hasActive && toggleSection(section.id, open)}
                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-[3px] text-left text-xs font-semibold text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <span className="flex-1">{section.label}</span>
                {!open && badgeSum > 0 && (
                  <span
                    className={cn(
                      "text-[11px] font-semibold tabular-nums",
                      amber ? "text-amber-700 dark:text-amber-400" : "text-blue-700 dark:text-blue-400",
                    )}
                  >
                    {badgeSum}
                  </span>
                )}
                <ChevronRight
                  size={12}
                  strokeWidth={2.25}
                  className={cn("text-zinc-400 transition-transform duration-150", open && "rotate-90")}
                />
              </button>
              {open && section.routes.map(renderItem)}
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1 border-t border-black/[0.06] p-2.5 dark:border-white/[0.06]">
        <PlanUsageCard
          settings={settings}
          visible={current !== "dashboard"}
          onOpen={() => onNavigate("dashboard")}
        />
        <SidebarItem
          route={settingsRoute}
          active={current === settingsRoute.id}
          onClick={() => onNavigate(settingsRoute.id)}
        />
      </div>
    </aside>
  );
}

function ItemBadge({ count, tone }: { count: number; tone: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] rounded-full px-[7px] py-px text-[11px] font-semibold tabular-nums",
        tone === "live" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        tone === "blue" && "bg-blue-500/12 text-blue-700 dark:text-blue-300",
        tone === "amber" && "bg-amber-500/15 text-amber-800 dark:text-amber-300",
      )}
    >
      {tone === "live" && <span className="size-1.5 rounded-full bg-emerald-500" />}
      {count}
    </span>
  );
}

interface UsageRow {
  provider: UsageProvider;
  pct: number;
  resetsAt: number | null;
}

/** The higher of a provider's session and weekly percent, with that window's reset. */
function usageRow(p: ProviderUsage): UsageRow | null {
  const windows = [p.fiveHour, p.weekly].filter((w) => w.usedPercent != null);
  if (windows.length === 0) return null;
  const top = windows.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
  return { provider: p.provider, pct: Math.round(top.usedPercent ?? 0), resetsAt: top.resetsAt };
}

const trackedKey: Record<UsageProvider, keyof Settings["agents"]> = {
  claude: "claudeCode",
  codex: "codex",
  cursor: "cursor",
};

/**
 * One row per tracked agent, closest to its limit first. Folds away (grid
 * rows 1fr → 0fr) on Home, when set to Off, or — in "close" mode — while
 * nothing is at 70%+.
 */
function PlanUsageCard({
  settings,
  visible,
  onOpen,
}: {
  settings: Settings | undefined;
  visible: boolean;
  onOpen: () => void;
}) {
  const limits = useQuery(queries.usageLimits);
  const mode = settings?.sidebar?.planUsage ?? "always";
  const rows = (limits.data?.providers ?? [])
    .filter((p) => settings?.agents[trackedKey[p.provider]] ?? true)
    .map(usageRow)
    .filter((r): r is UsageRow => r !== null)
    .sort((a, b) => b.pct - a.pct);
  const anyClose = rows.some((r) => r.pct >= CLOSE_PCT);
  const show =
    visible && rows.length > 0 && mode !== "off" && (mode === "always" || anyClose);

  const top = rows[0];
  const caption =
    top && top.pct >= CLOSE_PCT && top.resetsAt
      ? `${providerLabel(top.provider)} resets in ${formatTimeUntil(top.resetsAt)}`
      : "All limits look fine";

  return (
    <div
      aria-hidden={!show}
      className={cn(
        "grid origin-bottom transition-[grid-template-rows,opacity,transform,margin] duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)]",
        show
          ? "grid-rows-[1fr] opacity-100"
          : "pointer-events-none -mb-1 translate-y-2 scale-[0.98] grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <button
          type="button"
          data-no-drag
          tabIndex={show ? 0 : -1}
          onClick={onOpen}
          className="flex w-full flex-col gap-[7px] rounded-[10px] border border-black/[0.06] bg-white/55 px-2.5 py-[9px] text-left transition-colors hover:bg-white/85 dark:border-white/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.07]"
        >
          <span className="text-[11.5px] font-semibold text-zinc-600 dark:text-zinc-400">Plan usage</span>
          {rows.map((r, i) => {
            const accent = providerAccent(r.provider);
            return (
              <span
                key={r.provider}
                className={cn(
                  "flex items-center gap-[7px] text-xs text-zinc-700 transition-[opacity,transform] dark:text-zinc-300",
                  show ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
                )}
                style={{
                  transitionDuration: "260ms, 360ms",
                  transitionDelay: show ? `${120 + i * 60}ms` : "0ms",
                }}
              >
                <ProviderIcon provider={r.provider} size={12} className={accent.text} />
                <span className="w-[46px]">{providerLabel(r.provider)}</span>
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.08]">
                  <span
                    className={cn("block h-full rounded-full transition-[width] duration-600 ease-[cubic-bezier(.2,.8,.2,1)]", accent.bar)}
                    style={{
                      width: show ? `${Math.min(r.pct, 100)}%` : "0%",
                      transitionDelay: show ? `${180 + i * 60}ms` : "0ms",
                    }}
                  />
                </span>
                <span
                  className={cn(
                    "w-[30px] text-right font-semibold tabular-nums",
                    r.pct >= CLOSE_PCT ? "text-amber-800 dark:text-amber-400" : "text-zinc-700 dark:text-zinc-300",
                  )}
                >
                  {r.pct}%
                </span>
              </span>
            );
          })}
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</span>
        </button>
      </div>
    </div>
  );
}

interface SidebarItemProps {
  route: { id: RouteId; label: string; icon: import("lucide-react").LucideIcon };
  active: boolean;
  badge?: ReactNode;
  onClick: () => void;
}

function SidebarItem({ route, active, badge, onClick }: SidebarItemProps) {
  const Icon = route.icon;
  return (
    <button
      onClick={onClick}
      data-no-drag
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-left text-[13px] transition-[background-color,box-shadow,color] duration-75",
        active
          // Glass capsule: hairline rim + top specular highlight + soft lift.
          ? "bg-black/[0.09] font-medium text-zinc-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.06)] dark:bg-white/[0.12] dark:text-zinc-50 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18),inset_0_1px_0_rgba(255,255,255,0.22),0_1px_2px_rgba(0,0,0,0.30)]"
          : "text-zinc-700 hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-200",
      )}
    >
      <Icon
        size={16}
        strokeWidth={1.75}
        className={cn(
          "shrink-0",
          active
            ? "text-blue-600 dark:text-blue-400"
            : "text-zinc-600 group-hover:text-zinc-800 dark:text-zinc-400 dark:group-hover:text-zinc-300",
        )}
      />
      <span className="flex-1 truncate">{route.label}</span>
      {badge}
    </button>
  );
}
