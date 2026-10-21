import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, FolderGit2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import type { RepoOverviewEntry, RepoStash } from "@/types/api";
import { ListRow, PanelCard } from "@/views/repos/Panel";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isDetached(branch: string | null): boolean {
  // A 7-char hex "branch" is the short SHA git reports for a detached HEAD.
  return !!branch && /^[0-9a-f]{7}$/i.test(branch);
}

function problemCount(r: RepoOverviewEntry): number {
  return (
    Number(r.hasUncommitted) +
    Number(r.unpushedCommits > 0) +
    Number(r.stashCount > 0) +
    Number(!r.hasClaudeMd) +
    Number(isDetached(r.branch))
  );
}

export function RepoPulseView() {
  const { navigateTo } = useHashRoute();
  const overview = useQuery(queries.reposOverview);
  const showSkeleton = useDelayedLoading(overview.isLoading);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const checkAgain = async () => {
    setChecking(true);
    const res = await overview.refetch();
    setChecking(false);
    if (res.isError) toast.error("Couldn’t check your repos", errorText(res.error));
    else toast.success("Checked again", "Your repo list is up to date.");
  };

  if (overview.isError) {
    return (
      <Page>
        <PageHeader title="Repo pulse" />
        <ErrorState
          title="Couldn’t check your repos"
          body="LunoPeak couldn’t run git in your project folders. Check they still exist, then try again."
          onRetry={() => void overview.refetch()}
          error={overview.error}
        />
      </Page>
    );
  }
  if (!overview.data) return showSkeleton ? <RepoPulseSkeleton /> : null;

  const repos = overview.data.repos;
  if (repos.length === 0) {
    return (
      <Page>
        <PageHeader title="Repo pulse" />
        <EmptyState
          icon={FolderGit2}
          title="No repos found"
          body="LunoPeak looks for git repos inside your project folders. Add the folder where you keep your code."
          primary={{ label: "Add project folder", onClick: () => navigateTo("settings", { tab: "agents" }) }}
        />
      </Page>
    );
  }

  const attention = repos
    .filter((r) => problemCount(r) > 0)
    .sort((a, b) => problemCount(b) - problemCount(a) || (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0));
  const clean = repos.filter((r) => problemCount(r) === 0).sort((a, b) => a.name.localeCompare(b.name));
  const action = (
    <Button onClick={() => void checkAgain()} disabled={checking}>
      {checking ? "Checking…" : "Check again"}
    </Button>
  );

  if (attention.length === 0) {
    return (
      <Page>
        <PageHeader title="Repo pulse" actions={action} />
        <EmptyState
          healthy
          icon={Check}
          title="Every repo looks healthy"
          body={`Nothing uncommitted, unpushed or stashed across ${plural(repos.length, "repo")}.`}
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Repo pulse"
        lead={
          <>
            A health check across your repos. <b>{attention.length} {attention.length === 1 ? "needs" : "need"} a look</b>,{" "}
            {clean.length} {clean.length === 1 ? "is" : "are"} clean.
          </>
        }
        actions={action}
      />

      <div className="grid grid-cols-2 items-start gap-3">
        {attention.map((r) => (
          <RepoCard key={r.id} repo={r} />
        ))}
      </div>

      {clean.length > 0 && (
        <Card className="flex flex-col">
          <button
            type="button"
            onClick={() => setCleanOpen((o) => !o)}
            aria-expanded={cleanOpen}
            className="flex items-center gap-2.5 rounded-[14px] px-[18px] py-3.5 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/[0.14] text-emerald-600 dark:text-emerald-400">
              <Check size={12} strokeWidth={3} />
            </span>
            <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {clean.length === 1 ? "1 repo is clean" : `${clean.length} repos are clean`}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{cleanOpen ? "Hide" : "Show"}</span>
            <ChevronRight
              size={14}
              strokeWidth={2.25}
              className={cn("text-zinc-500 transition-transform", cleanOpen && "rotate-90")}
            />
          </button>
          {cleanOpen && (
            <div className="flex flex-wrap gap-1.5 px-[18px] pb-4">
              {clean.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => navigateTo("repo-detail", { path: r.path })}
                  className="rounded-md bg-black/[0.04] px-[7px] py-[3px] font-mono text-xs text-zinc-700 transition-colors hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.1]"
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}

function RepoCard({ repo }: { repo: RepoOverviewEntry }) {
  const qc = useQueryClient();
  const { navigateTo } = useHashRoute();
  const [showStashes, setShowStashes] = useState(false);
  const [busy, setBusy] = useState(false);
  const openRepo = () => navigateTo("repo-detail", { path: repo.path });

  const addClaudeMd = async () => {
    setBusy(true);
    try {
      await api.createClaudeMd(repo.path);
      toast.success("Created CLAUDE.md", `Fill it in so agents know how ${repo.name} works.`);
      void qc.invalidateQueries({ queryKey: queries.reposOverview.queryKey });
    } catch (e) {
      toast.error("Couldn’t create CLAUDE.md", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: { key: string; text: ReactNode; action: ReactNode; extra?: ReactNode }[] = [];
  if (repo.hasUncommitted) {
    rows.push({
      key: "dirty",
      text:
        repo.uncommittedFiles > 0
          ? `${plural(repo.uncommittedFiles, "file")} changed but not committed`
          : "Changes that aren’t committed",
      action: <Button onClick={openRepo}>Review</Button>,
    });
  }
  if (repo.unpushedCommits > 0) {
    // No push command yet — hand off to a terminal in the repo.
    rows.push({
      key: "unpushed",
      text: `${plural(repo.unpushedCommits, "commit")} not pushed to origin`,
      action: (
        <Button
          onClick={() =>
            api.openInTerminal(repo.path).catch((e) => toast.error("Couldn’t open the terminal", errorText(e)))
          }
        >
          Open terminal
        </Button>
      ),
    });
  }
  if (repo.stashCount > 0) {
    rows.push({
      key: "stash",
      text: `${plural(repo.stashCount, "stash", "stashes")} saved and never applied`,
      action: (
        <Button onClick={() => setShowStashes((v) => !v)}>
          {showStashes ? "Hide" : repo.stashCount === 1 ? "View stash" : "View stashes"}
        </Button>
      ),
      extra: showStashes && <StashList repoPath={repo.path} />,
    });
  }
  if (isDetached(repo.branch)) {
    rows.push({
      key: "detached",
      text: (
        <>
          Not on a branch (detached at <Mono>{repo.branch}</Mono>)
        </>
      ),
      action: <Button onClick={openRepo}>Open</Button>,
    });
  }
  if (!repo.hasClaudeMd) {
    rows.push({
      key: "claude-md",
      text: "Missing CLAUDE.md",
      action: (
        <Button onClick={() => void addClaudeMd()} disabled={busy}>
          {busy ? "Adding…" : "Add CLAUDE.md"}
        </Button>
      ),
    });
  }

  return (
    <PanelCard
      title={
        <button
          type="button"
          onClick={openRepo}
          className="font-mono text-[13.5px] font-semibold hover:underline"
        >
          {repo.name}
        </button>
      }
      aside={<Pill tone="amber">{plural(rows.length, "thing")}</Pill>}
    >
      <div className="flex flex-col">
        {rows.map((r, i) => (
          <div key={r.key}>
            <ListRow first={i === 0} className="gap-3 py-2">
              <span className="flex-1 text-[13px] text-zinc-800 text-pretty dark:text-zinc-200">{r.text}</span>
              {r.action}
            </ListRow>
            {r.extra}
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

function StashList({ repoPath }: { repoPath: string }) {
  const stashes = useQuery(queries.repoStashes(repoPath));
  if (stashes.isLoading) return <Bone className="mb-2 h-10" />;
  if (stashes.isError) {
    return <p className="m-0 pb-2 text-xs text-rose-700 dark:text-rose-400">Couldn’t list stashes.</p>;
  }
  const list = stashes.data ?? [];
  if (list.length === 0) {
    return <p className="m-0 pb-2 text-xs text-zinc-500 dark:text-zinc-400">No stashes left.</p>;
  }
  return (
    <div className="mb-2 flex flex-col gap-1.5">
      {list.map((s) => (
        <StashRow key={s.reflog} repoPath={repoPath} stash={s} />
      ))}
    </div>
  );
}

function StashRow({ repoPath, stash }: { repoPath: string; stash: RepoStash }) {
  const qc = useQueryClient();
  const [dropping, setDropping] = useState(false);

  const drop = async () => {
    const ok = await confirm({
      title: "Drop this stash?",
      body: "The changes saved in it are deleted for good. Apply it first if you still need them.",
      items: [`${stash.reflog}  ${stash.subject}`],
      confirmLabel: "Drop stash",
      destructive: true,
    });
    if (!ok) return;
    setDropping(true);
    try {
      await api.gitDropStash(repoPath, stash.reflog);
      toast.success("Dropped the stash", stash.subject);
      // Dropping renumbers the rest, so refetch rather than splice.
      void qc.invalidateQueries({ queryKey: queries.repoStashes(repoPath).queryKey });
      void qc.invalidateQueries({ queryKey: queries.reposOverview.queryKey });
    } catch (e) {
      toast.error("Couldn’t drop the stash", errorText(e));
    } finally {
      setDropping(false);
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-[10px] bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] text-zinc-800 dark:text-zinc-200">{stash.subject}</span>
        <Mono className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {stash.reflog}
          {stash.files.length > 0 && ` · ${plural(stash.files.length, "file")}`}
        </Mono>
      </div>
      <Button variant="ghost" onClick={() => void drop()} disabled={dropping} className="text-rose-700 dark:text-rose-400">
        {dropping ? "Dropping…" : "Drop"}
      </Button>
    </div>
  );
}

function RepoPulseSkeleton() {
  return (
    <Page>
      <div className="flex items-end gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Bone className="h-7 w-36 rounded-lg" />
          <Bone className="h-4 w-80 rounded-md" />
        </div>
        <Bone className="h-7 w-24 rounded-lg" />
      </div>
      <PageLoading caption="Checking which repos need a look…">
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Bone key={i} className="h-36" />
          ))}
        </div>
        <Bone className="h-12" />
      </PageLoading>
    </Page>
  );
}
