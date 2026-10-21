import { useMemo, useState, type ReactNode } from "react";
import {
  useQuery,
  type UseQueryOptions,
  type QueryKey,
} from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Segmented } from "@/components/ui/Segmented";
import { Markdown } from "@/components/ui/Markdown";
import { ClaudeOnlyEmpty } from "@/views/_shared/ClaudeOnlyEmpty";
import { SearchField } from "@/views/_shared/SearchField";
import { cn } from "@/lib/utils";
import type { ConfigArtifact } from "@/types/api";

type SourceFilter = "all" | "global" | "repo" | "plugin";

const SOURCE_OPTIONS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "global", label: "Yours" },
  { value: "repo", label: "Project" },
  { value: "plugin", label: "Plugin" },
];

interface ArtifactInventoryProps {
  title: string;
  /** Lead sentence, computed from the full (unfiltered) list. */
  lead: (items: ConfigArtifact[]) => ReactNode;
  /** Placeholder for the search input: "Find a skill". */
  searchPlaceholder: string;
  /** Plural noun for "No skills match" copy. */
  plural: string;
  empty: { icon: LucideIcon; title: string; body: string };
  /** Why the page is empty when Claude Code isn't installed. */
  claudeOnlyDescription: string;
  /** Bottom line of each card (usage, model + permissions). */
  meta?: (item: ConfigArtifact) => ReactNode;
  /** Query for the list of artifacts. */
  listQuery: UseQueryOptions<ConfigArtifact[], Error, ConfigArtifact[], QueryKey>;
  /** Factory returning a query for one artifact body, by path. */
  bodyQuery: (path: string) => UseQueryOptions<string, Error, string, QueryKey>;
}

