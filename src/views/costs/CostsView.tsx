import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Coins, PiggyBank } from "lucide-react";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { toast } from "@/stores/toastStore";
import { Page, PageHeader, Card, CardHeader, Mono } from "@/components/ui/Page";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState, ErrorState } from "@/components/ui/PageStates";
import { BarChart, type BarDatum } from "@/components/charts/BarChart";
import { formatCount, formatUsd, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CostBreakdown, ModelUsage } from "@/types/api";
import { CostsSkeleton } from "./CostsSkeleton";
import { modelName, modelTone, monthDay } from "./costFormat";

const PROJECT_ROWS = 3;
const MODEL_ROWS = 4;

export function CostsView() {
  const { navigateTo } = useHashRoute();
  const costs = useQuery(queries.costs);
  const settings = useQuery(queries.settings);
  const showSkeleton = useDelayedLoading(costs.isLoading);

  const editBudget = () => navigateTo("settings", { tab: "alerts" });

  if (costs.isError) {
    return (
      <Page>
        <PageHeader title="Costs" />
        <ErrorState
          title="Couldn’t read your usage logs"
          body="LunoPeak couldn’t open your agent session logs. They may have moved, or LunoPeak needs Full Disk Access."
          onRetry={() => void costs.refetch()}
          error={costs.error}
        />
      </Page>
    );
  }
  if (!costs.data) return showSkeleton ? <CostsSkeleton /> : null;

  const c = costs.data;
  if (c.totalUsd <= 0 && c.byModel.length === 0) {
    return (
      <Page>
        <PageHeader title="Costs" />
        <EmptyState
          icon={Coins}
          title="No spending yet"
          body="Costs appear after your first agent session. Set a budget now to get a warning before you overspend."
          primary={{ label: "Set a budget", onClick: editBudget }}
        />
      </Page>
    );
  }

  return (
    <Body
      c={c}
      monthlyBudget={settings.data?.costBudget.monthlyUsd ?? 0}
      dailyBudget={settings.data?.costBudget.dailyUsd ?? 0}
      onEditBudget={editBudget}
      onOpenRepo={(repo) => navigateTo("cost-detail", { repo })}
      refreshing={costs.isFetching}
      onRefresh={() => void costs.refetch()}
    />
  );
}

