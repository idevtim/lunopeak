import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2 } from "lucide-react";
import { BarChart } from "@/components/charts/BarChart";
import { Page, PageHeader, Card, CardHeader, Mono } from "@/components/ui/Page";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState, ErrorState } from "@/components/ui/PageStates";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { api } from "@/lib/tauri";
import { toast } from "@/stores/toastStore";
import { Button } from "@/components/ui/Button";
import { queries } from "@/lib/queries";
import { formatRelativeTime, formatUsd, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PrInsights, RepoInsights } from "@/types/api";
import {
  OTHER_COLOR,
  REPO_COLORS,
  allMerged,
  bucketLabel,
  deltaPct,
  formatSpan,
  median,
  mergeAuthors,
  nf,
  parsePeriod,
  periodNoun,
  prSeries,
  rangeLabel,
  sumSeries,
  totals,
  type PeriodValue,
} from "./insightUtils";
import {
  ChartCard,
  ChartCardSkeleton,
  CodeFrequency,
  HintSkeleton,
  PrListSkeleton,
  ValueSkeleton,
  Committers,
  InsightsSkeleton,
  MergedPrList,
  PeriodBars,
  PeriodPicker,
  githubNote,
} from "./parts";
import { RepoInsightDetail } from "./RepoInsightDetail";

