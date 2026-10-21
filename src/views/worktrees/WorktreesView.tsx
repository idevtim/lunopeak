import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, GitBranch } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Card, Mono, Page, PageHeader } from "@/components/ui/Page";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { providerLabel } from "@/views/tray-panel/shared";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LiveContext, WorktreeEntry } from "@/types/api";

// Fixed tracks so the columns line up across repo groups.
const GRID = "grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_230px_110px_130px] items-center gap-3.5";

const tildify = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, "~");

/** worktreePath → agent of the running session inside it (deepest match wins). */
function sessionsByWorktree(worktrees: WorktreeEntry[], contexts: LiveContext[]) {
  const out = new Map<string, LiveContext["agent"]>();
  for (const c of contexts) {
    if (!c.cwd) continue;
    let best: string | null = null;
    for (const w of worktrees) {
      const p = w.worktreePath;
      if ((c.cwd === p || c.cwd.startsWith(p + "/")) && (!best || p.length > best.length)) best = p;
    }
    if (best) out.set(best, c.agent);
  }
  return out;
}

export function WorktreesView() {
  const qc = useQueryClient();
  const worktrees = useQuery(queries.worktrees);
  const contexts = useQuery(queries.liveContexts);
  const openInEditor = useOpenInEditor();
  const showSkeleton = useDelayedLoading(worktrees.isLoading);

  const refresh = () => qc.invalidateQueries({ queryKey: queries.worktrees.queryKey });
  const prune = useMutation({
    mutationFn: (rows: WorktreeEntry[]) =>
      api.pruneWorktrees([...new Set(rows.map((w) => w.repoPath))]),
    onSuccess: (_d, rows) => toast.success(`Removed ${plural(rows.length, "worktree")}`),
    onError: (e) => toast.error("Couldn't remove worktrees", e instanceof Error ? e.message : String(e)),
    onSettled: refresh,
  });
  const unlock = useMutation({
    mutationFn: (w: WorktreeEntry) => api.unlockWorktree(w.repoPath, w.worktreePath),
    onSuccess: (_d, w) => toast.success("Worktree unlocked", tildify(w.worktreePath)),
    onError: (e) => toast.error("Couldn't unlock worktree", e instanceof Error ? e.message : String(e)),
    onSettled: refresh,
  });

  if (worktrees.isLoading) return showSkeleton ? <WorktreesSkeleton /> : null;
  if (worktrees.error) {
    return (
      <Page>
        <PageHeader title="Worktrees" />
        <ErrorState
          title="Couldn't read your worktrees"
          body="LunoPeak asks git for each repo's worktrees. Check that git is installed and on your PATH."
          onRetry={() => void worktrees.refetch()}
          error={worktrees.error}
        />
      </Page>
    );
  }

  const list = worktrees.data ?? [];
  const inUse = sessionsByWorktree(list, contexts.data ?? []);
  const grouped = new Map<string, WorktreeEntry[]>();
  for (const w of list) grouped.set(w.repoName, [...(grouped.get(w.repoName) ?? []), w]);
  const repos = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  const unused = list.filter((w) => w.prunable);

  // Each repo prunes as a whole, so the dialog lists every worktree it clears.
  const askRemove = async (rows: WorktreeEntry[]) => {
    const n = rows.length;
    const ok = await confirm({
      title: n === 1 ? "Remove this worktree?" : `Remove ${n} unused worktrees?`,
      body: "Their folders are already gone; this clears git's record of them. Branches and commits are kept.",
      items: rows.map((w) => tildify(w.worktreePath)),
      confirmLabel: n === 1 ? "Remove worktree" : `Remove ${n} worktrees`,
      destructive: true,
    });
    if (ok) prune.mutate(rows);
  };

  return (
    <Page>
      <PageHeader
        title="Worktrees"
        lead={
          <>
            Worktrees let a repo have several branches checked out at once, each in its own
            folder. Agents often use them to work in parallel.{" "}
            {list.length > 0 && (
              <>
                <b>{plural(list.length, "worktree")}</b> in {plural(repos.length, "repo")}
                {unused.length > 0 ? `; ${unused.length} can be removed.` : "."}
              </>
            )}
          </>
        }
        actions={
          unused.length > 0 && (
            <Button
              variant="primary"
              disabled={prune.isPending}
              onClick={() => void askRemove(unused)}
            >
              Remove {unused.length} unused
            </Button>
          )
        }
      />

      {repos.length === 0 ? (
        <EmptyState
          icon={FolderTree}
          title="No extra worktrees"
          body="Each repo has only its main folder. Agents sometimes create worktrees to work on branches in parallel."
        />
      ) : (
        <>
          {repos.map((repo) => (
            <section key={repo} className="flex flex-col gap-2">
              <Mono className="px-0.5 text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
                {repo}
              </Mono>
              <Card className="py-0.5">
                {grouped.get(repo)!.map((w, i) => (
                  <WorktreeRow
                    key={w.worktreePath}
                    entry={w}
                    first={i === 0}
                    agent={inUse.get(w.worktreePath) ?? null}
                    busy={prune.isPending || unlock.isPending}
                    onOpen={() => openInEditor(w.worktreePath)}
                    onUnlock={async () => {
                      const ok = await confirm({
                        title: "Unlock this worktree?",
                        body: "Once unlocked, git can prune it if its folder goes missing.",
                        items: [tildify(w.worktreePath)],
                        confirmLabel: "Unlock",
                      });
                      if (ok) unlock.mutate(w);
                    }}
                    onRemove={() =>
                      void askRemove(grouped.get(repo)!.filter((x) => x.prunable))
                    }
                  />
                ))}
              </Card>
            </section>
          ))}
          <span className="px-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Removing a worktree deletes its folder, not its branch or commits.
          </span>
        </>
      )}
    </Page>
  );
}