function Body({
  c,
  monthlyBudget,
  dailyBudget,
  onEditBudget,
  onOpenRepo,
  refreshing,
  onRefresh,
}: {
  c: CostBreakdown;
  monthlyBudget: number;
  dailyBudget: number;
  onEditBudget: () => void;
  onOpenRepo: (repo: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const days = c.byDay;
  const today = days.at(-1) ?? 0;
  const last7 = sum(days.slice(-7));
  const prev7 = sum(days.slice(-14, -7));

  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - dayOfMonth;
  const monthName = now.toLocaleDateString(undefined, { month: "long" });
  const monthEnd = monthDay(new Date(now.getFullYear(), now.getMonth(), daysInMonth));
  // `byDay` is a rolling 30-day window ending today, so on the 31st the
  // month's first day has already rolled off — it shows as "no data".
  const monthDays = days.slice(-dayOfMonth);
  const monthSpend = sum(monthDays);
  const projection = (monthSpend / dayOfMonth) * daysInMonth;

  // Budget pace: the monthly budget spread evenly, else the daily cap.
  const pace = monthlyBudget > 0 ? monthlyBudget / daysInMonth : dailyBudget;

  // A "typical day" is the median of earlier days that had any spend.
  const typical = median(days.slice(0, -1).filter((v) => v > 0));
  const sessions = c.byModel.reduce((a, m) => a + m.sessions, 0);

  return (
    <Page>
      <PageHeader
        title="Costs"
        lead={
          <Lead
            spent={monthSpend}
            projection={projection}
            budget={monthlyBudget}
            monthEnd={monthEnd}
            daysLeft={daysLeft}
          />
        }
        actions={
          <Button onClick={onEditBudget}>
            {monthlyBudget > 0 || dailyBudget > 0 ? "Edit budget" : "Set a budget"}
          </Button>
        }
      />

      {monthlyBudget > 0 && (
        <BudgetCard
          month={monthName}
          spent={monthSpend}
          projection={projection}
          budget={monthlyBudget}
          daysLeft={daysLeft}
        />
      )}

      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Today"
          value={formatUsd(today)}
          hint={typical > 0 ? `A typical day is about ${formatUsd(typical, typical >= 1000)}` : "Spend so far today"}
        />
        <StatCard
          label="Last 7 days"
          value={formatUsd(last7, true)}
          hint={weekHint(last7, prev7)}
        />
        <StatCard
          label="All time"
          value={formatUsd(c.totalUsd, true)}
          hint={`${plural(sessions, "session")} across ${plural(c.byRepo.length, "project")}`}
        />
      </div>

      <DailyChart
        monthDays={monthDays}
        dayOfMonth={dayOfMonth}
        daysInMonth={daysInMonth}
        pace={pace}
      />

      <div className="grid grid-cols-2 gap-3">
        <ProjectsCard c={c} onOpenRepo={onOpenRepo} />
        <ModelsCard byModel={c.byModel} />
      </div>

      <SpendLess byModel={c.byModel} total={c.totalUsd} hasBudget={monthlyBudget > 0 || dailyBudget > 0} onEditBudget={onEditBudget} />

      <p className="m-0 text-xs text-zinc-500 dark:text-zinc-400">
        Estimates from local session logs, across every agent. Actual billing may differ.{" "}
        <Button variant="link" className="!py-0 text-xs" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </p>
    </Page>
  );
}

function Lead({
  spent,
  projection,
  budget,
  monthEnd,
  daysLeft,
}: {
  spent: number;
  projection: number;
  budget: number;
  monthEnd: string;
  daysLeft: number;
}) {
  const head = (
    <>
      You’ve spent <b>{formatUsd(spent, true)}</b> this month.
    </>
  );
  // Projecting from the last day of the month is just the total.
  if (daysLeft === 0 || spent <= 0) {
    return budget > 0 ? (
      <>
        {head} Your budget is {formatUsd(budget, true)}.
      </>
    ) : (
      head
    );
  }
  const over = budget > 0 && projection > budget;
  const target = (
    <b className={cn(over && "!text-amber-700 dark:!text-amber-400")}>
      {formatUsd(projection, true)} by {monthEnd}
    </b>
  );
  let budgetPhrase = "";
  if (budget > 0) {
    const ratio = projection / budget;
    budgetPhrase =
      ratio > 1.1
        ? `, over your ${formatUsd(budget, true)} budget`
        : ratio > 1
          ? `, just over your ${formatUsd(budget, true)} budget`
          : ratio > 0.9
            ? `, just under your ${formatUsd(budget, true)} budget`
            : `, well under your ${formatUsd(budget, true)} budget`;
  }
  return (
    <>
      {head} At this pace you’ll reach about {target}
      {budgetPhrase}.
    </>
  );
}

function BudgetCard({
  month,
  spent,
  projection,
  budget,
  daysLeft,
}: {
  month: string;
  spent: number;
  projection: number;
  budget: number;
  daysLeft: number;
}) {
  // Scale to whichever is larger so both the budget line and the projected
  // range stay on the bar.
  const scale = Math.max(budget, projection, spent);
  const spentPct = (spent / scale) * 100;
  const projPct = (Math.max(projection, spent) / scale) * 100;
  const budgetPct = (budget / scale) * 100;
  const diff = projection - budget;
  return (
    <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
      <div className="flex items-baseline gap-2.5">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{month} budget</span>
        <span className="text-[13px] text-zinc-600 dark:text-zinc-400">
          <b className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{formatUsd(spent, true)}</b> of{" "}
          {formatUsd(budget, true)} · {daysLeft === 0 ? "last day" : `${plural(daysLeft, "day")} left`}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
        <div
          className="absolute inset-y-0 left-0 origin-left rounded-full bg-gradient-to-r from-amber-500 to-orange-500 animate-chart-bar-grow-x"
          style={{ width: `${spentPct}%` }}
        />
        {projPct > spentPct && (
          <div
            className="absolute inset-y-0 rounded-r-full"
            style={{
              left: `${spentPct}%`,
              width: `${projPct - spentPct}%`,
              background:
                "repeating-linear-gradient(45deg,rgba(249,115,22,0.35) 0 4px,rgba(249,115,22,0.12) 4px 8px)",
            }}
          />
        )}
        <div
          className="absolute -bottom-1 -top-1 w-0.5 -translate-x-1/2 rounded-sm bg-rose-600"
          style={{ left: `${budgetPct}%` }}
          title={`Budget ${formatUsd(budget)}`}
        />
      </div>
      <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>Spent so far</span>
        {daysLeft > 0 && (
          <span className={cn(diff > 0 && "text-amber-700 dark:text-amber-400")}>
            Projected {formatUsd(projection, true)} (
            {diff > 0 ? `+${formatUsd(diff, true)} over` : `${formatUsd(-diff, true)} under`})
          </span>
        )}
      </div>
    </Card>
  );
}

function DailyChart({
  monthDays,
  dayOfMonth,
  daysInMonth,
  pace,
}: {
  monthDays: number[];
  dayOfMonth: number;
  daysInMonth: number;
  pace: number;
}) {
  const now = new Date();
  const dateOf = (day: number) => new Date(now.getFullYear(), now.getMonth(), day);
  // Pad the front if the rolling window doesn't reach day 1, then the days to come.
  const missing = dayOfMonth - monthDays.length;
  const data: BarDatum[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    if (day <= missing || day > dayOfMonth) {
      data.push({ label: "", value: 0, placeholder: true });
      continue;
    }
    const v = monthDays[day - missing - 1] ?? 0;
    const isToday = day === dayOfMonth;
    const label = isToday ? "Today" : monthDay(dateOf(day), true);
    data.push({
      label,
      value: v,
      tooltip: v > 0 ? `${label} · ${formatUsd(v)}` : `${label} · no spend`,
      className: isToday
        ? "bg-amber-500"
        : pace > 0 && v > pace
          ? "bg-orange-500/75"
          : "bg-blue-500/65",
    });
  }

  const spent = monthDays.map((v, i) => ({ v, day: missing + i + 1 })).filter((d) => d.v > 0);
  const biggest = spent.reduce<{ v: number; day: number } | null>(
    (best, d) => (!best || d.v > best.v ? d : best),
    null,
  );
  const abovePace = pace > 0 ? spent.filter((d) => d.v > pace).length : 0;

  const ticks = [
    monthDay(dateOf(1)),
    dayOfMonth > 18 ? monthDay(dateOf(15)) : null,
    "Today",
    dayOfMonth < daysInMonth ? monthDay(dateOf(daysInMonth)) : null,
  ].filter((t): t is string => t !== null);

  return (
    <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Spending per day</span>
        {pace > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="size-2 rounded-[2px] bg-orange-500/75" />
            Above budget pace
          </span>
        )}
      </div>
      <BarChart
        data={data}
        height={150}
        showLabels={false}
        gapClassName="gap-1"
        referenceLine={pace > 0 ? { value: pace, label: `Budget pace ${formatUsd(pace)}/day` } : undefined}
      />
      <div className="flex justify-between text-[11.5px] text-zinc-500 dark:text-zinc-400">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      {biggest && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {monthDay(dateOf(biggest.day))} was your biggest day this month at {formatUsd(biggest.v)}.
          {abovePace > 0 && ` ${plural(abovePace, "day")} went over budget pace.`}
        </span>
      )}
    </Card>
  );
}

