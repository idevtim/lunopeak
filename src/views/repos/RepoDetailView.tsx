import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Circle,
  Code2,
  Copy,
  FolderGit2,
  FolderOpen,
  GitPullRequestArrow,
  SquareTerminal,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { primaryInstalledAgent, useInstalledAgents } from "@/hooks/useInstalledAgents";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { fileManagerName, usePlatform } from "@/hooks/usePlatform";
import { BackLink } from "@/components/ui/BackLink";
import { Page, PageHeader, Mono } from "@/components/ui/Page";
import { Pill } from "@/components/ui/Pill";
import { Button, buttonClass } from "@/components/ui/Button";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { formatCount, formatUsd, plural } from "@/lib/format";
import { editorLabel } from "@/lib/editors";
import { cn } from "@/lib/utils";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import { useEditorPickerStore } from "@/stores/editorPickerStore";
import type { BranchInfo, DirtyFile, InstalledAgents, RepoDetail, RepoSetup } from "@/types/api";
import { FileDiffList } from "@/views/diffs/FileDiffList";
import { PanelCard, LinkButton, ListRow } from "./Panel";
import { aheadBehind, dayLabel, isUnder, shortAgo, tildePath } from "./repoUtils";

type Agent = "claude" | "codex" | "cursor";

const AGENT_LABEL: Record<Agent, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
const RECENT_SESSIONS = 5;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function RepoDetailView() {
  const { params } = useHashRoute();
  const path = params.get("path") ?? "";
  const detail = useQuery({ ...queries.repoDetail(path), enabled: path.length > 0 });
  const showSkeleton = useDelayedLoading(detail.isLoading);

  if (!path || (detail.isSuccess && !detail.data)) {
    return (
      <Page>
        <PageHeader title="Repo" above={<BackLink fallback="repos" />} />
        <EmptyState
          icon={FolderGit2}
          title="This repo isn’t tracked"
          body={
            path
              ? `LunoPeak no longer sees a repo at ${tildePath(path)}. It may have moved or been deleted.`
              : "Pick a repo from the list to see its details."
          }
        />
      </Page>
    );
  }
  if (detail.isError) {
    return (
      <Page>
        <PageHeader title="Repo" above={<BackLink fallback="repos" />} />
        <ErrorState
          title="Couldn’t read this repo"
          body={`LunoPeak couldn’t load ${tildePath(path)}. Check the folder still exists, then try again.`}
          onRetry={() => void detail.refetch()}
          error={detail.error}
        />
      </Page>
    );
  }
  if (!detail.data) return showSkeleton ? <DetailSkeleton /> : null;
  return <RepoDetailBody detail={detail.data} />;
}

function RepoDetailBody({ detail }: { detail: RepoDetail }) {
  const { entry } = detail;
  const installed = useInstalledAgents();
  const primary = primaryInstalledAgent(installed);

  const subtitle: ReactNode[] = [tildePath(entry.path)];
  if (entry.branch) {
    subtitle.push(
      <>
        on <Mono className="text-[12.5px] text-zinc-700 dark:text-zinc-300">{entry.branch}</Mono>
      </>,
    );
  }
  if (entry.lastCommitSubject) {
    subtitle.push(
      `last commit “${entry.lastCommitSubject}”${
        entry.lastActivityTs ? `, ${shortAgo(entry.lastActivityTs).toLowerCase()}` : ""
      }`,
    );
  }

  return (
    <Page>
      <PageHeader
        above={<BackLink fallback="repos" />}
        title={entry.name}
        lead={subtitle.map((part, i) => (
          <span key={i}>
            {i > 0 && " · "}
            {part}
          </span>
        ))}
      />

      <ActionBar path={entry.path} installed={installed} primary={primary} />

      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start gap-3">
        <div className="flex flex-col gap-3">
          {entry.hasUncommitted && <UncommittedCard path={entry.path} agent={primary} />}
          <RecentSessionsCard path={entry.path} />
        </div>
        <div className="flex flex-col gap-3">
          <UsageCard repoKey={entry.name} />
          <InstructionsCard detail={detail} />
          <BranchesCard path={entry.path} />
        </div>
      </div>
    </Page>
  );
}

// ── Actions ──────────────────────────────────────────────────────────

function openAgent(agent: Agent, path: string) {
  const fn =
    agent === "codex" ? api.openInCodex : agent === "cursor" ? api.openInCursor : api.openInClaude;
  return fn(path).catch((e) =>
    toast.error(`Couldn’t open ${AGENT_LABEL[agent]}`, errorText(e)),
  );
}

