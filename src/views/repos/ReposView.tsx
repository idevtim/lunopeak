import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Code2, FolderGit2, Search, SquareTerminal } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card } from "@/components/ui/Page";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState } from "@/components/ui/PageStates";
import { formatUsd, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toastStore";
import type { RepoOverviewEntry } from "@/types/api";
import { RepoListSkeleton } from "./RepoListSkeleton";
import { costByRepo, reposWithAgents, shortAgo, tildePath } from "./repoUtils";

type RepoFilter = "all" | "dirty" | "unpushed" | "noclaude";

function parseFilter(raw: string | null): RepoFilter {
  // `uncommitted` is the legacy alias older dashboard links use.
  if (raw === "dirty" || raw === "uncommitted") return "dirty";
  if (raw === "unpushed") return raw;
  if (raw === "noclaude" || raw === "nomd") return "noclaude";
  return "all";
}

const MATCHES: Record<RepoFilter, (r: RepoOverviewEntry) => boolean> = {
  all: () => true,
  dirty: (r) => r.hasUncommitted,
  unpushed: (r) => r.unpushedCommits > 0,
  noclaude: (r) => !r.hasClaudeMd,
};

const FILTERS: { id: RepoFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "dirty", label: "Not committed" },
  { id: "unpushed", label: "Not pushed" },
  { id: "noclaude", label: "No CLAUDE.md" },
];

const GRID = "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_90px_80px_96px] items-center gap-3.5";