/** Skills and Subagents: search + source filter over a three-column card grid. */
export function ArtifactInventoryView({
  title,
  lead,
  searchPlaceholder,
  plural,
  empty,
  claudeOnlyDescription,
  meta,
  listQuery,
  bodyQuery,
}: ArtifactInventoryProps) {
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const installed = useInstalledAgents();

  const result = useQuery(listQuery);
  const showSkeleton = useDelayedLoading(result.isLoading);

  const items = useMemo(() => result.data ?? [], [result.data]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return items.filter(
      (i) =>
        (source === "all" || i.scope === source) &&
        (!q ||
          i.name.toLowerCase().includes(q) ||
          i.description?.toLowerCase().includes(q) ||
          i.repoName?.toLowerCase().includes(q)),
    );
  }, [items, filter, source]);

  if (result.isLoading) return showSkeleton ? <ArtifactSkeleton plural={plural} /> : null;

  if (result.isError) {
    return (
      <Page>
        <PageHeader title={title} />
        <ErrorState
          title={`Couldn't read your ${plural}`}
          body="LunoPeak couldn't scan ~/.claude or your repos' .claude folders."
          onRetry={() => void result.refetch()}
          error={result.error}
        />
      </Page>
    );
  }

  if (items.length === 0) {
    return (
      <Page>
        <PageHeader title={title} />
        {installed && !installed.claudeCode ? (
          <ClaudeOnlyEmpty feature={plural} description={claudeOnlyDescription} />
        ) : (
          <EmptyState icon={empty.icon} title={empty.title} body={empty.body} />
        )}
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title={title} lead={lead(items)} />

      <div className="flex items-center gap-2.5">
        <SearchField value={filter} onChange={setFilter} placeholder={searchPlaceholder} />
        <Segmented
          value={source}
          options={SOURCE_OPTIONS}
          onChange={setSource}
          ariaLabel="Where it comes from"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="m-0 py-6 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
          No {plural} match.
        </p>
      ) : (
        <div className="grid grid-flow-row-dense grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((item) => (
            <ArtifactCard
              key={item.path}
              item={item}
              meta={meta?.(item)}
              isOpen={open === item.path}
              onToggle={() => setOpen(open === item.path ? null : item.path)}
              bodyQuery={bodyQuery}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function SourcePill({ item }: { item: ConfigArtifact }) {
  if (item.scope === "plugin") {
    return (
      <Pill tone="violet" title={item.repoName ? `From the ${item.repoName} plugin` : undefined}>
        Plugin
      </Pill>
    );
  }
  if (item.scope === "repo") {
    return (
      <Pill tone="blue" className="max-w-[45%] truncate" title={item.repoPath ?? undefined}>
        {item.repoName ?? "Project"}
      </Pill>
    );
  }
  return <Pill>Yours</Pill>;
}

function ArtifactCard({
  item,
  meta,
  isOpen,
  onToggle,
  bodyQuery,
}: {
  item: ConfigArtifact;
  meta: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  bodyQuery: (path: string) => UseQueryOptions<string, Error, string, QueryKey>;
}) {
  return (
    <Card
      className={cn(
        "flex flex-col transition-colors",
        isOpen ? "col-span-full" : "hover:border-black/[0.16] dark:hover:border-white/[0.18]",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex flex-1 flex-col gap-2 px-4 py-3.5 text-left"
      >
        <div className="flex w-full items-center gap-2">
          <Mono className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            {item.name}
          </Mono>
          <SourcePill item={item} />
        </div>
        <span
          className={cn(
            "flex-1 text-[13px] leading-[1.45] text-zinc-700 text-pretty dark:text-zinc-300",
            !isOpen && "line-clamp-2",
          )}
        >
          {item.description ?? "No description."}
        </span>
        {meta && <span className="text-xs text-zinc-500 dark:text-zinc-400">{meta}</span>}
      </button>
      {isOpen && <ArtifactBody path={item.path} bodyQuery={bodyQuery} />}
    </Card>
  );
}

function ArtifactBody({
  path,
  bodyQuery,
}: {
  path: string;
  bodyQuery: (path: string) => UseQueryOptions<string, Error, string, QueryKey>;
}) {
  const body = useQuery(bodyQuery(path));
  const openInEditor = useOpenInEditor();
  return (
    <div className="flex flex-col gap-3 border-t border-black/[0.05] px-4 py-3.5 dark:border-white/[0.06]">
      <div className="flex items-center gap-3">
        <Mono className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-500 dark:text-zinc-400" title={path}>
          {path}
        </Mono>
        <Button onClick={() => openInEditor(path)}>Open in editor</Button>
      </div>
      {body.isLoading ? (
        <div className="flex flex-col gap-2 animate-lp-pulse">
          <Bone className="h-3 w-2/3 rounded" />
          <Bone className="h-3 w-3/4 rounded" />
          <Bone className="h-3 w-1/2 rounded" />
        </div>
      ) : body.isError || body.data == null ? (
        <p className="m-0 text-[12.5px] text-rose-700 dark:text-rose-400">
          Couldn't read this file.{" "}
          <button type="button" className="underline" onClick={() => void body.refetch()}>
            Try again
          </button>
        </p>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <Markdown>{stripFrontmatter(body.data)}</Markdown>
        </div>
      )}
    </div>
  );
}

/** Drops a leading `---` YAML block — its fields are already on the card. */
export function stripFrontmatter(raw: string): string {
  const m = /^\s*---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/.exec(raw);
  return m ? raw.slice(m[0].length) : raw;
}

function ArtifactSkeleton({ plural }: { plural: string }) {
  return (
    <Page>
      <PageLoading caption={`Finding your ${plural}…`}>
        <Bone className="h-7 w-28 rounded-md" />
        <Bone className="h-4 w-96 rounded-md" />
        <div className="mt-2 flex gap-2.5">
          <Bone className="h-8 flex-1 rounded-lg" />
          <Bone className="h-8 w-64 rounded-lg" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bone key={i} className="h-28" />
          ))}
        </div>
      </PageLoading>
    </Page>
  );
}
