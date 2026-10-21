import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Coins } from "lucide-react";
import { queries } from "@/lib/queries";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { BackLink } from "@/components/ui/BackLink";
import { Page, PageHeader, Card } from "@/components/ui/Page";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { BarChart, type BarDatum } from "@/components/charts/BarChart";
import { formatCount, formatUsd, plural } from "@/lib/format";
import type { CostBucket, RepoCostDetail } from "@/types/api";
import { monthDay, shareOf } from "./costFormat";

type Breakdown = "day" | "session" | "week" | "weekly";

const BREAKDOWNS: { value: Breakdown; label: string }[] = [
  { value: "day", label: "By day" },
  { value: "session", label: "By 5-hour block" },
  { value: "week", label: "By week" },
  { value: "weekly", label: "By 7-day window" },
];

const NOTES: Record<Breakdown, string> = {
  day: "Most recent first.",
  session: "Activity grouped into 5-hour blocks, most recent first.",
  week: "Weeks start on Monday.",
  weekly: "Rolling 7-day windows, like Claude’s weekly limit. Most recent first.",
};

export function CostDetailView() {
  const { params } = useHashRoute();
  const repoKey = params.get("repo") ?? "";
  const detail = useQuery({
    ...queries.repoCostDetail(repoKey),
    enabled: repoKey.length > 0,
  });
  const showSkeleton = useDelayedLoading(detail.isLoading);
  const back = <BackLink fallback="costs" className="font-medium !text-blue-600 dark:!text-blue-400" />;

  if (!repoKey) {
    return (
      <Page>
        <PageHeader above={back} title="Cost details" />
        <EmptyState
          icon={Coins}
          title="No project picked"
          body="Open a project from the By project card on Costs to see what it spent."
        />
      </Page>
    );
  }
  if (detail.isError) {
    return (
      <Page>
        <PageHeader above={back} title={`${repoKey} costs`} />
        <ErrorState
          title={`Couldn’t load costs for ${repoKey}`}
          body="LunoPeak couldn’t read the session logs for this project."
          onRetry={() => void detail.refetch()}
          error={detail.error}
        />
      </Page>
    );
  }
  if (!detail.data) {
    return showSkeleton ? <DetailSkeleton back={back} title={`${repoKey} costs`} /> : null;
  }
  return <Body detail={detail.data} back={back} />;
}

