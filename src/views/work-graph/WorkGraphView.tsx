import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Page, PageHeader, Mono } from "@/components/ui/Page";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { Segmented } from "@/components/ui/Segmented";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { plural } from "@/lib/format";
import { cn, openExternal } from "@/lib/utils";
import type { BranchInfo, PullRequest, PullRequestList, RepoOverviewEntry } from "@/types/api";
import { LinkButton, ListRow, PanelCard } from "@/views/repos/Panel";
import { aheadBehind, daysSince, shortAgo } from "@/views/repos/repoUtils";

type Scope = "all" | "mine";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Repos whose branches we list: touched in the last 30 days, newest first. */
const BRANCH_REPO_LIMIT = 15;
const STALE_BRANCH_DAYS = 10;
const CHIP_LIMIT = 8;

export function WorkGraphView() {
  const overview = useQuery(queries.reposOverview);
  const activity = useQuery(queries.repoActivity);
  // gh is slow on first hit — keep it out of the skeleton gate so the rest
  // of the page paints first.
  const pullRequests = useQuery(queries.pullRequests);
  const showSkeleton = useDelayedLoading(overview.isLoading || activity.isLoading);
  const [scope, setScope] = useState<Scope>("all");

  const repos = useMemo(() => overview.data?.repos ?? [], [overview.data]);
  const recentRepos = useMemo(() => {
    const now = Date.now();
    return repos
      .filter((r) => r.lastActivityTs && now - r.lastActivityTs <= 30 * DAY_MS)
      .sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0))
      .slice(0, BRANCH_REPO_LIMIT);
  }, [repos]);
  const branchQueries = useQueries({
    queries: recentRepos.map((r) => queries.repoBranches(r.path)),
  });

  const error = overview.error ?? activity.error;
  if (error) {
    return (
      <Page>
        <PageHeader title="Work graph" />
        <ErrorState
          title="Couldn’t read your git history"
          body="LunoPeak couldn’t scan the repos in your project folders. Check they still exist, then try again."
          onRetry={() => {
            void overview.refetch();
            void activity.refetch();
          }}
          error={error}
        />
      </Page>
    );
  }
  if (!overview.data || !activity.data) return showSkeleton ? <WorkGraphSkeleton /> : null;

  const mine = scope === "mine";
  const activities = mine ? activity.data.filter((a) => a.mineCommits > 0) : activity.data;
  const commits = activities.reduce((s, a) => s + (mine ? a.mineCommits : a.totalCommits), 0);
  const commitRepos = activities.filter((a) => (mine ? a.mineCommits : a.totalCommits) > 0).length;

  const ghUser = pullRequests.data?.status.user ?? null;
  const prs = (pullRequests.data?.prs ?? []).filter((p) => !mine || (ghUser && p.author === ghUser));

  const openBranches = recentRepos
    .flatMap((repo, i) =>
      (branchQueries[i]?.data ?? [])
        .filter((b) => !b.isDefault && !b.merged)
        .map((b) => ({ repo, branch: b, base: branchQueries[i]?.data?.find((x) => x.isDefault)?.name ?? "main" })),
    )
    .sort((a, b) => (b.branch.lastCommitTs ?? 0) - (a.branch.lastCommitTs ?? 0));
  const branchesLoading = branchQueries.some((q) => q.isLoading);

  if (repos.length === 0 || (commits === 0 && prs.length === 0 && openBranches.length === 0 && !branchesLoading)) {
    return (
      <Page>
        <PageHeader
          title="Work graph"
          actions={repos.length > 0 && <ScopeSwitch scope={scope} onChange={setScope} />}
        />
        <EmptyState
          icon={GitCommitHorizontal}
          title={mine ? "No commits from you in the last 30 days" : "No commits in the last 30 days"}
          body="Once you commit in a tracked repo, branches and pull requests show up here."
        />
      </Page>
    );
  }

  const waiting = prs.filter((p) => !p.isDraft).length;
  const extras: string[] = [];
  if (!branchesLoading) {
    extras.push(openBranches.length === 1 ? "1 branch is open" : `${openBranches.length} branches are open`);
  }
  if (pullRequests.data?.status.authenticated) {
    extras.push(waiting === 1 ? "1 pull request is waiting" : `${waiting} pull requests are waiting`);
  }
  const extra = extras.join(" and ");
  const lead = (
    <>
      <b>{plural(commits, "commit")}</b> across {plural(commitRepos, "repo")} in the last 30 days.
      {extra && ` ${extra[0].toUpperCase()}${extra.slice(1)}.`}
    </>
  );

  return (
    <Page>
      <PageHeader
        title="Work graph"
        lead={lead}
        actions={<ScopeSwitch scope={scope} onChange={setScope} />}
      />

      <PullRequestsCard data={pullRequests.data} loading={pullRequests.isLoading} prs={prs} onRetry={() => void pullRequests.refetch()} />

      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start gap-3">
        <OpenBranchesCard rows={openBranches} loading={branchesLoading} />
        <ActivityCard repos={repos} activityPaths={mine ? new Set(activities.map((a) => a.repoPath)) : null} />
      </div>
    </Page>
  );
}