function installedAgents(installed: InstalledAgents | undefined): Agent[] {
  // Claude > Codex > Cursor, same order as `primaryInstalledAgent`.
  if (!installed) return ["claude", "codex", "cursor"];
  const out: Agent[] = [];
  if (installed.claudeCode) out.push("claude");
  if (installed.codex) out.push("codex");
  if (installed.cursor) out.push("cursor");
  return out;
}

function ActionBar({
  path,
  installed,
  primary,
}: {
  path: string;
  installed: InstalledAgents | undefined;
  primary: Agent | null;
}) {
  const qc = useQueryClient();
  const platform = usePlatform();
  const fmName = fileManagerName(platform);
  const settings = useQuery(queries.settings);
  const openInEditor = useOpenInEditor();
  const openPicker = useEditorPickerStore((s) => s.open);
  const defaultEditor = settings.data?.editor?.defaultEditor ?? null;
  const [pulling, setPulling] = useState(false);

  const pull = async () => {
    setPulling(true);
    try {
      const out = await api.gitPull(path);
      toast.success("Pulled the latest changes", out.trim() || "Already up to date.");
      void qc.invalidateQueries({ queryKey: queries.repoDetail(path).queryKey });
      void qc.invalidateQueries({ queryKey: queries.reposOverview.queryKey });
    } catch (e) {
      toast.error("Couldn’t pull", errorText(e));
    } finally {
      setPulling(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary && <AgentSplitButton path={path} agents={installedAgents(installed)} />}
      <span className="inline-flex">
        <button
          type="button"
          onClick={() => openInEditor(path)}
          className={cn(buttonClass("secondary"), "rounded-r-none border-r-0 py-1.5")}
        >
          <Code2 size={13} strokeWidth={2} />
          {defaultEditor ? editorLabel(defaultEditor) : "Open in editor"}
        </button>
        <button
          type="button"
          onClick={() => openPicker(path)}
          aria-label="Pick another editor"
          title="Pick another editor"
          className={cn(buttonClass("secondary"), "rounded-l-none px-1.5 py-1.5")}
        >
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </span>
      <Button
        className="py-1.5"
        onClick={() =>
          api.openInTerminal(path).catch((e) => toast.error("Couldn’t open the terminal", errorText(e)))
        }
      >
        <SquareTerminal size={13} strokeWidth={2} />
        Terminal
      </Button>
      <Button className="py-1.5" onClick={pull} disabled={pulling}>
        <GitPullRequestArrow size={13} strokeWidth={2} />
        {pulling ? "Pulling…" : "Pull latest"}
      </Button>
      <Button
        className="py-1.5"
        onClick={() =>
          api.revealInFinder(path).catch((e) => toast.error(`Couldn’t open ${fmName}`, errorText(e)))
        }
      >
        <FolderOpen size={13} strokeWidth={2} />
        {fmName}
      </Button>
      <Button
        className="py-1.5"
        onClick={() =>
          navigator.clipboard
            .writeText(path)
            .then(() => toast.success("Copied the path", path))
            .catch((e) => toast.error("Couldn’t copy", errorText(e)))
        }
      >
        <Copy size={13} strokeWidth={2} />
        Copy path
      </Button>
    </div>
  );
}

/** "Open in Claude ▾" — the arrow picks one of the other installed agents. */
function AgentSplitButton({ path, agents }: { path: string; agents: Agent[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const primary = agents[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const base =
    "flex items-center bg-zinc-900 text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => void openAgent(primary, path)}
        className={cn(base, "gap-[7px] rounded-l-lg px-3 py-[7px] text-[13px] font-medium", agents.length < 2 && "rounded-r-lg")}
      >
        <ProviderIcon provider={primary} size={13} />
        Open in {AGENT_LABEL[primary]}
      </button>
      {agents.length > 1 && (
        <button
          type="button"
          aria-label="Choose agent"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(base, "rounded-r-lg border-l border-white/20 px-2 py-[7px] dark:border-black/15")}
        >
          <ChevronDown size={13} strokeWidth={2} />
        </button>
      )}
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 flex min-w-[180px] flex-col rounded-[10px] border border-black/[0.08] bg-white p-1 shadow-lg dark:border-white/[0.1] dark:bg-zinc-900"
        >
          {agents.map((a) => (
            <button
              key={a}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void openAgent(a, path);
              }}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-zinc-800 hover:bg-black/[0.05] dark:text-zinc-200 dark:hover:bg-white/[0.06]"
            >
              <ProviderIcon provider={a} size={13} className="text-zinc-500" />
              Open in {AGENT_LABEL[a]}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ── Cards ────────────────────────────────────────────────────────────

function statusLetter(f: DirtyFile): { letter: string; tone: string } {
  const codes = `${f.staged}${f.unstaged}`;
  if (codes === "??" || codes.includes("A")) return { letter: "A", tone: "text-emerald-700 dark:text-emerald-400" };
  if (codes.includes("D")) return { letter: "D", tone: "text-rose-700 dark:text-rose-400" };
  if (codes.includes("R")) return { letter: "R", tone: "text-blue-700 dark:text-blue-400" };
  return { letter: "M", tone: "text-amber-700 dark:text-amber-400" };
}

const COMMIT_PROMPT =
  "Look at the uncommitted changes in this repo and commit them with a clear, conventional commit message. Split them into separate commits if they cover unrelated work.";

function UncommittedCard({ path, agent }: { path: string; agent: Agent | null }) {
  const dirty = useQuery(queries.repoDirtyFiles(path));
  const diffs = useQuery(queries.repoFileDiffs(path));
  const [showDiff, setShowDiff] = useState(false);
  const files = dirty.data ?? [];
  const counts = new Map((diffs.data ?? []).map((d) => [d.path, d]));

  const askToCommit = async () => {
    if (!agent) return;
    try {
      await navigator.clipboard.writeText(COMMIT_PROMPT);
      toast.success("Prompt copied", `Paste it into ${AGENT_LABEL[agent]} to commit these changes.`);
    } catch {
      // Clipboard can be blocked; opening the agent is still useful.
    }
    await openAgent(agent, path);
  };

  return (
    <PanelCard
      title="Not committed yet"
      aside={files.length > 0 && <Pill tone="blue">{plural(files.length, "file")}</Pill>}
    >
      {dirty.isError ? (
        <p className="m-0 text-[12.5px] text-rose-700 dark:text-rose-400">
          Couldn’t read git status for this repo.
        </p>
      ) : dirty.isLoading ? (
        <div className="flex flex-col gap-2 animate-lp-pulse">
          {Array.from({ length: 3 }).map((_, i) => (
            <Bone key={i} className="h-4 rounded" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">Everything is committed.</p>
      ) : showDiff ? (
        <div className="-mx-[18px] border-y border-black/[0.05] dark:border-white/[0.06]">
          {diffs.isError ? (
            <p className="m-0 px-4 py-3 text-[12.5px] text-rose-700 dark:text-rose-400">
              Couldn’t read the diff for this repo.
            </p>
          ) : diffs.data ? (
            <FileDiffList files={diffs.data} />
          ) : (
            <Bone className="m-4 h-24" />
          )}
        </div>
      ) : (
        <div className="flex flex-col">
          {files.map((f, i) => {
            const s = statusLetter(f);
            const c = counts.get(f.path);
            return (
              <ListRow key={`${f.staged}${f.unstaged}${f.path}`} first={i === 0}>
                <span className={cn("w-4 text-[11.5px] font-bold", s.tone)}>{s.letter}</span>
                <Mono className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">
                  {f.path}
                </Mono>
                {c && !c.binary && (
                  <Mono className="text-zinc-500 dark:text-zinc-400">
                    +{c.insertions}
                    {c.deletions > 0 && ` −${c.deletions}`}
                  </Mono>
                )}
              </ListRow>
            );
          })}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex gap-2">
          <Button className="py-1.5" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Hide diff" : "View diff"}
          </Button>
          {agent && (
            <Button className="py-1.5" onClick={() => void askToCommit()}>
              Ask {AGENT_LABEL[agent]} to commit
            </Button>
          )}
        </div>
      )}
    </PanelCard>
  );
}

function RecentSessionsCard({ path }: { path: string }) {
  const { navigate, navigateTo } = useHashRoute();
  const sessions = useQuery(queries.sessions);
  const list = (sessions.data ?? [])
    .filter((s) => s.projectPath && isUnder(s.projectPath, path))
    .sort((a, b) => b.endTs - a.endTs)
    .slice(0, RECENT_SESSIONS);

  return (
    <PanelCard
      title="Recent sessions"
      aside={list.length > 0 && <LinkButton onClick={() => navigate("sessions")}>See all</LinkButton>}
    >
      {sessions.isLoading ? (
        <Bone className="h-20" />
      ) : list.length === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No Claude Code sessions in this repo yet.
        </p>
      ) : (
        <div className="flex flex-col">
          {list.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => navigateTo("session-replay", { id: s.id })}
              className={cn(
                "-mx-1.5 flex items-center gap-2.5 px-1.5 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                i === 0 ? "rounded-lg" : "border-t border-black/[0.05] dark:border-white/[0.06]",
              )}
            >
              <ProviderIcon provider="claude" size={13} className="text-amber-600 dark:text-amber-400" />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">
                  {s.firstPrompt?.trim() || "Untitled session"}
                </span>
                <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                  {dayLabel(s.startTs)} · {sessionLength(s.endTs - s.startTs)}
                </span>
              </span>
              <span className="text-[12.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {s.costUsd >= 0.005 ? formatUsd(s.costUsd) : "—"}
              </span>
            </button>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

function sessionLength(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function UsageCard({ repoKey }: { repoKey: string }) {
  const { navigateTo } = useHashRoute();
  const detail = useQuery({ ...queries.repoCostDetail(repoKey), enabled: repoKey.length > 0 });
  const totals = detail.data?.totals;

  return (
    <PanelCard
      title="Last 30 days"
      aside={
        totals && totals.sessions > 0 && (
          <LinkButton onClick={() => navigateTo("cost-detail", { repo: repoKey })}>Cost details</LinkButton>
        )
      }
    >
      {detail.isLoading ? (
        <Bone className="h-[92px]" />
      ) : detail.isError || !totals ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">Couldn’t read usage for this repo.</p>
      ) : totals.sessions === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No agent activity in this repo in the last 30 days.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Figure value={totals.sessions.toLocaleString()} label="sessions" />
          <Figure value={formatUsd(totals.costUsd)} label="spent" />
          <Figure value={totals.messages.toLocaleString()} label="messages" />
          <Figure value={formatCount(totals.tokens)} label="tokens" />
        </div>
      )}
    </PanelCard>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-px">
      <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  );
}

/** Setup flags another scanner may add (AGENTS.md, Cursor rules, MCP) — rendered when present. */
type SetupFlags = RepoSetup & Partial<{ hasAgentsMd: boolean; hasCursorRules: boolean; hasMcp: boolean }>;

function InstructionsCard({ detail }: { detail: RepoDetail }) {
  const qc = useQueryClient();
  const { entry, claudeMd, skills } = detail;
  const openInEditor = useOpenInEditor();
  const setup = useQuery(queries.setup);
  const flags = setup.data?.find((r) => r.repoPath === entry.path) as SetupFlags | undefined;
  const [creating, setCreating] = useState(false);

  const createClaudeMd = async () => {
    setCreating(true);
    try {
      await api.createClaudeMd(entry.path);
      toast.success("Created CLAUDE.md", "Fill it in so agents know how this project works.");
      void qc.invalidateQueries({ queryKey: queries.repoDetail(entry.path).queryKey });
      void qc.invalidateQueries({ queryKey: queries.reposOverview.queryKey });
      void qc.invalidateQueries({ queryKey: queries.setup.queryKey });
    } catch (e) {
      toast.error("Couldn’t create CLAUDE.md", errorText(e));
    } finally {
      setCreating(false);
    }
  };

  const sep = entry.path.includes("\\") ? "\\" : "/";
  const rows: { label: string; on: boolean; detail: ReactNode }[] = [
    {
      label: "CLAUDE.md",
      on: entry.hasClaudeMd,
      detail: entry.hasClaudeMd ? (
        <LinkButton onClick={() => openInEditor(`${entry.path}${sep}CLAUDE.md`)}>
          {claudeMd ? plural(claudeMd.split("\n").length, "line") : "Open"}
        </LinkButton>
      ) : (
        <Button onClick={() => void createClaudeMd()} disabled={creating}>
          {creating ? "Adding…" : "Add CLAUDE.md"}
        </Button>
      ),
    },
  ];
  if (flags?.hasAgentsMd !== undefined) {
    rows.push({ label: "AGENTS.md", on: flags.hasAgentsMd, detail: flags.hasAgentsMd ? "Present" : "None" });
  }
  if (flags?.hasCursorRules !== undefined) {
    rows.push({ label: "Cursor rules", on: flags.hasCursorRules, detail: flags.hasCursorRules ? "Present" : "None" });
  }
  if (flags?.hasMcp !== undefined) {
    rows.push({ label: "MCP servers", on: flags.hasMcp, detail: flags.hasMcp ? "Project config" : "None" });
  }
  rows.push({
    label: "Skills",
    on: skills.length > 0,
    detail:
      skills.length === 0
        ? "None"
        : skills.length <= 2
          ? skills.map((s) => s.name).join(", ")
          : `${skills.slice(0, 2).map((s) => s.name).join(", ")} + ${skills.length - 2} more`,
  });
  if (flags) {
    rows.push({ label: "Subagents", on: flags.hasAgents, detail: flags.hasAgents ? "Present" : "None" });
    rows.push({ label: "Hooks", on: flags.hasHooks, detail: flags.hasHooks ? "Present" : "None" });
  }

  return (
    <PanelCard title="Agent instructions">
      <div className="flex flex-col">
        {rows.map((r, i) => (
          <ListRow key={r.label} first={i === 0}>
            {r.on ? (
              <Check size={14} strokeWidth={2.5} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Circle size={14} strokeWidth={2} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
            )}
            <span className="flex-1 text-[13px] text-zinc-900 dark:text-zinc-100">{r.label}</span>
            <span className="min-w-0 truncate text-xs text-zinc-500 dark:text-zinc-400">{r.detail}</span>
          </ListRow>
        ))}
      </div>
    </PanelCard>
  );
}

function branchNote(b: BranchInfo, defaultName: string): string {
  if (b.isDefault) return b.isCurrent ? "current · default" : "default";
  if (b.merged) return "merged · can be deleted";
  const parts = [b.isCurrent ? "current" : null, aheadBehind(b, defaultName)];
  if (!b.isCurrent && b.lastCommitTs) parts.push(shortAgo(b.lastCommitTs).toLowerCase());
  return parts.filter(Boolean).join(" · ");
}

function BranchesCard({ path }: { path: string }) {
  const qc = useQueryClient();
  const branches = useQuery(queries.repoBranches(path));
  const list = branches.data ?? [];
  const defaultName = list.find((b) => b.isDefault)?.name ?? "main";
  const merged = list.filter((b) => b.merged && !b.isCurrent);

  const deleteMerged = async () => {
    const n = merged.length;
    const ok = await confirm({
      title: `Delete ${plural(n, "merged branch", "merged branches")}?`,
      body: `Everything on ${n === 1 ? "this branch is" : "these branches is"} already in ${defaultName}, so no work is lost. Only the local ${n === 1 ? "branch is" : "branches are"} deleted, not any on GitHub.`,
      items: merged.map((b) => b.name),
      confirmLabel: `Delete ${plural(n, "branch", "branches")}`,
      destructive: true,
    });
    if (!ok) return;
    const failed: string[] = [];
    for (const b of merged) {
      try {
        await api.gitDeleteBranch(path, b.name);
      } catch {
        failed.push(b.name);
      }
    }
    void qc.invalidateQueries({ queryKey: queries.repoBranches(path).queryKey });
    if (failed.length === 0) toast.success(`Deleted ${plural(n, "branch", "branches")}`);
    else toast.error(`Couldn’t delete ${plural(failed.length, "branch", "branches")}`, failed.join(", "));
  };

  return (
    <PanelCard
      title="Branches"
      aside={
        merged.length > 0 && (
          <Button onClick={() => void deleteMerged()}>Delete {merged.length} merged</Button>
        )
      }
    >
      {branches.isLoading ? (
        <Bone className="h-16" />
      ) : branches.isError ? (
        <p className="m-0 text-[12.5px] text-rose-700 dark:text-rose-400">Couldn’t list branches.</p>
      ) : list.length === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">No local branches yet.</p>
      ) : (
        <div className="flex flex-col">
          {list.map((b, i) => (
            <ListRow key={b.name} first={i === 0}>
              <Mono className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">
                {b.name}
              </Mono>
              <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                {branchNote(b, defaultName)}
              </span>
            </ListRow>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

function DetailSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2">
        <Bone className="h-4 w-16 rounded-md" />
        <Bone className="h-7 w-48 rounded-lg" />
        <Bone className="h-4 w-[420px] rounded-md" />
      </div>
      <PageLoading caption="Reading this repo's branches and changes…">
        <div className="flex gap-2">
          <Bone className="h-8 w-36 rounded-lg" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Bone key={i} className="h-8 w-24 rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3">
          <div className="flex flex-col gap-3">
            <Bone className="h-48" />
            <Bone className="h-56" />
          </div>
          <div className="flex flex-col gap-3">
            <Bone className="h-32" />
            <Bone className="h-44" />
            <Bone className="h-32" />
          </div>
        </div>
      </PageLoading>
    </Page>
  );
}
