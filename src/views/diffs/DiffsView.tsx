import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { FileDiff as FileDiffIcon } from "lucide-react";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { Button } from "@/components/ui/Button";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FileDiff, RepoOverviewEntry, Session } from "@/types/api";
import { dayLabel, isUnder, repoForPath } from "@/views/repos/repoUtils";
import { FileDiffList, LineCounts } from "./FileDiffList";

/** Sessions listed in the left pane. Each distinct repo among them costs one `git diff`. */
const MAX_SESSIONS = 30;

interface SessionChanges {
  session: Session;
  repo: RepoOverviewEntry | undefined;
  /** Repo-relative paths (absolute when the file sits outside any tracked repo). */
  files: string[];
}

function toAbsolute(file: string, cwd: string | null): string {
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || !cwd) return file;
  return `${cwd.replace(/[\\/]$/, "")}/${file}`;
}

function relativeTo(file: string, root: string): string {
  return isUnder(file, root) ? file.slice(root.length).replace(/^[\\/]/, "") : file;
}

export function DiffsView() {
  const sessions = useQuery(queries.sessions);
  const overview = useQuery(queries.reposOverview);
  const showSkeleton = useDelayedLoading(sessions.isLoading);
  const [selected, setSelected] = useState<string | null>(null);

  const list: SessionChanges[] = useMemo(() => {
    const repos = overview.data?.repos ?? [];
    return (sessions.data ?? [])
      .filter((s) => s.filesEdited && Object.keys(s.filesEdited).length > 0)
      .sort((a, b) => b.endTs - a.endTs)
      .slice(0, MAX_SESSIONS)
      .map((session) => {
        const repo = repoForPath(repos, session.projectPath);
        const files = Object.keys(session.filesEdited ?? {}).map((f) => {
          const abs = toAbsolute(f, session.projectPath);
          return repo ? relativeTo(abs, repo.path) : abs;
        });
        return { session, repo, files };
      });
  }, [sessions.data, overview.data]);

  // Uncommitted diffs for every repo in the list, keyed by repo path.
  const repoPaths = useMemo(
    () => [...new Set(list.flatMap((c) => (c.repo ? [c.repo.path] : [])))],
    [list],
  );
  const diffQueries = useQueries({ queries: repoPaths.map((p) => queries.repoFileDiffs(p)) });
  const diffsByRepo = new Map<string, Map<string, FileDiff>>();
  const failedRepos = new Set<string>();
  repoPaths.forEach((p, i) => {
    const q = diffQueries[i];
    if (q?.data) diffsByRepo.set(p, new Map(q.data.map((d) => [d.path, d])));
    else if (q?.isError) failedRepos.add(p);
  });

  if (sessions.isError) {
    return (
      <Page>
        <PageHeader title="Diffs" />
        <ErrorState
          title="Couldn’t read your session logs"
          body="LunoPeak couldn’t open your Claude Code session logs. They may have moved, or LunoPeak needs Full Disk Access."
          onRetry={() => void sessions.refetch()}
          error={sessions.error}
        />
      </Page>
    );
  }
  if (!sessions.data) return showSkeleton ? <DiffsSkeleton /> : null;
  if (list.length === 0) {
    return (
      <Page>
        <PageHeader title="Diffs" />
        <EmptyState
          icon={FileDiffIcon}
          title="No changes to show"
          body="When an agent edits files, you can review exactly what changed here."
        />
      </Page>
    );
  }

  const current = list.find((c) => c.session.id === selected) ?? list[0];
  const pendingFor = (c: SessionChanges) => {
    const diffs = c.repo ? diffsByRepo.get(c.repo.path) : undefined;
    return diffs ? c.files.flatMap((f) => diffs.get(f) ?? []) : null;
  };
  const totalPending = list.reduce((n, c) => n + (pendingFor(c)?.length ?? 0), 0);

  return (
    <Page>
      <PageHeader
        title="Diffs"
        lead={
          <>
            What each agent session changed in your code.{" "}
            {totalPending > 0 && (
              <>
                <b>{plural(totalPending, "file")}</b> from these sessions {totalPending === 1 ? "isn’t" : "aren’t"}{" "}
                committed yet.
              </>
            )}
          </>
        }
      />
      <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3">
        <Card className="flex flex-col gap-0.5 p-1.5">
          {list.map((c) => {
            const pending = pendingFor(c);
            const active = c === current;
            return (
              <button
                key={c.session.id}
                type="button"
                onClick={() => setSelected(c.session.id)}
                aria-pressed={active}
                className={cn(
                  "flex gap-2.5 rounded-[9px] p-2.5 text-left transition-colors",
                  active
                    ? "bg-black/[0.055] dark:bg-white/[0.08]"
                    : "hover:bg-black/[0.035] dark:hover:bg-white/[0.05]",
                )}
              >
                <ProviderIcon provider="claude" size={13} className="mt-0.5 text-amber-600 dark:text-amber-400" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={cn(
                      "truncate text-[13px] text-zinc-900 dark:text-zinc-100",
                      active ? "font-semibold" : "font-medium",
                    )}
                  >
                    {c.session.firstPrompt?.trim() || "Untitled session"}
                  </span>
                  <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                    {c.repo?.name ?? c.session.projectName ?? "Unknown folder"} · {dayLabel(c.session.endTs)}
                  </span>
                  <span className="flex gap-2 text-[11.5px] tabular-nums">
                    <span className="text-zinc-600 dark:text-zinc-400">{plural(c.files.length, "file")}</span>
                    {pending && pending.length > 0 && (
                      <LineCounts
                        className="text-[11.5px]"
                        insertions={pending.reduce((n, d) => n + d.insertions, 0)}
                        deletions={pending.reduce((n, d) => n + d.deletions, 0)}
                      />
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </Card>
        <SessionPane
          key={current.session.id}
          changes={current}
          pending={pendingFor(current)}
          gitFailed={!!current.repo && failedRepos.has(current.repo.path)}
        />
      </div>
    </Page>
  );
}

function SessionPane({
  changes,
  pending,
  gitFailed,
}: {
  changes: SessionChanges;
  /** Uncommitted diffs for this session's files; null while the repo's diff loads. */
  pending: FileDiff[] | null;
  gitFailed: boolean;
}) {
  const { navigateTo } = useHashRoute();
  const openInEditor = useOpenInEditor();
  const { session, repo, files } = changes;
  const pendingPaths = new Set((pending ?? []).map((d) => d.path));
  const committed = pending ? files.filter((f) => !pendingPaths.has(f)) : [];
  const folder = repo?.path ?? session.projectPath;

  let summary = plural(files.length, "file") + " changed";
  if (!repo) summary += " · outside your tracked repos";
  else if (gitFailed) summary += " · couldn’t read git status";
  else if (pending === null) summary += " · checking git…";
  else if (pending.length === files.length) summary += " · not committed yet";
  else if (pending.length === 0) summary += " · all committed since";
  else summary += ` · ${pending.length} not committed yet`;

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-black/[0.05] px-4 py-3 dark:border-white/[0.06]">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {session.firstPrompt?.trim() || "Untitled session"}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{summary}</span>
        </div>
        {folder && <Button onClick={() => openInEditor(folder)}>Open in editor</Button>}
        <Button onClick={() => navigateTo("session-replay", { id: session.id })}>Replay session</Button>
      </div>
      {gitFailed ? (
        <p className="m-0 px-4 py-3 text-[12.5px] text-rose-700 dark:text-rose-400">
          Couldn’t run git diff in {repo?.name}. Open the repo to check it.
        </p>
      ) : repo && pending === null ? (
        <div className="flex flex-col gap-2 p-4 animate-lp-pulse">
          <Bone className="h-8" />
          <Bone className="h-32" />
        </div>
      ) : (
        <>
          {pending && pending.length > 0 && <FileDiffList files={pending} />}
          {(repo ? committed : files).length > 0 && (
            <div
              className={cn(
                "flex flex-col gap-1.5 px-4 py-3",
                pending && pending.length > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
              )}
            >
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {repo
                  ? "Already committed, so there’s no diff to show here:"
                  : "Edited outside a tracked repo:"}
              </span>
              {(repo ? committed : files).map((f) => (
                <Mono key={f} className="truncate text-[12.5px] text-zinc-700 dark:text-zinc-300">
                  {f}
                </Mono>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function DiffsSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2">
        <Bone className="h-7 w-24 rounded-lg" />
        <Bone className="h-4 w-80 rounded-md" />
      </div>
      <PageLoading caption="Collecting what each session changed…">
        <div className="grid grid-cols-[300px_minmax(0,1fr)] gap-3">
          <Bone className="h-[360px]" />
          <Bone className="h-[360px]" />
        </div>
      </PageLoading>
    </Page>
  );
}