function ScopeSwitch({ scope, onChange }: { scope: Scope; onChange: (s: Scope) => void }) {
  return (
    <Segmented
      ariaLabel="Whose work"
      value={scope}
      onChange={onChange}
      options={[
        { value: "all", label: "Everyone" },
        { value: "mine", label: "Only me" },
      ]}
    />
  );
}

const REVIEW: Record<string, { label: string; tone: PillTone }> = {
  REVIEW_REQUIRED: { label: "Needs review", tone: "blue" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "amber" },
  APPROVED: { label: "Ready to merge", tone: "green" },
};

function prStatus(pr: PullRequest, me: string | null): { label: string; tone: PillTone } | null {
  if (pr.isDraft) return { label: "Draft", tone: "neutral" };
  const s = pr.reviewDecision ? REVIEW[pr.reviewDecision] : undefined;
  if (s && pr.reviewDecision === "REVIEW_REQUIRED" && me && pr.author !== me) {
    return { label: "Needs your review", tone: "blue" };
  }
  return s ?? null;
}

function PullRequestsCard({
  data,
  loading,
  prs,
  onRetry,
}: {
  data: PullRequestList | undefined;
  loading: boolean;
  prs: PullRequest[];
  onRetry: () => void;
}) {
  if (loading && !data) {
    return (
      <PanelCard title="Pull requests">
        <div className="flex flex-col gap-2 animate-lp-pulse">
          <Bone className="h-10" />
          <Bone className="h-10" />
        </div>
      </PanelCard>
    );
  }
  if (!data) {
    return (
      <ErrorState
        title="Couldn’t load pull requests"
        body="The GitHub CLI didn’t answer. Try again in a moment."
        onRetry={onRetry}
      />
    );
  }
  const { status, githubRepoCount } = data;
  if (!status.installed || !status.authenticated) {
    return (
      <ErrorState
        title="GitHub isn’t connected"
        body={
          status.installed
            ? "Pull requests need the GitHub CLI signed in. Run “gh auth login” in your terminal, then try again."
            : "Pull requests need the GitHub CLI. Install it and run “gh auth login”, then try again."
        }
        action={{
          label: "How to set up",
          onClick: () =>
            openExternal(
              status.installed ? "https://cli.github.com/manual/gh_auth_login" : "https://cli.github.com/",
            ),
        }}
        error={status.message ?? (status.installed ? "gh: not logged in" : "gh: command not found")}
      />
    );
  }

  return (
    <PanelCard
      title="Pull requests"
      aside={<LinkButton onClick={() => openExternal("https://github.com/pulls")}>Open on GitHub ↗</LinkButton>}
    >
      {githubRepoCount === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          None of your tracked repos are on GitHub.
        </p>
      ) : prs.length === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No open pull requests across {plural(githubRepoCount, "GitHub repo")}.
        </p>
      ) : (
        <div className="flex flex-col">
          {prs.map((pr, i) => {
            const s = prStatus(pr, status.user);
            return (
              <button
                key={`${pr.owner}/${pr.repo}#${pr.number}`}
                type="button"
                onClick={() => openExternal(pr.url)}
                className={cn(
                  "-mx-1.5 flex items-center gap-3.5 rounded-lg px-1.5 py-2.5 text-left transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.04]",
                  i > 0 && "rounded-none border-t border-black/[0.05] dark:border-white/[0.06]",
                )}
              >
                <span className="w-10 shrink-0 text-[12.5px] tabular-nums text-zinc-500 dark:text-zinc-400">
                  #{pr.number}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                    {pr.title}
                  </span>
                  <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {pr.repoName} · <Mono className="text-[11.5px]">{pr.headRef}</Mono>
                    {pr.author && ` · ${pr.author}`}
                    {pr.updatedAtMs && ` · updated ${shortAgo(pr.updatedAtMs).toLowerCase()}`}
                  </span>
                </span>
                {s && <Pill tone={s.tone}>{s.label}</Pill>}
              </button>
            );
          })}
        </div>
      )}
    </PanelCard>
  );
}

