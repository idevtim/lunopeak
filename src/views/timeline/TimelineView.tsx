import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, GitCommitHorizontal } from "lucide-react";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { Segmented } from "@/components/ui/Segmented";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TimelineEvent } from "@/types/api";
import { dayLabel } from "@/views/repos/repoUtils";

type Filter = "all" | "commits" | "sessions";

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function TimelineView() {
  const events = useQuery(queries.timeline);
  const showSkeleton = useDelayedLoading(events.isLoading);
  const [filter, setFilter] = useState<Filter>("all");

  const header = (lead?: React.ReactNode) => (
    <PageHeader
      title="Timeline"
      lead={lead}
      actions={
        <Segmented
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Everything" },
            { value: "commits", label: "Commits" },
            { value: "sessions", label: "Sessions" },
          ]}
        />
      }
    />
  );

  if (events.isError) {
    return (
      <Page>
        <PageHeader title="Timeline" />
        <ErrorState
          title="Couldn’t build the timeline"
          body="LunoPeak couldn’t read your git history or session logs. Try again in a moment."
          onRetry={() => void events.refetch()}
          error={events.error}
        />
      </Page>
    );
  }
  if (!events.data) return showSkeleton ? <TimelineSkeleton /> : null;

  const all = events.data;
  if (all.length === 0) {
    return (
      <Page>
        <PageHeader title="Timeline" />
        <EmptyState
          icon={Clock}
          title="Nothing on the timeline yet"
          body="Commits and agent sessions will appear here in the order they happen."
        />
      </Page>
    );
  }

  const commits = all.filter((e) => e.kind === "commit").length;
  const sessions = all.length - commits;
  const visible = all.filter(
    (e) =>
      filter === "all" ||
      (filter === "commits" ? e.kind === "commit" : e.kind === "session"),
  );

  // Events arrive newest first, so insertion order is Today → older.
  const groups = new Map<string, TimelineEvent[]>();
  for (const e of visible) {
    const key = dayLabel(e.ts);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  return (
    <Page>
      {header(
        <>
          <b>{plural(commits, "commit")}</b> and <b>{plural(sessions, "agent session")}</b>, in the
          order they happened.
        </>,
      )}
      {visible.length === 0 ? (
        <Card className="px-[18px] py-6 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
          {filter === "commits" ? "No commits in this window." : "No agent sessions in this window."}
        </Card>
      ) : (
        <div className="flex flex-col gap-[18px]">
          {[...groups].map(([day, list]) => (
            <section key={day} className="flex flex-col gap-2">
              <h2 className="m-0 text-[13px] font-semibold text-zinc-600 dark:text-zinc-400">{day}</h2>
              <Card className="px-[18px] py-1.5">
                {list.map((e, i) => (
                  <TimelineRow key={e.kind === "commit" ? `${e.repo}:${e.sha}` : e.id} event={e} first={i === 0} />
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}

function TimelineRow({ event, first }: { event: TimelineEvent; first: boolean }) {
  const { navigateTo } = useHashRoute();
  const isCommit = event.kind === "commit";
  return (
    <div
      className={cn(
        "grid grid-cols-[64px_26px_minmax(0,1fr)_auto] items-center gap-3 py-[9px]",
        !first && "border-t border-black/[0.04] dark:border-white/[0.05]",
      )}
    >
      <span className="text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        {TIME_FMT.format(event.ts)}
      </span>
      {isCommit ? (
        <span className="flex size-[26px] items-center justify-center rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <GitCommitHorizontal size={13} strokeWidth={2} />
        </span>
      ) : (
        <span className="flex size-[26px] items-center justify-center rounded-full bg-amber-600/[0.12] text-amber-600 dark:text-amber-400">
          <ProviderIcon provider="claude" size={12} />
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13.5px] text-zinc-900 dark:text-zinc-100">
          {isCommit
            ? event.subject
            : event.title
              ? `Claude started “${event.title}”`
              : "Claude started a session"}
        </span>
        <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
          {isCommit ? event.repo : (event.project ?? "Unknown folder")}
        </span>
      </div>
      {isCommit ? (
        <Mono className="text-zinc-500 dark:text-zinc-400" title={event.author}>
          {event.sha.slice(0, 7)}
        </Mono>
      ) : (
        <button
          type="button"
          onClick={() => navigateTo("session-replay", { id: event.id })}
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          Replay
        </button>
      )}
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <Page>
      <div className="flex items-end gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Bone className="h-7 w-32 rounded-lg" />
          <Bone className="h-4 w-80 rounded-md" />
        </div>
        <Bone className="h-8 w-56 rounded-[9px]" />
      </div>
      <PageLoading caption="Lining up commits and sessions…">
        {[5, 4].map((rows, s) => (
          <div key={s} className="flex flex-col gap-2">
            <Bone className="h-4 w-20 rounded-md" />
            <Bone className={rows === 5 ? "h-[230px]" : "h-[184px]"} />
          </div>
        ))}
      </PageLoading>
    </Page>
  );
}