function MeterRow({
  label,
  sub,
  pct,
  barClassName,
  value,
  onClick,
  title,
}: {
  label: ReactNode;
  sub?: ReactNode;
  pct: number;
  barClassName: string;
  value: string;
  onClick?: () => void;
  title?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title}
      className={cn(
        "-mx-2 grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_72px] items-center gap-3 rounded-md px-2 py-0.5 text-left",
        onClick && "cursor-pointer transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{label}</span>
        {sub && <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">{sub}</span>}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
        <span
          className={cn("block h-full origin-left rounded-full animate-chart-bar-grow-x", barClassName)}
          style={{ width: `${Math.max(1, pct)}%` }}
        />
      </span>
      <span className="text-right text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
    </Tag>
  );
}

function ProjectsCard({ c, onOpenRepo }: { c: CostBreakdown; onOpenRepo: (repo: string) => void }) {
  const top = c.byRepo.slice(0, PROJECT_ROWS);
  const rest = c.byRepo.slice(PROJECT_ROWS);
  const restUsd = sum(rest.map((r) => r.costUsd));
  const max = Math.max(0.0001, top[0]?.costUsd ?? 0, restUsd);
  return (
    <Card className="flex flex-col pb-4">
      <CardHeader
        title="By project"
        action={
          top[0] && (
            <Button variant="link" className="!py-0 text-xs" onClick={() => onOpenRepo(top[0].repoName)}>
              {top[0].repoName} details
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-2 px-[18px]">
        {top.map((r) => (
          <MeterRow
            key={r.repoName}
            label={<Mono className="text-[12.5px]">{r.repoName}</Mono>}
            pct={(r.costUsd / max) * 100}
            barClassName="bg-blue-500"
            value={formatUsd(r.costUsd)}
            onClick={() => onOpenRepo(r.repoName)}
            title={`${plural(r.sessions, "session")} · ${formatCount(r.messages)} messages`}
          />
        ))}
        {rest.length > 0 && (
          <MeterRow
            label={`${rest.length} ${rest.length === 1 ? "other" : "others"}`}
            pct={(restUsd / max) * 100}
            barClassName="bg-zinc-400"
            value={formatUsd(restUsd)}
          />
        )}
        {top.length === 0 && (
          <span className="text-[13px] text-zinc-500 dark:text-zinc-400">No project costs yet.</span>
        )}
      </div>
    </Card>
  );
}

function ModelsCard({ byModel }: { byModel: ModelUsage[] }) {
  const top = byModel.slice(0, MODEL_ROWS);
  const rest = byModel.slice(MODEL_ROWS);
  const restUsd = sum(rest.map((m) => m.costUsd));
  const max = Math.max(0.0001, top[0]?.costUsd ?? 0, restUsd);
  return (
    <Card className="flex flex-col pb-4">
      <CardHeader title="By model" />
      <div className="flex flex-col gap-2 px-[18px]">
        {top.map((m) => (
          <MeterRow
            key={m.model}
            label={modelName(m.model)}
            sub={plural(m.sessions, "session")}
            title={m.model}
            pct={(m.costUsd / max) * 100}
            barClassName={modelTone(m.model)}
            value={formatUsd(m.costUsd)}
          />
        ))}
        {rest.length > 0 && (
          <MeterRow
            label={`${rest.length} ${rest.length === 1 ? "other" : "others"}`}
            sub={plural(sum(rest.map((m) => m.sessions)), "session")}
            pct={(restUsd / max) * 100}
            barClassName="bg-zinc-400"
            value={formatUsd(restUsd)}
          />
        )}
        <CacheSavingsNote byModel={byModel} />
      </div>
    </Card>
  );
}

/**
 * Fable 5.1 / Mythos 5.1 and Opus 5.5 bill cache reads below the standard
 * 0.1× of input. The dollar figure comes from the Rust pricing module and is
 * already reflected in the totals — this just names it.
 */
function CacheSavingsNote({ byModel }: { byModel: ModelUsage[] }) {
  const discounted = byModel.filter((m) => m.cacheReadSavingsUsd > 0);
  if (discounted.length === 0) return null;
  const saved = sum(discounted.map((m) => m.cacheReadSavingsUsd));
  if (saved < 0.01) return null;
  const cached = sum(discounted.map((m) => m.cacheReadTokens));
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(
    discounted.map((m) => modelName(m.model)),
  );
  return (
    <div
      className="mt-1 flex items-center gap-2 rounded-[9px] bg-emerald-500/[0.08] px-2.5 py-2 text-[12.5px] text-emerald-800 dark:text-emerald-300"
      title={`${formatCount(cached)} cached tokens billed below the standard cache-read rate`}
    >
      <PiggyBank size={14} strokeWidth={1.75} className="shrink-0" />
      Cheaper cache reads on {names} saved you {formatUsd(saved)}.
    </div>
  );
}

interface Suggestion {
  title: string;
  body: string;
  action: { label: string; onClick: () => void };
}

function SpendLess({
  byModel,
  total,
  hasBudget,
  onEditBudget,
}: {
  byModel: ModelUsage[];
  total: number;
  hasBudget: boolean;
  onEditBudget: () => void;
}) {
  const items: Suggestion[] = [];

  // Opus-heavy spend while a cheaper Claude tier exists.
  const opus = byModel.filter((m) => /opus/i.test(m.model));
  const opusUsd = sum(opus.map((m) => m.costUsd));
  const opusShare = total > 0 ? opusUsd / total : 0;
  if (opusShare >= 0.6) {
    items.push({
      title: "Use Sonnet for docs and small fixes",
      body: `Opus made ${Math.round(opusShare * 100)}% of everything you’ve spent. Switching to Sonnet for lighter work costs a fraction per message.`,
      action: {
        label: "Copy /model sonnet",
        onClick: () => {
          void navigator.clipboard
            ?.writeText("/model sonnet")
            .then(() => toast.success("Copied /model sonnet", "Paste it into Claude Code to switch."));
        },
      },
    });
  }

  if (!hasBudget) {
    items.push({
      title: "Set a monthly budget",
      body: "LunoPeak warns you when spending gets close to it, before the month runs away.",
      action: { label: "Set a budget", onClick: onEditBudget },
    });
  }

  if (items.length === 0) return null;
  return (
    <Card className="flex flex-col">
      <CardHeader title="Ways to spend less" />
      <div className="flex flex-col px-[18px] pb-1.5">
        {items.map((s, i) => (
          <div
            key={s.title}
            className={cn(
              "flex items-center gap-3.5 py-2.5",
              i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
            )}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">{s.title}</span>
              <span className="text-[12.5px] text-zinc-600 text-pretty dark:text-zinc-400">{s.body}</span>
            </div>
            <Button onClick={s.action.onClick}>{s.action.label}</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function weekHint(last7: number, prev7: number): string {
  if (prev7 <= 0) return last7 > 0 ? "Nothing the week before" : "No spend this week";
  const delta = (last7 - prev7) / prev7;
  const pct = Math.round(Math.abs(delta) * 100);
  if (pct === 0) return "About the same as the week before";
  return `${pct}% ${delta > 0 ? "more" : "less"} than the week before`;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
