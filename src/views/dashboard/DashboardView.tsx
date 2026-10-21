import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FilePlus,
  FolderPlus,
  GitBranch,
  LayoutGrid,
  MessageSquare,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useOnline } from "@/hooks/useOnline";
import { Card, Page, PageHeader } from "@/components/ui/Page";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState } from "@/components/ui/PageStates";
import { Pill } from "@/components/ui/Pill";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import {
  CONTEXT_DANGER_PCT,
  contextFolder,
  contextPctClass,
  contextTitle,
  formatContextPct,
  shortModel,
} from "@/components/ui/ContextMeter";
import { formatCount, formatRelativeTime, formatUsd, plural } from "@/lib/format";
import { cn, openExternal } from "@/lib/utils";
import { toast } from "@/stores/toastStore";
import { confirm } from "@/stores/confirmStore";
import type { LiveContext, ProviderUsage, Repo } from "@/types/api";
import { providerAccent, providerLabel } from "@/views/tray-panel/shared";
import {
  CLOSE_PCT,
  OUT_PCT,
  limitWindows,
  resetSentence,
} from "@/views/tray-panel/TrayPanelView";
import { SESSION_STATE_LABEL, basename, sessionState, type SessionState } from "@/views/live/describe";
import { DashboardSkeleton } from "./DashboardSkeleton";
import { SwapGrid, type SwapGridItem } from "./SwapGrid";
import { PlanLimitsCard } from "./PlanLimitsCard";
import { AttentionCard, type AttentionItem } from "./AttentionCard";

/** Steady time-of-day greeting in the user's local timezone. */
function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Pull the first space-delimited token, trimmed. Empty → null. */
function firstNameFrom(name: string | null | undefined): string | null {
  if (!name) return null;
  const first = name.trim().split(/\s+/)[0];
  return first || null;
}

interface ActivityTrend {
  today: number;
  last7: number;
  delta: number | null;
  max: number;
}

function computeActivityTrend(activity: number[]): ActivityTrend {
  const last7 = activity.slice(-7).reduce((a, b) => a + b, 0);
  const prev7 = activity.slice(-14, -7).reduce((a, b) => a + b, 0);
  return {
    today: activity.at(-1) ?? 0,
    last7,
    delta: prev7 > 0 ? (last7 - prev7) / prev7 : null,
    max: Math.max(1, ...activity),
  };
}

/** Median of the days before today that had any spend, or null without enough history. */
function typicalDay(byDay: number[]): number | null {
  const prior = byDay.slice(0, -1).filter((v) => v > 0).sort((a, b) => a - b);
  if (prior.length < 3) return null;
  const mid = Math.floor(prior.length / 2);
  return prior.length % 2 ? prior[mid] : (prior[mid - 1] + prior[mid]) / 2;
}

/** "$9" for round-ish amounts, "$4.20" under ten dollars. */
function aboutUsd(n: number): string {
  return n >= 10 ? `$${Math.round(n).toLocaleString()}` : formatUsd(n);
}