function OpenBranchesCard({
  rows,
  loading,
}: {
  rows: { repo: RepoOverviewEntry; branch: BranchInfo; base: string }[];
  loading: boolean;
}) {
  const { navigateTo } = useHashRoute();
  return (
    <PanelCard
      title="Open branches"
      aside={<span className="text-xs text-zinc-500 dark:text-zinc-400">Compared with the default branch</span>}
    >
      {loading && rows.length === 0 ? (
        <div className="flex flex-col gap-2 animate-lp-pulse">
          <Bone className="h-9" />
          <Bone className="h-9" />
        </div>
      ) : rows.length === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          Every recently active repo is on its default branch.
        </p>
      ) : (
        <div className="flex flex-col">
          {rows.map(({ repo, branch, base }, i) => {
            const idle = branch.lastCommitTs ? daysSince(branch.lastCommitTs) : null;
            return (
              <button
                key={`${repo.path}:${branch.name}`}
                type="button"
                onClick={() => navigateTo("repo-detail", { path: repo.path })}
                className="text-left"
              >
                <ListRow first={i === 0} className="gap-3 py-[9px]">
                  <GitBranch size={14} strokeWidth={2} className="shrink-0 text-zinc-500 dark:text-zinc-400" />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <Mono className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">{branch.name}</Mono>
                    <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {[repo.name, aheadBehind(branch, base) ?? `level with ${base}`].join(" · ")}
                    </span>
                  </span>
                  {idle !== null && idle >= STALE_BRANCH_DAYS ? (
                    <Pill>No commits in {plural(idle, "day")}</Pill>
                  ) : (
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                      {branch.lastCommitTs ? shortAgo(branch.lastCommitTs) : ""}
                    </span>
                  )}
                </ListRow>
              </button>
            );
          })}
        </div>
      )}
    </PanelCard>
  );
}

function ActivityCard({
  repos,
  activityPaths,
}: {
  repos: RepoOverviewEntry[];
  /** When set (Only me), limit to repos where you've committed recently. */
  activityPaths: Set<string> | null;
}) {
  const now = Date.now();
  const scoped = activityPaths ? repos.filter((r) => activityPaths.has(r.path)) : repos;
  const sorted = [...scoped].sort((a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));
  const age = (r: RepoOverviewEntry) => (r.lastActivityTs ? now - r.lastActivityTs : Infinity);
  const buckets = [
    { label: "Active this week", dot: "bg-emerald-500", list: sorted.filter((r) => age(r) <= 7 * DAY_MS) },
    {
      label: "Quiet for 1–4 weeks",
      dot: "bg-amber-500",
      list: sorted.filter((r) => age(r) > 7 * DAY_MS && age(r) <= 30 * DAY_MS),
    },
    { label: "No commits for over a month", dot: "bg-zinc-400", list: sorted.filter((r) => age(r) > 30 * DAY_MS) },
  ];
  return (
    <PanelCard title="Repos by activity">
      {buckets.map((b) => (
        <ActivityBucket key={b.label} {...b} />
      ))}
    </PanelCard>
  );
}

function ActivityBucket({ label, dot, list }: { label: string; dot: string; list: RepoOverviewEntry[] }) {
  const { navigateTo } = useHashRoute();
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, CHIP_LIMIT);
  const chip =
    "rounded-md bg-black/[0.04] px-[7px] py-[3px] font-mono text-xs text-zinc-700 transition-colors hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.1]";
  return (
    <div className="flex flex-col gap-[7px]">
      <span className="flex items-center gap-[7px] text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-300">
        <span className={cn("size-[7px] rounded-full", dot)} />
        {label}
        <span className="font-normal text-zinc-500 dark:text-zinc-400">{list.length}</span>
      </span>
      {list.length > 0 && (
        <div className="flex flex-wrap gap-[5px]">
          {shown.map((r) => (
            <button key={r.id} type="button" className={chip} onClick={() => navigateTo("repo-detail", { path: r.path })}>
              {r.name}
            </button>
          ))}
          {list.length > shown.length && (
            <button type="button" className={chip} onClick={() => setAll(true)}>
              + {list.length - shown.length} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WorkGraphSkeleton() {
  return (
    <Page>
      <div className="flex items-end gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Bone className="h-7 w-36 rounded-lg" />
          <Bone className="h-4 w-[480px] rounded-md" />
        </div>
        <Bone className="h-8 w-40 rounded-[9px]" />
      </div>
      <PageLoading caption="Reading commits, branches and pull requests…">
        <Bone className="h-48" />
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3">
          <Bone className="h-60" />
          <Bone className="h-60" />
        </div>
      </PageLoading>
    </Page>
  );
}