function WorktreeRow({
  entry: w,
  first,
  agent,
  busy,
  onOpen,
  onUnlock,
  onRemove,
}: {
  entry: WorktreeEntry;
  first: boolean;
  agent: LiveContext["agent"] | null;
  busy: boolean;
  onOpen: () => void;
  onUnlock: () => void;
  onRemove: () => void;
}) {
  const status = w.isMain ? (
    <Pill>Main folder</Pill>
  ) : w.prunable ? (
    <Pill tone="amber">Can be removed: folder is gone</Pill>
  ) : agent ? (
    <Pill tone="green">In use by a {providerLabel(agent)} session</Pill>
  ) : w.locked ? (
    <Pill tone="blue">Locked</Pill>
  ) : (
    <Pill>Not in use</Pill>
  );

  return (
    <div
      className={cn(
        GRID,
        "px-[18px] py-2.5",
        !first && "border-t border-black/[0.04] dark:border-white/[0.05]",
        w.prunable && "opacity-85",
      )}
    >
      <Mono className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100" title={w.worktreePath}>
        {tildify(w.worktreePath)}
      </Mono>
      <span className="flex min-w-0 items-center gap-1.5">
        <GitBranch size={12} strokeWidth={2} className="shrink-0 text-zinc-500" />
        <Mono className="truncate text-[12.5px] text-zinc-700 dark:text-zinc-300">
          {w.branch ?? "detached"}
        </Mono>
      </span>
      {status}
      <Mono className="text-right text-zinc-500 dark:text-zinc-400" title="Latest commit">
        {w.head?.slice(0, 7) ?? "—"}
      </Mono>
      <span className="flex justify-end gap-1.5">
        {w.prunable ? (
          <Button disabled={busy} onClick={onRemove}>
            Remove
          </Button>
        ) : (
          <>
            <Button onClick={onOpen}>Open</Button>
            {w.locked && (
              <Button disabled={busy} onClick={onUnlock}>
                Unlock
              </Button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

function WorktreesSkeleton() {
  return (
    <Page>
      <PageHeader title="Worktrees" />
      <PageLoading caption="Finding your worktrees…">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Bone className="h-4 w-32 rounded-md" />
            <Bone className="h-[124px]" />
          </div>
        ))}
      </PageLoading>
    </Page>
  );
}