/** "session limit", "weekly limit", "weekly Fable limit", "plan limit". */
function limitNoun(scope: string): string {
  if (scope === "this session") return "session limit";
  if (scope === "this week") return "weekly limit";
  const model = scope.match(/^this week's (.+) limit$/);
  if (model) return `weekly ${model[1]} limit`;
  return "plan limit";
}

function listNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

function go(hash: string) {
  window.location.hash = hash;
}

export function DashboardView() {
  const qc = useQueryClient();
  const summary = useQuery(queries.dashboardSummary);
  const repos = useQuery(queries.repos);
  const username = useQuery(queries.username);
  const settings = useQuery(queries.settings);
  const online = useOnline();
  const usageLimits = useQuery({ ...queries.usageLimits, enabled: online });
  // Share the /live view's queries so counts update on the same cadence and
  // navigating between the two is instant.
  const activeProcesses = useQuery({ ...queries.activeProcesses, refetchInterval: 5_000 });
  const liveContexts = useQuery({ ...queries.liveContexts, refetchInterval: 5_000 });
  const sessions = useQuery(queries.sessions);
  const costs = useQuery(queries.costs);
  const ports = useQuery(queries.listeningPorts);
  const [addingClaudeMd, setAddingClaudeMd] = useState(false);
  const [editing, setEditing] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const showSkeleton = useDelayedLoading(summary.isLoading || repos.isLoading);
  if (showSkeleton) return <DashboardSkeleton />;

  if (summary.isError && repos.isError) {
    return (
      <Page>
        <PageHeader title="Home" />
        <ErrorState
          title="Home couldn't load"
          body="LunoPeak couldn't read your repos or session logs."
          onRetry={() => {
            void summary.refetch();
            void repos.refetch();
          }}
          error={summary.error}
        />
      </Page>
    );
  }

  const data = summary.data ?? {
    totalRepos: 0,
    activeSessions: 0,
    totalCostUsd: 0,
    uncommittedRepos: 0,
    activity30d: Array(30).fill(0) as number[],
  };
  const allRepos = repos.data ?? [];

  const firstName = firstNameFrom(username.data);
  const title = `${greetingFor(new Date().getHours())}${firstName ? `, ${firstName}` : ""}`;

  if (settings.data && settings.data.scanDirs.length === 0 && data.totalRepos === 0) {
    return (
      <Page>
        <PageHeader title={title} />
        <EmptyState
          icon={FolderPlus}
          title="Welcome to LunoPeak"
          body="Add the folder where you keep your projects. LunoPeak finds your repos and starts tracking agent sessions, limits and costs."
          primary={{ label: "Add project folder", onClick: () => go("#/settings") }}
        />
      </Page>
    );
  }

  const now = Date.now();
  const contexts = liveContexts.data ?? [];
  const states = contexts.map((c) => sessionState({ status: c.status, lastTs: c.lastTs, now }));
  const agents = activeProcesses.data?.length ?? data.activeSessions;
  const working = states.filter((s) => s === "working").length;
  const waiting = states.filter((s) => s === "waiting").length;

  const byDay = costs.data?.byDay ?? [];
  const costToday = Math.max(0, byDay.at(-1) ?? 0);
  const typical = typicalDay(byDay);
  const costThisMonth = byDay
    .slice(Math.max(0, byDay.length - new Date().getDate()))
    .reduce((a, b) => a + b, 0);
  const monthlyBudget = settings.data?.costBudget.monthlyUsd ?? 0;
  const alertPct = settings.data?.costBudget.alertThresholdPct ?? 80;
  const lastChange = allRepos.reduce<number | null>(
    (max, r) => (r.lastActivityTs != null && (max == null || r.lastActivityTs > max) ? r.lastActivityTs : max),
    null,
  );

  const missingClaudeMd = allRepos.filter((r) => !r.hasClaudeMd);
  const addClaudeMd = async (targets: Repo[]) => {
    if (targets.length > 1) {
      const ok = await confirm({
        title: `Add CLAUDE.md to ${plural(targets.length, "repo")}?`,
        body: "LunoPeak writes a starter CLAUDE.md in each repo for you to fill in. Nothing else changes.",
        items: targets.map((r) => r.name),
        confirmLabel: `Add to ${plural(targets.length, "repo")}`,
      });
      if (!ok) return;
    }
    setAddingClaudeMd(true);
    const results = await Promise.allSettled(targets.map((r) => api.createClaudeMd(r.path)));
    setAddingClaudeMd(false);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    const added = results.length - failed.length;
    if (failed.length === 0) {
      toast.success(
        added === 1 ? "CLAUDE.md added" : `Added CLAUDE.md to ${added} repos`,
        added === 1 ? `Starter file written in ${targets[0].name}.` : undefined,
      );
    } else {
      toast.error(
        added === 0 ? "Couldn't add CLAUDE.md" : `Added ${added} of ${results.length}`,
        String(failed[0].reason),
      );
    }
    // Refresh the queries that drive the hygiene flags.
    void qc.invalidateQueries({ queryKey: queries.repos.queryKey });
    void qc.invalidateQueries({ queryKey: queries.dashboardSummary.queryKey });
  };

  const attention = buildAttention({
    providers: usageLimits.data?.providers ?? [],
    contexts,
    repos: allRepos,
    addClaudeMd: () => void addClaudeMd(missingClaudeMd),
    addingClaudeMd,
  });

  return (
    <Page>
      <PageHeader
        title={title}
        lead={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            </span>
            <span className="text-zinc-300 dark:text-zinc-600">·</span>
            {agents > 0 ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-400">
                <span className="size-[7px] rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
                {plural(agents, "agent")} working
              </span>
            ) : (
              <span>No agents running</span>
            )}
          </span>
        }
        actions={
          editing ? (
            <>
              <Button variant="ghost" onClick={() => setResetKey((k) => k + 1)} title="Put cards back in their default order">
                <RotateCcw size={13} strokeWidth={2} />
                Reset
              </Button>
              <Button variant="primary" onClick={() => setEditing(false)}>
                Done
              </Button>
            </>
          ) : (
            <Button onClick={() => setEditing(true)} title="Drag cards to rearrange Home">
              <LayoutGrid size={13} strokeWidth={2} />
              Customize
            </Button>
          )
        }
      />

      {summary.isError && (
        <ErrorState
          title="Some of Home couldn't load"
          body="The activity summary didn't load. Everything else is up to date."
          onRetry={() => void summary.refetch()}
          error={summary.error}
        />
      )}

      <AttentionCard items={attention} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Agents working"
          value={agents}
          to="#/live"
          hint={
            [working > 0 && `${working} busy`, waiting > 0 && `${waiting} waiting for you`]
              .filter(Boolean)
              .join(", ") || (agents > 0 ? "All quiet right now" : "Nothing running right now")
          }
        />
        <StatCard
          label="Spent today"
          value={costs.data ? formatUsd(costToday) : "—"}
          to="#/costs"
          hint={typical != null ? `A typical day is about ${aboutUsd(typical)}` : "Not enough history for a typical day yet"}
        />
        <StatCard
          label="Spent this month"
          value={costs.data ? aboutUsd(Math.max(0, costThisMonth)) : "—"}
          to="#/costs"
          hint={
            monthlyBudget > 0 ? (
              <BudgetBar spent={costThisMonth} budget={monthlyBudget} alertPct={alertPct} />
            ) : (
              "No monthly budget set"
            )
          }
        />
        <StatCard
          label="Repos tracked"
          value={data.totalRepos}
          to="#/repos"
          hint={lastChange != null ? `Last change ${formatRelativeTime(lastChange)}` : "No changes yet"}
        />
      </div>

      <SwapGrid
        editing={editing}
        resetKey={resetKey}
        storageKey="lunopeak.dashboard.middle-order.v2"
        className="grid grid-cols-1 gap-3 md:grid-cols-2"
        stretch
        items={[
          { id: "limits", node: <PlanLimitsCard id="plan-limits" /> },
          { id: "running", node: <RunningNowCard contexts={contexts} states={states} /> },
        ] satisfies SwapGridItem[]}
      />

      <ActivityCard activity={data.activity30d} />

      <SwapGrid
        editing={editing}
        resetKey={resetKey}
        storageKey="lunopeak.dashboard.lists-order.v2"
        className="grid grid-cols-1 gap-3 md:grid-cols-3"
        stretch
        items={[
          {
            id: "sessions",
            node: (
              <ListCard title="Recent sessions" href="#/sessions" empty="No sessions yet.">
                {(sessions.data ?? []).slice(0, 4).map((s) => (
                  <ListRow key={s.id}>
                    <div className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">
                        {s.projectName ?? "Untitled session"}
                      </span>
                      <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                        {[shortModel(s.model), s.branch].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-px">
                      <span className="text-[12.5px] tabular-nums text-zinc-900 dark:text-zinc-100">
                        {formatUsd(s.costUsd)}
                      </span>
                      <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                        {formatRelativeTime(s.endTs)}
                      </span>
                    </div>
                  </ListRow>
                ))}
              </ListCard>
            ),
          },
          {
            id: "repos",
            node: (
              <ListCard
                title="Recently active repos"
                href="#/repos"
                empty="No tracked repos yet. Add a project folder in Settings."
              >
                {allRepos
                  .filter((r) => r.lastActivityTs != null)
                  .sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0))
                  .slice(0, 4)
                  .map((r) => (
                    <ListRow key={r.id}>
                      <div className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{r.name}</span>
                        <span className="truncate font-mono text-[11.5px] text-zinc-500 dark:text-zinc-400">
                          {r.branch ?? "no branch"}
                        </span>
                      </div>
                      {r.hasUncommitted && <Pill tone="blue">Changed</Pill>}
                      <span className="w-16 shrink-0 text-right text-[11.5px] text-zinc-500 dark:text-zinc-400">
                        {r.lastActivityTs ? formatRelativeTime(r.lastActivityTs) : "—"}
                      </span>
                    </ListRow>
                  ))}
              </ListCard>
            ),
          },
          {
            id: "ports",
            node: (
              <ListCard title="Open ports" href="#/ports" empty="No listening ports right now.">
                {(ports.data ?? [])
                  .slice()
                  .sort((a, b) => a.port - b.port)
                  .slice(0, 4)
                  .map((p) => (
                    <ListRow key={`${p.pid}-${p.port}`}>
                      <span className="w-11 shrink-0 text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {p.port}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{p.process}</span>
                        <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                          {basename(p.cwd) ?? "System"}
                        </span>
                      </div>
                      {p.cwd && (
                        <Button variant="link" onClick={() => openExternal(`http://localhost:${p.port}`)}>
                          Open
                        </Button>
                      )}
                    </ListRow>
                  ))}
              </ListCard>
            ),
          },
        ] satisfies SwapGridItem[]}
      />
    </Page>
  );
}