function Body({ detail, back }: { detail: RepoCostDetail; back: React.ReactNode }) {
  const { navigateTo } = useHashRoute();
  const costs = useQuery(queries.costs);
  const [breakdown, setBreakdown] = useState<Breakdown>("day");
  const { totals } = detail;

  // Share of all-project spend over the same trailing 30 days.
  const all30 = (costs.data?.byDay ?? []).reduce((a, b) => a + b, 0);
  const share = all30 > 0 && totals.costUsd > 0 ? shareOf(totals.costUsd, all30) : "";

  const dayData: BarDatum[] = detail.byDay.map((b) => ({
    label: dayLabel(b),
    value: b.costUsd,
    className: isToday(b) ? "bg-amber-500" : "bg-blue-500/65",
    tooltip:
      b.sessions === 0
        ? `${dayLabel(b)} · no activity`
        : `${dayLabel(b)} · ${formatUsd(b.costUsd)} · ${plural(b.sessions, "session")}`,
  }));
  const first = detail.byDay[0];
  const mid = detail.byDay[Math.floor(detail.byDay.length / 2)];

  const buckets: { label: string; b: CostBucket }[] = (() => {
    switch (breakdown) {
      case "day":
        return detail.byDay
          .filter((b) => b.sessions > 0)
          .reverse()
          .map((b) => ({ label: dayLabel(b, true), b }));
      case "session":
        return detail.byFiveHour.map((b) => ({ label: b.label, b }));
      case "week":
        return detail.byWeek
          .filter((b) => b.sessions > 0)
          .map((b) => ({ label: b.startTs <= Date.now() && Date.now() < b.endTs ? "This week" : b.label, b }));
      case "weekly":
        return detail.byWeeklySession.map((b) => ({ label: b.label, b }));
    }
  })();
  const max = Math.max(0.0001, ...buckets.map((x) => x.b.costUsd));

  return (
    <Page>
      <PageHeader
        above={back}
        title={`${detail.repoName} costs`}
        lead={
          totals.costUsd > 0 ? (
            <>
              <b>{formatUsd(totals.costUsd)}</b> in the last 30 days
              {share && `, ${share} everything you spent`}. {plural(totals.sessions, "session")},{" "}
              {plural(totals.messages, "message")}, {formatCount(totals.tokens)} tokens.
            </>
          ) : (
            "Nothing spent in this project in the last 30 days."
          )
        }
        actions={
          detail.repoPath && (
            <Button onClick={() => navigateTo("repo-detail", { path: detail.repoPath! })}>Open repo</Button>
          )
        }
      />

      <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Spending per day</span>
        <BarChart data={dayData} height={130} showLabels={false} gapClassName="gap-1" />
        {first && (
          <div className="flex justify-between text-[11.5px] text-zinc-500 dark:text-zinc-400">
            <span>{monthDay(new Date(first.startTs))}</span>
            {mid && <span>{monthDay(new Date(mid.startTs))}</span>}
            <span>Today</span>
          </div>
        )}
      </Card>

      <Card className="flex flex-col pb-1.5">
        <div className="flex items-center gap-2.5 px-[18px] py-3">
          <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Broken down</span>
          <Segmented value={breakdown} options={BREAKDOWNS} onChange={setBreakdown} ariaLabel="Breakdown" />
        </div>
        <span className="px-[18px] pb-2 text-xs text-zinc-500 dark:text-zinc-400">{NOTES[breakdown]}</span>
        {buckets.length === 0 ? (
          <span className="border-t border-black/[0.04] px-[18px] py-4 text-[13px] text-zinc-500 dark:border-white/[0.05] dark:text-zinc-400">
            No activity in the last 30 days.
          </span>
        ) : (
          buckets.map(({ label, b }) => (
            <div
              key={`${b.startTs}-${b.endTs}`}
              className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_90px_80px] items-center gap-3.5 border-t border-black/[0.04] px-[18px] py-[9px] dark:border-white/[0.05]"
              title={`${formatCount(b.messages)} messages · ${formatCount(b.tokens)} tokens`}
            >
              <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{label}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                <span
                  className="block h-full origin-left rounded-full bg-blue-500 animate-chart-bar-grow-x"
                  style={{ width: `${Math.max(1, (b.costUsd / max) * 100)}%` }}
                />
              </span>
              <span className="text-right text-xs text-zinc-500 dark:text-zinc-400">
                {plural(b.sessions, "session")}
              </span>
              <span className="text-right text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {formatUsd(b.costUsd)}
              </span>
            </div>
          ))
        )}
      </Card>
    </Page>
  );
}

function isToday(b: CostBucket): boolean {
  const now = Date.now();
  return b.startTs <= now && now < b.endTs;
}

/** "Today", "Yesterday", else "Oct 16" (or "Thursday, Oct 16" when `long`). */
function dayLabel(b: CostBucket, long = false): string {
  if (isToday(b)) return "Today";
  const day = 24 * 60 * 60 * 1000;
  if (b.startTs <= Date.now() - day && Date.now() - day < b.endTs) return "Yesterday";
  return monthDay(new Date(b.startTs), long);
}

function DetailSkeleton({ back, title }: { back: React.ReactNode; title: string }) {
  return (
    <Page>
      <PageHeader above={back} title={title} />
      <PageLoading caption="Adding up this project's spending…">
        <Bone className="h-[190px]" />
        <Bone className="h-[320px]" />
      </PageLoading>
    </Page>
  );
}