export function ReposView() {
  const [query, setQuery] = useState("");
  const { params, navigateTo } = useHashRoute();
  const filter = parseFilter(params.get("filter"));
  const overview = useQuery(queries.reposOverview);
  const settings = useQuery(queries.settings);
  const sessions = useQuery(queries.sessions);
  const processes = useQuery({ ...queries.activeProcesses, refetchInterval: 10_000 });
  const showSkeleton = useDelayedLoading(overview.isLoading);

  const repos = useMemo(
    () =>
      [...(overview.data?.repos ?? [])].sort(
        (a, b) => (b.lastActivityTs ?? 0) - (a.lastActivityTs ?? 0),
      ),
    [overview.data],
  );
  const costs = useMemo(() => costByRepo(repos, sessions.data), [repos, sessions.data]);
  const working = useMemo(() => reposWithAgents(repos, processes.data), [repos, processes.data]);

  const addFolder = () => navigateTo("settings", { tab: "agents" });

  if (overview.isError) {
    return (
      <Page>
        <PageHeader title="Repos" />
        <ErrorState
          title="Couldn’t scan your repos"
          body="LunoPeak couldn’t read your project folders. Check they still exist, then try again."
          onRetry={() => void overview.refetch()}
          error={overview.error}
        />
      </Page>
    );
  }
  if (!overview.data) return showSkeleton ? <RepoListSkeleton /> : null;

  if (repos.length === 0) {
    return (
      <Page>
        <PageHeader title="Repos" />
        <EmptyState
          icon={FolderGit2}
          title="No repos found"
          body="LunoPeak looks for git repos inside your project folders. Add the folder where you keep your code."
          primary={{ label: "Add project folder", onClick: addFolder }}
        />
      </Page>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = repos.filter(
    (r) =>
      MATCHES[filter](r) &&
      (!q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)),
  );
  const setFilter = (next: RepoFilter) =>
    navigateTo("repos", next === "all" ? {} : { filter: next });

  return (
    <Page>
      <PageHeader
        title="Repos"
        lead={<ReposLead repos={repos} scanDirs={settings.data?.scanDirs ?? []} />}
        actions={<Button onClick={addFolder}>Add folder…</Button>}
      />

      <div className="flex items-center gap-2.5">
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[13px] focus-within:border-blue-500/50 dark:border-white/[0.12] dark:bg-white/[0.04]">
          <Search size={13} strokeWidth={2} className="shrink-0 text-zinc-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a repo"
            className="min-w-0 flex-1 bg-transparent text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
          />
        </label>
        <div className="flex gap-1.5">
          {FILTERS.map((f) => {
            const on = f.id === filter;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-[5px] text-[12.5px] font-medium transition-colors",
                  on
                    ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                    : "border-black/10 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.08]",
                )}
              >
                {f.label}
                <span className="text-[11.5px] font-semibold tabular-nums opacity-70">
                  {repos.filter(MATCHES[f.id]).length}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Card className="flex flex-col overflow-hidden">
        <div
          className={cn(
            GRID,
            "border-b border-black/[0.05] px-[18px] py-2.5 text-[11.5px] font-semibold text-zinc-500 dark:border-white/[0.06] dark:text-zinc-400",
          )}
        >
          <span>Repo</span>
          <span>Status</span>
          <span className="text-right">Last change</span>
          <span className="text-right" title="Claude Code spend in this repo over the last 30 days">
            Agent cost
          </span>
          <span />
        </div>
        {visible.map((r, i) => (
          <RepoRow
            key={r.id}
            repo={r}
            first={i === 0}
            cost={costs.get(r.path)}
            agentWorking={working.has(r.path)}
            onOpen={() => navigateTo("repo-detail", { path: r.path })}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-[18px] py-6 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
            No repos match this filter.
          </div>
        )}
      </Card>
    </Page>
  );
}

function ReposLead({ repos, scanDirs }: { repos: RepoOverviewEntry[]; scanDirs: string[] }) {
  const dirty = repos.filter((r) => r.hasUncommitted).length;
  const unpushed = repos.filter((r) => r.unpushedCommits > 0).length;
  const dirs = scanDirs.map(tildePath);
  const where =
    dirs.length === 0
      ? ""
      : dirs.length <= 2
        ? ` in ${dirs.join(" and ")}`
        : ` in ${plural(dirs.length, "folder")}`;
  const parts: string[] = [];
  if (dirty > 0) parts.push(`${dirty} ${dirty === 1 ? "has changes that aren’t" : "have changes that aren’t"} committed`);
  if (unpushed > 0) parts.push(`${unpushed} ${unpushed === 1 ? "has commits that aren’t" : "have commits that aren’t"} pushed`);
  return (
    <>
      <b>{plural(repos.length, "repo")}</b>
      {where}.{" "}
      {parts.length > 0
        ? `${parts.join(", ")}.`.replace(/^./, (c) => c.toUpperCase())
        : "Everything is committed and pushed."}
    </>
  );
}

interface StatusTag {
  label: string;
  tone: PillTone;
}

function statusTags(repo: RepoOverviewEntry, agentWorking: boolean): StatusTag[] {
  const tags: StatusTag[] = [];
  if (repo.hasUncommitted) {
    tags.push({
      label:
        repo.uncommittedFiles > 0
          ? `${plural(repo.uncommittedFiles, "file")} changed`
          : "Changes not committed",
      tone: "blue",
    });
  }
  if (repo.unpushedCommits > 0) {
    tags.push({ label: `${plural(repo.unpushedCommits, "commit")} to push`, tone: "violet" });
  }
  if (agentWorking) tags.push({ label: "Agent working", tone: "green" });
  if (!repo.hasClaudeMd) tags.push({ label: "No CLAUDE.md", tone: "amber" });
  if (tags.length === 0) tags.push({ label: "Clean", tone: "green" });
  return tags;
}

function RepoRow({
  repo,
  first,
  cost,
  agentWorking,
  onOpen,
}: {
  repo: RepoOverviewEntry;
  first: boolean;
  cost: number | undefined;
  agentWorking: boolean;
  onOpen: () => void;
}) {
  const openInEditor = useOpenInEditor();
  const openTerminal = () =>
    api
      .openInTerminal(repo.path)
      .catch((e) =>
        toast.error("Couldn’t open the terminal", e instanceof Error ? e.message : String(e)),
      );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className={cn(
        GRID,
        "cursor-pointer px-[18px] py-2.5 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
        !first && "border-t border-black/[0.04] dark:border-white/[0.05]",
      )}
    >
      <div className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
          {repo.name}
        </span>
        <span className="truncate font-mono text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {repo.branch ?? "no branch"}
        </span>
      </div>
      <div className="flex flex-wrap gap-[5px]">
        {statusTags(repo, agentWorking).map((t) => (
          <Pill key={t.label} tone={t.tone}>
            {t.label}
          </Pill>
        ))}
      </div>
      <span className="text-right text-[12.5px] text-zinc-600 dark:text-zinc-400">
        {repo.lastActivityTs ? shortAgo(repo.lastActivityTs) : "—"}
      </span>
      <span className="text-right text-[12.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {cost && cost >= 0.005 ? formatUsd(cost) : "—"}
      </span>
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <IconButton title="Open in editor" onClick={() => openInEditor(repo.path)}>
          <Code2 size={13} strokeWidth={2} />
        </IconButton>
        <IconButton title="Open in terminal" onClick={openTerminal}>
          <SquareTerminal size={13} strokeWidth={2} />
        </IconButton>
        <button
          type="button"
          title="Details"
          aria-label={`Open ${repo.name}`}
          onClick={onOpen}
          className="flex size-7 items-center justify-center rounded-[7px] text-zinc-400 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
        >
          <ChevronRight size={13} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-[7px] border border-black/[0.08] bg-white text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.08]"
    >
      {children}
    </button>
  );
}