function buildAttention({
  providers,
  contexts,
  repos,
  addClaudeMd,
  addingClaudeMd,
}: {
  providers: ProviderUsage[];
  contexts: LiveContext[];
  repos: Repo[];
  addClaudeMd: () => void;
  addingClaudeMd: boolean;
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  // Urgent: the most pressing plan-limit window per provider at 70%+.
  for (const p of providers) {
    let worst: { scope: string; pct: number; resetsAt: number | null } | null = null;
    for (const { scope, w } of limitWindows(p)) {
      if (w.usedPercent == null || w.usedPercent < CLOSE_PCT) continue;
      if (!worst || w.usedPercent > worst.pct) worst = { scope, pct: w.usedPercent, resetsAt: w.resetsAt };
    }
    if (!worst) continue;
    const name = providerLabel(p.provider);
    const out = worst.pct >= OUT_PCT;
    items.push({
      id: `limit-${p.provider}`,
      urgent: true,
      tone: out ? "rose" : "amber",
      Icon: TriangleAlert,
      title: out
        ? `${name} is almost out of its ${limitNoun(worst.scope)}`
        : `${name} is getting close to its ${limitNoun(worst.scope)}`,
      detail: `${Math.round(worst.pct)}% used.${resetSentence(worst.resetsAt)}`,
      action: {
        label: "View limits",
        onClick: () =>
          document.getElementById("plan-limits")?.scrollIntoView({ behavior: "smooth", block: "center" }),
      },
    });
  }

  // Urgent: chats close to running out of context.
  for (const c of contexts) {
    if (c.usedPercent == null || c.usedPercent < CONTEXT_DANGER_PCT) continue;
    const folder = contextFolder(c);
    items.push({
      id: `chat-${c.agent}-${c.sessionId}`,
      urgent: true,
      tone: "rose",
      Icon: MessageSquare,
      title: `“${contextTitle(c)}” chat is ${Math.round(c.usedPercent)}% full`,
      detail: `Start a new chat soon so ${providerLabel(c.agent)} keeps its full context.${folder ? ` In ${folder}.` : ""}`,
      action: { label: "Open session", onClick: () => go("#/live") },
    });
  }

  const dirty = repos.filter((r) => r.hasUncommitted);
  if (dirty.length > 0) {
    items.push({
      id: "uncommitted",
      urgent: false,
      tone: "blue",
      Icon: GitBranch,
      title:
        dirty.length === 1
          ? "1 repo has changes that aren't committed"
          : `${dirty.length} repos have changes that aren't committed`,
      detail: listNames(dirty.map((r) => r.name)),
      action: { label: "Review", onClick: () => go("#/repos?filter=dirty") },
    });
  }

  const missing = repos.filter((r) => !r.hasClaudeMd);
  if (missing.length > 0) {
    items.push({
      id: "claude-md",
      urgent: false,
      tone: "neutral",
      Icon: FilePlus,
      title:
        missing.length === 1 ? "1 repo doesn't have a CLAUDE.md" : `${missing.length} repos don't have a CLAUDE.md`,
      detail: `Agents follow project instructions better with one. ${listNames(missing.map((r) => r.name))}`,
      action: { label: addingClaudeMd ? "Adding…" : "Add CLAUDE.md", onClick: addClaudeMd, pending: addingClaudeMd },
    });
  }

  return items;
}

function BudgetBar({ spent, budget, alertPct }: { spent: number; budget: number; alertPct: number }) {
  const pct = Math.max(0, (spent / budget) * 100);
  return (
    <span className="flex items-center gap-2" title={`${Math.round(pct)}% of your monthly budget`}>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.08]">
        <span
          className={cn(
            "block h-full rounded-full",
            pct >= 100 ? "bg-rose-500" : pct >= alertPct ? "bg-amber-500" : "bg-emerald-500",
          )}
          style={{ width: `${Math.min(100, Math.max(pct, 1.5))}%` }}
        />
      </span>
      of {aboutUsd(budget)} budget
    </span>
  );
}

