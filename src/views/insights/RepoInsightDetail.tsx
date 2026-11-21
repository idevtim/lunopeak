import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/Button";
import { formatRelativeTime, formatUsd, plural } from "@/lib/format";
import { openExternal } from "@/lib/utils";
import type { PrInsights, RepoInsight, RepoInsights } from "@/types/api";
import { allMerged, big, deltaPct, formatSpan, median, nf, prSeries, rangeLabel, trendHint } from "./insightUtils";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  ChartCard,
  ChartCardSkeleton,
  CodeFrequency,
  Committers,
  HintSkeleton,
  MergedPrCard,
  PeriodBars,
  PrListSkeleton,
  ValueSkeleton,
  githubNote,
} from "./parts";

/** One repo's Pulse: GitHub's per-repo page, plus local agent activity. */
export function RepoInsightDetail({
  data,
  repo,
  prs,
  prsLoading,
  prsError,
  picker,
  onBack,
}: {
  data: RepoInsights;
  repo: RepoInsight;
  prs: PrInsights | undefined;
  prsLoading: boolean;
  prsError: unknown;
  picker: ReactNode;
  onBack: () => void;
}) {
  const prRepo = prs?.repos.find((r) => r.path === repo.path);
  const merged = allMerged(prs, repo.path);
  const series = prSeries(merged, data.buckets);
  const mergeMedian = median(merged.map((p) => p.mergedAtMs - p.createdAtMs));
  const sameDay = merged.filter((p) => new Date(p.createdAtMs).toDateString() === new Date(p.mergedAtMs).toDateString()).length;
  const note = prRepo?.error ? `gh couldn’t read ${prRepo.slug}: ${prRepo.error}` : githubNote(prs, prsError).blocking;
  const hasPrs = !!prRepo && !prRepo.error;
  const pct = deltaPct(repo.commits, repo.prevCommits);
  const branch = repo.refs[repo.refs.length - 1] ?? "HEAD";
  const pending = prsLoading ? <ValueSkeleton /> : "—";
  const fetchedLongAgo = repo.lastFetchMs != null && data.untilMs - repo.lastFetchMs > 24 * 3_600_000;

  return (
    <Page>
      <PageHeader
        above={
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            <ChevronLeft size={14} aria-hidden />
            All repos
          </button>
        }
        title={repo.name}
        lead={
          <>
            {rangeLabel(data)} · <Mono>{repo.refs.join(" + ")}</Mono>
            {repo.lastFetchMs != null && (
              <span className={fetchedLongAgo ? "text-amber-700 dark:text-amber-300" : undefined}>
                {" "}
                · fetched {formatRelativeTime(repo.lastFetchMs)}
              </span>
            )}
          </>
        }
        actions={
          <>
            {prRepo && (
              <Button onClick={() => openExternal(`https://github.com/${prRepo.slug}/pulse`)}>Open on GitHub</Button>
            )}
            {picker}
          </>
        }
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        <StatCard
          label="Commits"
          value={<span title={nf.format(repo.commits)}>{big(repo.commits)}</span>}
          hint={pct == null ? `${big(repo.allBranchCommits)} on all branches` : trendHint(pct, data.days)}
        />
        <StatCard label="PRs merged" value={hasPrs ? merged.length : pending} hint={hasPrs ? `${prRepo!.opened} opened` : prsLoading ? <HintSkeleton /> : undefined} />
        <StatCard label="Open PRs" value={hasPrs ? prRepo!.openNow : pending} />
        <StatCard label="Time to merge" value={hasPrs && mergeMedian != null ? formatSpan(mergeMedian) : pending} />
        <StatCard label="Agent sessions" value={repo.sessions} hint={repo.sessions > 0 ? `${formatUsd(repo.agentCostUsd)} spent` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-2.5 px-[18px] py-4 text-[14px] leading-relaxed text-zinc-600 dark:text-zinc-400 [&_b]:font-semibold [&_b]:text-zinc-900 dark:[&_b]:text-zinc-100">
          <h3 className="m-0 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Summary</h3>
          {repo.commits === 0 ? (
            <p className="m-0">
              No commits on <Mono>{branch}</Mono> this period.
              {repo.lastCommitMs && <> The last one was {formatRelativeTime(repo.lastCommitMs)}.</>}
            </p>
          ) : (
            <>
              <p className="m-0">
                Excluding merges, <b>{plural(repo.authors.length, "author")}</b> pushed <b>{plural(repo.commits, "commit")}</b> to{" "}
                <Mono>{branch}</Mono> and <b>{plural(repo.allBranchCommits, "commit")}</b> to all branches.
              </p>
              <p className="m-0">
                On <Mono>{branch}</Mono>, <b>{plural(repo.filesChanged, "file")}</b> changed, with{" "}
                <span className="font-semibold text-teal-700 dark:text-teal-300">{nf.format(repo.additions)} additions</span> and{" "}
                <span className="font-semibold text-orange-700 dark:text-orange-300">{nf.format(repo.deletions)} deletions</span>.
              </p>
            </>
          )}
          {hasPrs && merged.length > 0 && mergeMedian != null && (
            <p className="m-0">
              Pull requests took a median of <b>{formatSpan(mergeMedian)}</b> to merge; {sameDay} of {merged.length} merged the day they opened.
            </p>
          )}
          {repo.agentCommits > 0 && (
            <p className="m-0">
              At least <b>{repo.agentCommits}</b> commits name an agent in a Co-authored-by trailer.
            </p>
          )}
          {prsLoading ? (
            <Skeleton className="h-3.5 w-4/5" />
          ) : (
            !hasPrs && note && <p className="m-0 text-[13px]">{note}</p>
          )}
        </Card>
        <ChartCard title="Top committers" meta={plural(repo.authors.length, "author")}>
          <Committers authors={repo.authors} />
        </ChartCard>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ChartCard title="Commits" meta={`${nf.format(repo.commits)} on ${branch}`}>
          <PeriodBars data={data} values={repo.commitsByBucket} barClassName="bg-blue-500" tooltip={(v, l) => `${l}: ${plural(v, "commit")}`} />
        </ChartCard>
        {hasPrs ? (
          <ChartCard title="Pull requests merged" meta={`${merged.length} merged · ${prRepo!.opened} opened`}>
            <PeriodBars data={data} values={series.count} barClassName="bg-violet-400" tooltip={(v, l) => `${l}: ${plural(v, "PR")} merged`} />
          </ChartCard>
        ) : prsLoading ? (
          <ChartCardSkeleton title="Pull requests merged" />
        ) : (
          <ChartCard title="Code frequency">
            <CodeFrequency data={data} additions={repo.additionsByBucket} deletions={repo.deletionsByBucket} />
          </ChartCard>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {hasPrs ? (
          <MergedPrCard title={`${plural(merged.length, "pull request")} merged`} prs={merged} />
        ) : prsLoading ? (
          <PrListSkeleton title="Merged pull requests" />
        ) : (
          <div />
        )}
        <ChartCard title="Hot files" sub={`Most-changed paths on ${branch}`}>
          {repo.hotFiles.length === 0 ? (
            <p className="m-0 text-[13px] text-zinc-500 dark:text-zinc-400">Nothing changed.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
              {repo.hotFiles.map((f) => (
                <li key={f.path} className="flex flex-col gap-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <Mono className="truncate text-zinc-800 dark:text-zinc-200" title={f.path}>
                      {f.path}
                    </Mono>
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{plural(f.commits, "commit")}</span>
                  </span>
                  <span className="block h-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                    <span
                      className="block h-full rounded-full bg-teal-500"
                      style={{ width: `${(f.commits / Math.max(1, repo.hotFiles[0].commits)) * 100}%` }}
                    />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </ChartCard>
      </div>

      {(hasPrs || prsLoading) && (
        <ChartCard
          title="Code frequency"
          meta={
            <Mono>
              <span className="text-teal-700 dark:text-teal-300">+{nf.format(repo.additions)}</span>{" "}
              <span className="text-orange-700 dark:text-orange-300">−{nf.format(repo.deletions)}</span>
            </Mono>
          }
        >
          <CodeFrequency data={data} additions={repo.additionsByBucket} deletions={repo.deletionsByBucket} />
        </ChartCard>
      )}
    </Page>
  );
}
