import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { queries } from "@/lib/queries";
import { formatBytes, formatCount, formatLongRelativeTime, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { Markdown } from "@/components/ui/Markdown";
import { ClaudeOnlyEmpty } from "@/views/_shared/ClaudeOnlyEmpty";
import { SearchField } from "@/views/_shared/SearchField";
import { stripFrontmatter } from "@/views/_shared/ArtifactInventoryView";
import type { ClaudeMdEntry } from "@/types/api";

interface Group {
  key: string;
  label: string;
  entries: ClaudeMdEntry[];
}

const KIND_ORDER: Record<ClaudeMdEntry["kind"], number> = { "claude-md": 0, "agents-md": 1, memory: 2 };

export function MemoryView() {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const memory = useQuery(queries.claudeMd);
  const installed = useInstalledAgents();
  const { navigateTo } = useHashRoute();
  const showSkeleton = useDelayedLoading(memory.isLoading);

  const list = useMemo(() => memory.data ?? [], [memory.data]);
  const filtered = useMemo(() => filterEntries(list, filter), [list, filter]);
  const groups = useMemo(() => groupEntries(filtered), [filtered]);

  if (memory.isLoading) return showSkeleton ? <MemorySkeleton /> : null;

  if (memory.isError) {
    return (
      <Page>
        <PageHeader title="Memory" />
        <ErrorState
          title="Couldn't read your memory files"
          body="LunoPeak couldn't scan ~/.claude and your repos for CLAUDE.md and AGENTS.md files."
          onRetry={() => void memory.refetch()}
          error={memory.error}
        />
      </Page>
    );
  }

  if (list.length === 0) {
    return (
      <Page>
        <PageHeader title="Memory" />
        {installed && !installed.claudeCode && !installed.codex ? (
          <ClaudeOnlyEmpty
            feature="memory"
            description="LunoPeak reads CLAUDE.md and AGENTS.md instruction files. Cursor doesn't have an equivalent today."
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="No memory files yet"
            body="Create a CLAUDE.md to tell agents how your project works: commands, code style, what to avoid."
            primary={{ label: "Create CLAUDE.md", onClick: () => navigateTo("setup") }}
          />
        )}
      </Page>
    );
  }

  const flat = groups.flatMap((g) => g.entries);
  const current = flat.find((e) => e.path === selected) ?? flat[0] ?? null;
  const tokens = list.reduce((sum, e) => sum + e.estimatedTokens, 0);

  return (
    <Page>
      <PageHeader
        title="Memory"
        lead={
          <>
            The instructions and notes your agents read before they start.{" "}
            <b>{plural(list.length, "file")}</b>, about <b>{formatCount(tokens)} tokens</b> in all.
          </>
        }
      />

      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2.5">
          <SearchField value={filter} onChange={setFilter} placeholder="Search all memory files" />
          <Card className="flex flex-col p-1.5">
            {groups.length === 0 ? (
              <p className="m-0 px-2.5 py-3 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                No memory files match.
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.key} className="flex flex-col">
                  <span className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-semibold text-zinc-500 dark:text-zinc-400">
                    {g.label}
                  </span>
                  {g.entries.map((e) => {
                    const active = current?.path === e.path;
                    return (
                      <button
                        key={e.path}
                        type="button"
                        onClick={() => setSelected(e.path)}
                        aria-current={active || undefined}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-[9px] px-2.5 py-2 text-left transition-colors",
                          active
                            ? "bg-black/[0.055] dark:bg-white/[0.07]"
                            : "hover:bg-black/[0.035] dark:hover:bg-white/[0.04]",
                        )}
                      >
                        <Mono
                          className={cn(
                            "truncate text-[12.5px] text-zinc-900 dark:text-zinc-100",
                            active && "font-semibold",
                          )}
                        >
                          {fileLabel(e)}
                        </Mono>
                        <span className="line-clamp-2 text-[12.5px] text-zinc-700 dark:text-zinc-300">
                          {describe(e, list)}
                        </span>
                        <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                          {fileMeta(e)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </Card>
        </div>

        {current && <Preview entry={current} />}
      </div>
    </Page>
  );
}

function Preview({ entry }: { entry: ClaudeMdEntry }) {
  const openInEditor = useOpenInEditor();
  const body = stripFrontmatter(entry.body).trim();
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-black/[0.05] px-4 py-3 dark:border-white/[0.06]">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <Mono className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100" title={entry.path}>
            {fileLabel(entry)}
          </Mono>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{readBy(entry)}</span>
        </div>
        <Button onClick={() => openInEditor(entry.path)}>Open in editor</Button>
      </div>
      <div className="px-[22px] py-[18px]">
        {body ? (
          <Markdown>{body}</Markdown>
        ) : (
          <p className="m-0 text-[13px] text-zinc-500 dark:text-zinc-400">This file is empty.</p>
        )}
      </div>
    </Card>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function fileLabel(e: ClaudeMdEntry): string {
  if (e.kind === "memory") return `memory/${basename(e.path)}`;
  if (e.scope === "global") return e.kind === "agents-md" ? "~/.codex/AGENTS.md" : "~/.claude/CLAUDE.md";
  return basename(e.path);
}

/** One plain line about what the file is for, derived from its content. */
function describe(e: ClaudeMdEntry, all: ClaudeMdEntry[]): string {
  if (e.kind === "memory") {
    if (e.description) return e.description;
    return basename(e.path) === "MEMORY.md" ? "Index of the notes Claude saved" : "A note Claude saved";
  }
  if (e.scope === "global") {
    return e.kind === "agents-md" ? "Your personal rules for Codex" : "Your personal rules for every project";
  }
  if (e.kind === "agents-md") {
    const twin = all.find((o) => o.kind === "claude-md" && o.repoPath === e.repoPath);
    if (twin && twin.body.trim() === e.body.trim()) return "Same rules as CLAUDE.md, for Codex";
  }
  if (e.topics.length > 0) return e.topics.slice(0, 4).join(", ");
  return e.kind === "agents-md" ? "Project instructions for Codex" : "Project instructions for Claude";
}

function readBy(e: ClaudeMdEntry): string {
  const where = e.scope === "global" ? "every project" : (e.repoName ?? "this project");
  if (e.kind === "memory") return `Notes Claude saved while working in ${where}`;
  if (e.kind === "agents-md") return `Read by Codex and Cursor in ${where}`;
  return `Read by Claude in ${where}`;
}

function fileMeta(e: ClaudeMdEntry): string {
  const size = formatBytes(e.bytes);
  if (e.modifiedMs == null) return size;
  return `${size} · ${e.kind === "memory" ? "saved" : "edited"} ${formatLongRelativeTime(e.modifiedMs)}`;
}

function filterEntries(list: ClaudeMdEntry[], filter: string): ClaudeMdEntry[] {
  const q = filter.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (e) =>
      fileLabel(e).toLowerCase().includes(q) ||
      e.repoName?.toLowerCase().includes(q) ||
      e.description?.toLowerCase().includes(q) ||
      e.topics.some((t) => t.toLowerCase().includes(q)) ||
      e.body.toLowerCase().includes(q),
  );
}

/** "Everywhere" first, then one group per repo, alphabetical. */
function groupEntries(list: ClaudeMdEntry[]): Group[] {
  const global: ClaudeMdEntry[] = [];
  const byRepo = new Map<string, Group>();
  for (const e of list) {
    if (e.scope === "global") {
      global.push(e);
      continue;
    }
    const key = e.repoPath ?? e.repoName ?? "(unknown)";
    let g = byRepo.get(key);
    if (!g) {
      g = { key, label: e.repoName ?? "(unknown)", entries: [] };
      byRepo.set(key, g);
    }
    g.entries.push(e);
  }
  const order = (a: ClaudeMdEntry, b: ClaudeMdEntry) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    Number(basename(b.path) === "MEMORY.md") - Number(basename(a.path) === "MEMORY.md") ||
    a.path.localeCompare(b.path);
  const groups = [...byRepo.values()].sort((a, b) => a.label.localeCompare(b.label));
  for (const g of groups) g.entries.sort(order);
  global.sort(order);
  return global.length > 0 ? [{ key: "__global__", label: "Everywhere", entries: global }, ...groups] : groups;
}

function MemorySkeleton() {
  return (
    <Page>
      <PageLoading caption="Finding your memory files…">
        <Bone className="h-7 w-28 rounded-md" />
        <Bone className="h-4 w-96 rounded-md" />
        <div className="mt-2 grid grid-cols-[340px_minmax(0,1fr)] gap-3">
          <div className="flex flex-col gap-2.5">
            <Bone className="h-8 rounded-lg" />
            <Bone className="h-96" />
          </div>
          <Bone className="h-[440px]" />
        </div>
      </PageLoading>
    </Page>
  );
}