const STATE_DOT: Record<SessionState, string> = {
  working: "bg-emerald-500",
  waiting: "bg-blue-500",
  idle: "bg-zinc-300 dark:bg-zinc-600",
};

function RunningNowCard({ contexts, states }: { contexts: LiveContext[]; states: SessionState[] }) {
  return (
    <Card className="flex flex-col gap-2 px-2.5 pb-2.5 pt-3.5">
      <div className="flex items-baseline gap-2 px-2">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Running now</span>
        {contexts.length > 0 && <span className="text-xs text-zinc-500 dark:text-zinc-400">Chat memory used</span>}
      </div>
      {contexts.length === 0 ? (
        <p className="m-0 px-2 py-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">No agents running right now.</p>
      ) : (
        <div className="flex flex-col">
          {contexts.slice(0, 6).map((c, i) => {
            const full = c.usedPercent != null && c.usedPercent >= CONTEXT_DANGER_PCT;
            const folder = contextFolder(c);
            const title = contextTitle(c);
            return (
              <div
                key={`${c.agent}:${c.sessionId}`}
                className="flex items-center gap-2.5 rounded-[9px] p-2 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <span className={cn("size-[7px] shrink-0 rounded-full", STATE_DOT[states[i]])} />
                <ProviderIcon provider={c.agent} size={13} className={cn("shrink-0", providerAccent(c.agent).text)} />
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{title}</span>
                  <span
                    className={cn(
                      "truncate text-xs",
                      full ? "text-rose-700 dark:text-rose-300" : "text-zinc-500 dark:text-zinc-400",
                    )}
                  >
                    {full
                      ? "Almost full. Start a new chat soon."
                      : [SESSION_STATE_LABEL[states[i]], folder !== title ? folder : null].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <span className={cn("text-[13px] font-semibold tabular-nums", contextPctClass(c.usedPercent))}>
                  {formatContextPct(c)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <a
        href="#/live"
        className="mt-auto px-2 pb-0.5 pt-1.5 text-[12.5px] font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        Open Live view →
      </a>
    </Card>
  );
}

function ActivityCard({ activity }: { activity: number[] }) {
  const trend = computeActivityTrend(activity);
  const hasData = activity.some((v) => v > 0);
  const deltaPct = trend.delta == null ? null : Math.round(trend.delta * 100);
  const start = new Date();
  start.setDate(start.getDate() - (activity.length - 1));
  const mid = new Date();
  mid.setDate(mid.getDate() - Math.floor((activity.length - 1) / 2));
  const short = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <Card className="flex flex-col gap-3.5 px-[18px] pb-4 pt-3.5">
      <div className="flex items-baseline gap-5">
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Activity</span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Sessions and commits per day, last 30 days</span>
        </div>
        <ActivityStat value={formatCount(trend.today)} label="today" />
        <ActivityStat value={formatCount(trend.last7)} label="this week" />
        {deltaPct != null && (
          <ActivityStat
            value={`${deltaPct > 0 ? "+" : ""}${deltaPct}%`}
            label="vs last week"
            className={
              deltaPct > 0
                ? "text-emerald-700 dark:text-emerald-400"
                : deltaPct < 0
                  ? "text-rose-700 dark:text-rose-400"
                  : undefined
            }
          />
        )}
      </div>
      {hasData ? (
        <ActivityBars activity={activity} max={trend.max} />
      ) : (
        <p className="m-0 flex h-[130px] items-center justify-center text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No activity in the last 30 days.
        </p>
      )}
      <div className="flex justify-between text-[11.5px] text-zinc-500 dark:text-zinc-400">
        <span>{short(start)}</span>
        <span>{short(mid)}</span>
        <span>Today</span>
      </div>
    </Card>
  );
}

function ActivityStat({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className="flex flex-col items-end">
      <span className={cn("text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100", className)}>
        {value}
      </span>
      <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  );
}

/** 30-day bars with today's (rightmost) bar in green. */
function ActivityBars({ activity, max }: { activity: number[]; max: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const todayMs = new Date().setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  return (
    <div
      className="relative flex h-[130px] items-end gap-1"
      role="img"
      aria-label="30-day activity"
      onMouseLeave={() => setHovered(null)}
    >
      {activity.map((v, i) => {
        const isToday = i === activity.length - 1;
        const daysAgo = activity.length - 1 - i;
        const dateLabel = isToday
          ? "Today"
          : new Date(todayMs - daysAgo * dayMs).toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
        const tooltip = `${dateLabel} · ${v > 0 ? formatCount(v) : "nothing"}`;
        return (
          <div
            key={i}
            className="relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHovered(i)}
            onFocus={() => setHovered(i)}
            onBlur={() => setHovered(null)}
            tabIndex={0}
            aria-label={tooltip}
          >
            <div
              className={cn(
                "w-full origin-bottom animate-chart-bar-grow rounded-t-[3px] transition-opacity",
                hovered !== null && hovered !== i && "opacity-60",
                isToday ? "bg-emerald-500" : v === 0 ? "bg-zinc-300/60 dark:bg-zinc-700/50" : "bg-blue-500/70",
              )}
              style={{ height: `${Math.max(3, (v / max) * 100)}%`, animationDelay: `${Math.min(i * 12, 400)}ms` }}
            />
            {hovered === i && (
              <div
                className={cn(
                  "pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap rounded-md border border-black/[0.08] bg-white px-2 py-1 text-[11.5px] text-zinc-800 shadow-md",
                  "dark:border-white/[0.08] dark:bg-zinc-900 dark:text-zinc-100",
                  i > activity.length - 6 ? "right-0" : "left-1/2 -translate-x-1/2",
                )}
              >
                {tooltip}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ListCard({
  title,
  href,
  empty,
  children,
}: {
  title: string;
  href: string;
  empty: string;
  children: ReactNode[];
}) {
  return (
    <Card className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-3.5">
      <div className="flex items-baseline px-2">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</span>
        <a href={href} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          See all
        </a>
      </div>
      {children.length === 0 ? (
        <p className="m-0 px-2 py-1.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">{empty}</p>
      ) : (
        children
      )}
    </Card>
  );
}

function ListRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-[7px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      {children}
    </div>
  );
}