export function InsightsView() {
  const { params, navigateTo } = useHashRoute();
  const period = parsePeriod(params.get("days"));
  const repoPath = params.get("repo");
  const days = Number(period);
  const insights = useQuery(queries.repoInsights(days));
  const prs = useQuery(queries.prInsights(days));
  const showSkeleton = useDelayedLoading(insights.isLoading);

  const setPeriod = (v: PeriodValue) => navigateTo("insights", repoPath ? { days: v, repo: repoPath } : { days: v });
  const openRepo = (path: string) => navigateTo("insights", { days: period, repo: path });
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  // Re-read git and skip the 5-minute gh cache in Rust.
  const refresh = async () => {
    setRefreshing(true);
    try {
      const [, fresh] = await Promise.all([insights.refetch(), api.getPrInsights(days, true)]);
      queryClient.setQueryData(queries.prInsights(days).queryKey, fresh);
    } catch (e) {
      toast.error("Couldn’t refresh pull requests", e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };
  const picker = (
    <>
      <Button onClick={() => void refresh()} disabled={refreshing}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
      <PeriodPicker value={period} onChange={setPeriod} />
    </>
  );

  if (insights.isError) {
    return (
      <Page>
        <PageHeader title="Insights" actions={picker} />
        <ErrorState
          title="Couldn’t read your repos’ history"
          body="LunoPeak couldn’t run git log in your project folders. Check they still exist, then try again."
          onRetry={() => void insights.refetch()}
          error={insights.error}
        />
      </Page>
    );
  }
  if (!insights.data) {
    return showSkeleton ? (
      <Page>
        <PageHeader title="Insights" lead="Reading git history across your repos…" actions={picker} />
        <InsightsSkeleton />
      </Page>
    ) : null;
  }

  const data = insights.data;
  if (repoPath) {
    const repo = data.repos.find((r) => r.path === repoPath);
    if (repo) {
      return (
        <RepoInsightDetail
          data={data}
          repo={repo}
          prs={prs.data}
          prsLoading={prs.isLoading}
          prsError={prs.error}
          picker={picker}
          onBack={() => navigateTo("insights", { days: period })}
        />
      );
    }
  }
  if (data.repos.length === 0) {
    return (
      <Page>
        <PageHeader title="Insights" />
        <EmptyState
          icon={FolderGit2}
          title="No repos found"
          body="LunoPeak looks for git repos inside your project folders. Add the folder where you keep your code."
          primary={{ label: "Add project folder", onClick: () => navigateTo("settings", { tab: "agents" }) }}
        />
      </Page>
    );
  }

  return (
    <AllRepos
      data={data}
      prs={prs.data}
      prsLoading={prs.isLoading}
      prsError={prs.error}
      picker={picker}
      onOpenRepo={openRepo}
    />
  );
}

function AllRepos({
  data,
  prs,
  prsLoading,
  prsError,
  picker,
  onOpenRepo,
}: {
  data: RepoInsights;
  prs: PrInsights | undefined;
  prsLoading: boolean;
  prsError: unknown;
  picker: React.ReactNode;
  onOpenRepo: (path: string) => void;
}) {
  const n = data.buckets.length;
  const t = totals(data.repos);
  const active = data.repos.filter((r) => r.commits > 0);
  const quiet = data.repos
    .filter((r) => r.commits === 0)
    .sort((a, b) => (b.lastCommitMs ?? 0) - (a.lastCommitMs ?? 0));
  const stacked = active.slice(0, REPO_COLORS.length);
  const others = active.slice(REPO_COLORS.length);
  const othersSeries = sumSeries(others.map((r) => r.commitsByBucket), n);
  const totalByBucket = sumSeries(data.repos.map((r) => r.commitsByBucket), n);
  const labels = data.buckets.map((b) => bucketLabel(b, data.bucketUnit, n));

  const merged = allMerged(prs);
  const series = prSeries(merged, data.buckets);
  const openNow = prs?.repos.reduce((s, r) => s + r.openNow, 0) ?? 0;
  const opened = prs?.repos.reduce((s, r) => s + r.opened, 0) ?? 0;
  const mergeMedian = median(merged.map((p) => p.mergedAtMs - p.createdAtMs));
  const prRepos = prs?.repos.filter((r) => r.merged.length > 0).length ?? 0;
  const { blocking: note, partial } = githubNote(prs, prsError);
  const hasPrs = !!prs && !note;
  const pct = deltaPct(t.commits, t.prevCommits);
  // Waiting on GitHub: shimmer in place of the number; after that, a dash.
  const pending = prsLoading ? <ValueSkeleton /> : "—";
  const pendingHint = prsLoading ? <HintSkeleton /> : (note ?? undefined);
  const authors = mergeAuthors(data.repos);
  const noun = periodNoun(data.days);

  return (
    <Page>
      <PageHeader
        title="Insights"
        lead={
          <>
            {rangeLabel(data)} · <b>{nf.format(t.commits)} {t.commits === 1 ? "commit" : "commits"}</b> across{" "}
            <b>{plural(active.length, "repo")}</b>
            {hasPrs && (
              <>
                , <b>{plural(merged.length, "pull request")}</b> merged
              </>
            )}
            . {data.repos.length - active.length} of {data.repos.length} repos were quiet.
          </>
        }
        actions={picker}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="Commits"
          value={nf.format(t.commits)}
          hint={pct == null ? `${nf.format(t.allBranchCommits)} on all branches` : `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs prior ${noun}`}
        />
        <StatCard label="Pull requests merged" value={hasPrs ? nf.format(merged.length) : pending} hint={hasPrs ? `${nf.format(opened)} opened` : pendingHint} />
        <StatCard label="Open pull requests" value={hasPrs ? nf.format(openNow) : pending} hint={hasPrs ? `across ${plural(prs!.repos.filter((r) => r.openNow > 0).length, "repo")}` : prsLoading ? <HintSkeleton /> : undefined} />
        <StatCard
          label="Lines changed"
          value={
            <span>
              <span className="text-teal-700 dark:text-teal-300">+{nf.format(t.additions)}</span>
            </span>
          }
          hint={`−${nf.format(t.deletions)} · ${nf.format(t.filesChanged)} files`}
        />
        <StatCard label="Active repos" value={`${active.length}`} hint={`of ${data.repos.length} tracked`} />
        <StatCard
          label="Median time to merge"
          value={hasPrs && mergeMedian != null ? formatSpan(mergeMedian) : pending}
          hint={hasPrs ? "opened → merged" : prsLoading ? <HintSkeleton /> : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ChartCard
          title="Commits"
          meta={`${nf.format(t.commits)} on default branches`}
          sub={
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {stacked.map((r, i) => (
                <span key={r.path} className="inline-flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-[2px]", REPO_COLORS[i])} aria-hidden />
                  {r.name}
                </span>
              ))}
              {others.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-[2px]", OTHER_COLOR)} aria-hidden />
                  {plural(others.length, "other")}
                </span>
              )}
            </span>
          }
        >
          <BarChart
            height="fill"
            minFillHeight={170}
            showLabels={n <= 14}
            gapClassName={n > 14 ? "gap-[3px]" : "gap-2"}
            axisLabels={{ left: labels[0], right: labels[n - 1] }}
            data={totalByBucket.map((total, i) => ({
              label: labels[i],
              value: total,
              tooltip: `${labels[i]}: ${plural(total, "commit")}`,
              segments: [
                ...stacked.map((r, ri) => ({ value: r.commitsByBucket[i], className: REPO_COLORS[ri] })),
                { value: othersSeries[i], className: OTHER_COLOR },
              ],
            }))}
          />
        </ChartCard>

        <Card className="flex min-w-0 flex-col">
          <CardHeader title="Most active repos" meta="by commits" />
          {active.length === 0 ? (
            <p className="m-0 px-[18px] pb-4 text-[13px] text-zinc-500 dark:text-zinc-400">No commits in this period.</p>
          ) : (
            <div className="flex flex-col pb-1.5">
              {active.slice(0, 8).map((r, i) => {
                const prCount = prs?.repos.find((p) => p.path === r.path)?.merged.length;
                return (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => onOpenRepo(r.path)}
                    className="flex flex-col gap-1.5 px-[18px] py-2 text-left transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
                  >
                    <span className="flex w-full items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                      <Mono className="shrink-0 text-zinc-500 dark:text-zinc-400">
                        {r.commits}
                        {prCount ? ` · ${prCount} PRs` : ""}
                      </Mono>
                    </span>
                    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                      <span
                        className={cn("block h-full rounded-full", REPO_COLORS[i] ?? OTHER_COLOR)}
                        style={{ width: `${(r.commits / Math.max(1, t.commits)) * 100}%` }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {partial && <p className="m-0 -mb-2 text-xs text-amber-700 dark:text-amber-300">{partial}</p>}
      {hasPrs ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ChartCard title="Pull request throughput" meta={`${nf.format(merged.length)} merged · ${nf.format(opened)} opened`}>
            <PeriodBars data={data} values={series.count} barClassName="bg-blue-500" tooltip={(v, l) => `${l}: ${plural(v, "PR")} merged`} />
          </ChartCard>
          <ChartCard title="Median time to merge" meta={mergeMedian != null ? `${formatSpan(mergeMedian)} overall` : undefined}>
            <PeriodBars
              data={data}
              values={series.median.map((m) => (m == null ? 0 : m / 60_000))}
              barClassName="bg-violet-400"
              tooltip={(_, l, i) => (series.median[i] == null ? `${l}: no merges` : `${l}: ${formatSpan(series.median[i]!)}`)}
            />
          </ChartCard>
        </div>
      ) : prsLoading ? (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ChartCardSkeleton title="Pull request throughput" />
          <ChartCardSkeleton title="Median time to merge" />
        </div>
      ) : (
        <Card className="px-[18px] py-3.5 text-[13px] text-zinc-600 dark:text-zinc-400">{note}</Card>
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ChartCard
          title="Code frequency"
          meta={
            <Mono>
              <span className="text-teal-700 dark:text-teal-300">+{nf.format(t.additions)}</span>{" "}
              <span className="text-orange-700 dark:text-orange-300">−{nf.format(t.deletions)}</span>
            </Mono>
          }
        >
          <CodeFrequency
            data={data}
            additions={sumSeries(data.repos.map((r) => r.additionsByBucket), n)}
            deletions={sumSeries(data.repos.map((r) => r.deletionsByBucket), n)}
          />
        </ChartCard>
        <ChartCard title="Top committers" meta={plural(authors.length, "author")}>
          <div className="flex h-full flex-col gap-4">
            <Committers authors={authors} detail />
            {(t.agentCommits > 0 || t.sessions > 0) && (
              <div className="mt-auto flex flex-col gap-1 rounded-[10px] bg-black/[0.03] px-3 py-2.5 text-xs text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-400">
                {t.sessions > 0 && (
                  <span>
                    <b className="text-zinc-900 dark:text-zinc-100">{plural(t.sessions, "Claude Code session")}</b> ·{" "}
                    {formatUsd(t.agentCostUsd)} spent
                  </span>
                )}
                {t.agentCommits > 0 && (
                  <span>
                    At least <b className="text-zinc-900 dark:text-zinc-100">{t.agentCommits}</b> commits name an agent in a Co-authored-by trailer
                  </span>
                )}
              </div>
            )}
          </div>
        </ChartCard>
      </div>

      {prsLoading ? (
        <PrListSkeleton title="Merged pull requests" />
      ) : (
        hasPrs &&
        merged.length > 0 && (
          <Card>
            <CardHeader title={`${plural(merged.length, "pull request")} merged across ${plural(prRepos, "repo")}`} />
            <MergedPrList prs={merged} showRepo />
          </Card>
        )
      )}

      {quiet.length > 0 && (
        <Card>
          <CardHeader title="Quiet this period" meta="last commit on the default branch" />
          <div className="flex flex-wrap gap-2 px-[18px] pb-4">
            {quiet.map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => onOpenRepo(r.path)}
                className="inline-flex items-baseline gap-2 rounded-lg border border-black/[0.07] px-2.5 py-1.5 text-[13px] text-zinc-800 transition-colors hover:border-black/[0.14] dark:border-white/[0.08] dark:text-zinc-200 dark:hover:border-white/[0.16]"
              >
                {r.name}
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {r.lastCommitMs ? formatRelativeTime(r.lastCommitMs) : "no commits"}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}

export { InsightsSkeleton };
