import { useState, type ReactNode } from "react";
import { ChevronDown, GitMerge } from "lucide-react";
import { BarChart } from "@/components/charts/BarChart";
import { Card, CardHeader, Mono, Page, PageHeader } from "@/components/ui/Page";
import { Segmented } from "@/components/ui/Segmented";
import { StatCardSkeleton } from "@/components/ui/StatCard";
import { Skeleton } from "@/components/ui/Skeleton";
import { Button } from "@/components/ui/Button";
import { formatRelativeTime, formatUsd, plural } from "@/lib/format";
import { useHashRoute } from "@/hooks/useHashRoute";
import { cn, openExternal } from "@/lib/utils";
import type { InsightAuthor, PrInsights, RepoInsights } from "@/types/api";
import { PERIODS, bucketLabel, formatSpan, median, nf, type MergedPr, type PeriodValue } from "./insightUtils";

export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  return (
    <Segmented
      ariaLabel="Period"
      value={value}
      onChange={onChange}
      options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
    />
  );
}

export function ChartCard({
  title,
  meta,
  sub,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-w-0 flex-col", className)}>
      <CardHeader title={title} meta={meta} />
      {sub && <p className="m-0 -mt-1.5 px-[18px] pb-2 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>}
      <div className="flex flex-1 flex-col px-[18px] pb-4">{children}</div>
    </Card>
  );
}

/** Bars over the period's buckets, labelled for the bucket unit. */
export function PeriodBars({
  data,
  values,
  barClassName,
  tooltip,
  height = 120,
  minFillHeight,
}: {
  data: RepoInsights;
  values: number[];
  barClassName: string;
  tooltip: (value: number, label: string, i: number) => string;
  /** Px, or "fill" to grow into a flex-column parent (at least `minFillHeight`). */
  height?: number | "fill";
  minFillHeight?: number;
}) {
  const n = data.buckets.length;
  const labels = data.buckets.map((b) => bucketLabel(b, data.bucketUnit, n));
  return (
    <BarChart
      height={height}
      minFillHeight={minFillHeight}
      barClassName={barClassName}
      showLabels={n <= 14}
      gapClassName={n > 14 ? "gap-[3px]" : "gap-2"}
      axisLabels={{ left: labels[0], right: labels[n - 1] }}
      data={values.map((v, i) => ({ label: labels[i], value: v, tooltip: tooltip(v, labels[i], i) }))}
    />
  );
}

export function CodeFrequency({ data, additions, deletions }: { data: RepoInsights; additions: number[]; deletions: number[] }) {
  return (
    // Fills a card stretched by its neighbour; Added keeps about twice
    // Deleted's height, and neither shrinks below its old fixed size.
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-[2] flex-col">
        <div className="mb-1 text-[11px] font-medium text-teal-700 dark:text-teal-300">Added</div>
        <PeriodBars data={data} values={additions} barClassName="bg-teal-500" height="fill" minFillHeight={90} tooltip={(v, l) => `${l}: +${nf.format(v)} lines`} />
      </div>
      <div className="flex flex-1 flex-col">
        <div className="mb-1 text-[11px] font-medium text-orange-700 dark:text-orange-300">Deleted</div>
        <PeriodBars data={data} values={deletions} barClassName="bg-orange-400" height="fill" minFillHeight={44} tooltip={(v, l) => `${l}: −${nf.format(v)} lines`} />
      </div>
    </div>
  );
}

export function Committers({ authors, detail }: { authors: (InsightAuthor & { repos?: number })[]; detail?: boolean }) {
  const max = Math.max(1, ...authors.map((a) => a.commits));
  if (authors.length === 0) return <p className="m-0 text-[13px] text-zinc-500 dark:text-zinc-400">No commits in this period.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {authors.slice(0, 8).map((a) => (
        <li key={a.email || a.name} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-2 text-[13px]">
            <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{a.name}</span>
            <Mono className="shrink-0 text-zinc-500 dark:text-zinc-400">
              {a.commits} {a.commits === 1 ? "commit" : "commits"}
            </Mono>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
            <div className="h-full rounded-full bg-blue-500" style={{ width: `${(a.commits / max) * 100}%` }} />
          </div>
          <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
            {detail && a.repos ? `${a.repos} ${a.repos === 1 ? "repo" : "repos"} · ` : ""}
            <span className="text-teal-700 dark:text-teal-300">+{nf.format(a.additions)}</span>{" "}
            <span className="text-orange-700 dark:text-orange-300">−{nf.format(a.deletions)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

type PrSort = "newest" | "cost";

/**
 * Merged PRs in a card, each with what Claude Code spent on its branch
 * (every attempt, retries included). Expanding the cost lists the sessions,
 * each linking to its replay.
 */
export function MergedPrCard({ title, prs, showRepo }: { title: ReactNode; prs: MergedPr[]; showRepo?: boolean }) {
  const [sort, setSort] = useState<PrSort>("newest");
  const costed = prs.filter((p) => p.agentCostUsd > 0);
  const spent = costed.reduce((a, p) => a + p.agentCostUsd, 0);
  const mid = median(costed.map((p) => p.agentCostUsd));
  const sorted = sort === "cost" ? [...prs].sort((a, b) => b.agentCostUsd - a.agentCostUsd || b.mergedAtMs - a.mergedAtMs) : prs;
  return (
    <Card className="min-w-0">
      <CardHeader
        title={title}
        meta={
          costed.length > 0 && (
            <span title={`Claude Code spend on the branches of ${plural(costed.length, "pull request")}`}>
              {formatUsd(spent)} agent spend · {formatUsd(mid ?? 0)} median per PR
            </span>
          )
        }
        action={
          costed.length > 0 && (
            <Segmented
              ariaLabel="Sort pull requests"
              value={sort}
              onChange={setSort}
              options={[
                { value: "newest", label: "Newest" },
                { value: "cost", label: "Cost" },
              ]}
            />
          )
        }
      />
      {prs.length > 0 ? (
        <MergedPrList key={sort} prs={sorted} showRepo={showRepo} />
      ) : (
        <p className="m-0 px-[18px] pb-4 text-[13px] text-zinc-500 dark:text-zinc-400">None this period.</p>
      )}
    </Card>
  );
}

export function MergedPrList({ prs, showRepo, initial = 8 }: { prs: MergedPr[]; showRepo?: boolean; initial?: number }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const shown = all ? prs : prs.slice(0, initial);
  return (
    <div className="flex flex-col">
      {shown.map((p) => {
        const key = `${p.repoPath}#${p.number}`;
        return (
          <div key={key} className="border-t border-black/[0.05] dark:border-white/[0.06]">
            <div className="flex items-start">
              <button
                type="button"
                onClick={() => openExternal(p.url)}
                className="flex min-w-0 flex-1 items-start gap-3 py-2.5 pl-[18px] pr-3 text-left transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
              >
                <GitMerge size={15} className="mt-0.5 shrink-0 text-violet-500 dark:text-violet-400" aria-hidden />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{p.title}</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {showRepo && <span className="font-medium text-zinc-700 dark:text-zinc-300">{p.repoName} </span>}#{p.number} by {p.author || "unknown"} · merged{" "}
                    {formatRelativeTime(p.mergedAtMs)}, open {formatSpan(p.mergedAtMs - p.createdAtMs)}
                  </span>
                </span>
              </button>
              <PrCost pr={p} expanded={open === key} onToggle={() => setOpen(open === key ? null : key)} />
            </div>
            {open === key && <PrSessions pr={p} />}
          </div>
        );
      })}
      {prs.length > initial && (
        <div className="border-t border-black/[0.05] px-[18px] py-2.5 dark:border-white/[0.06]">
          <Button variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${prs.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function PrCost({ pr, expanded, onToggle }: { pr: MergedPr; expanded: boolean; onToggle: () => void }) {
  const n = pr.agentSessions.length;
  if (n === 0) {
    return (
      <span className="shrink-0 py-2.5 pr-[18px] text-right text-xs text-zinc-400 dark:text-zinc-500" title="No Claude Code sessions on this branch">
        —
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={`Claude Code spend on ${pr.headRef}`}
      className="flex shrink-0 items-start gap-1.5 self-stretch py-2.5 pl-3 pr-[18px] text-right transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
    >
      <span className="flex flex-col items-end gap-0.5">
        <Mono className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{formatUsd(pr.agentCostUsd)}</Mono>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{plural(n, "session")}</span>
      </span>
      <ChevronDown size={14} aria-hidden className={cn("mt-0.5 text-zinc-400 transition-transform", expanded && "rotate-180")} />
    </button>
  );
}

const timeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The sessions behind a PR's cost, oldest first, each opening its replay. */
function PrSessions({ pr }: { pr: MergedPr }) {
  const { navigateTo } = useHashRoute();
  return (
    <div className="px-[18px] pb-3 pl-[46px]">
      <p className="m-0 mb-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        Claude Code sessions on <Mono>{pr.headRef}</Mono> before it merged
      </p>
      <ol className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-black/[0.06] p-0 dark:border-white/[0.08]">
        {pr.agentSessions.map((s, i) => {
          const shared = s.sessionCostUsd - s.costUsd > 0.005;
          return (
            <li key={s.id} className={cn(i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]")}>
              <button
                type="button"
                onClick={() => navigateTo("session-replay", { id: s.id })}
                className="flex w-full items-baseline gap-3 px-3 py-2 text-left transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
              >
                <span className="w-5 shrink-0 text-xs text-zinc-400 dark:text-zinc-500">{i + 1}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] text-zinc-800 dark:text-zinc-200">{s.firstPrompt || "Untitled session"}</span>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {timeFmt.format(s.startTs)} · {formatSpan(Math.max(0, s.endTs - s.startTs))}
                    {shared && ` · ${formatUsd(s.sessionCostUsd)} session, part on other work`}
                  </span>
                </span>
                <Mono className="shrink-0 text-[13px] text-zinc-800 dark:text-zinc-200">{formatUsd(s.costUsd)}</Mono>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Why PR numbers are missing. `blocking` means there are no PR stats at all
 * (gh missing, logged out, no GitHub repos, the query failed); `partial`
 * means some repos failed and the totals leave them out.
 */
export function githubNote(prs: PrInsights | undefined, error: unknown): { blocking: string | null; partial: string | null } {
  const blocking = (text: string) => ({ blocking: text, partial: null });
  if (error) return blocking("Couldn’t load pull requests from GitHub.");
  if (!prs) return { blocking: null, partial: null };
  if (!prs.status.installed) return blocking("Install the GitHub CLI (gh) to see pull request stats.");
  if (!prs.status.authenticated) return blocking("Run `gh auth login` to see pull request stats.");
  if (prs.githubRepoCount === 0) return blocking("None of your repos have a github.com remote, so there are no pull request stats.");
  const failed = prs.repos.filter((r) => r.error);
  if (failed.length > 0 && failed.length === prs.repos.length) return blocking(`gh couldn’t read your repos: ${failed[0].error}`);
  return {
    blocking: null,
    partial: failed.length > 0 ? `Pull request numbers leave out ${failed.map((r) => r.name).join(", ")}: gh couldn’t read ${failed.length === 1 ? "it" : "them"}.` : null,
  };
}

/** Stat-card value and hint placeholders while GitHub answers. */
export function ValueSkeleton() {
  return <Skeleton className="my-1 h-7 w-16" />;
}
export function HintSkeleton() {
  return <Skeleton className="h-3 w-24" />;
}

/** A chart card with its real title, bars blocked out until the data lands. */
export function ChartCardSkeleton({ title }: { title: string }) {
  return (
    <ChartCard title={title} meta={<Skeleton className="h-3 w-24" />}>
      <Skeleton className="h-[120px] w-full" />
      <div className="mt-2 flex gap-2">
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-2.5 flex-1" />
        ))}
      </div>
    </ChartCard>
  );
}

/** Merged-PR list rows blocked out: icon, title line, detail line. */
export function PrListSkeleton({ title, rows = 5 }: { title: string; rows?: number }) {
  return (
    <Card className="min-w-0">
      <CardHeader title={title} meta={<Skeleton className="h-3 w-20" />} />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-3 border-t border-black/[0.05] px-[18px] py-3 dark:border-white/[0.06]">
          <Skeleton className="mt-0.5 size-[15px] shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-2.5 w-2/5" />
          </div>
        </div>
      ))}
    </Card>
  );
}

export function InsightsPageSkeleton() {
  return (
    <Page>
      <PageHeader title="Insights" lead="Reading git history across your repos…" />
      <InsightsSkeleton />
    </Page>
  );
}

export function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <Skeleton className="h-[230px] rounded-[14px]" />
        <Skeleton className="h-[230px] rounded-[14px]" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-[200px] rounded-[14px]" />
        <Skeleton className="h-[200px] rounded-[14px]" />
      </div>
    </div>
  );
}
