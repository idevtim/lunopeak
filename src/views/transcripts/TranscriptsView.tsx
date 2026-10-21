import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ScrollText, Search } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Page, PageHeader } from "@/components/ui/Page";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { formatUsd, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Session, SessionDetail, SessionEvent } from "@/types/api";
import {
  clockTime,
  dayLabel,
  describeTool,
  sessionMeta,
  sessionTitle,
  shortDuration,
} from "@/views/sessions/sessionFormat";

const LIST_LIMIT = 200;

export function TranscriptsView() {
  const { params, navigateTo } = useHashRoute();
  const sessions = useQuery(queries.sessions);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(params.get("id"));

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const searching = debounced.length >= 2;
  const search = useQuery({
    queryKey: ["transcript-search", debounced],
    queryFn: () => api.searchTranscripts(debounced),
    enabled: searching,
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
  });

  // Searching: chats with text hits plus chats whose repo or branch matches
  // the query. Otherwise: every chat, newest first.
  const list = useMemo(() => {
    const all = sessions.data ?? [];
    if (!searching) return all.map((s) => ({ session: s, matches: 0 }));
    const hits = new Map((search.data ?? []).map((m) => [m.sessionId, m.matches]));
    const q = debounced.toLowerCase();
    return all
      .filter(
        (s) =>
          hits.has(s.id) ||
          s.projectName?.toLowerCase().includes(q) ||
          s.branch?.toLowerCase().includes(q),
      )
      .map((s) => ({ session: s, matches: hits.get(s.id) ?? 0 }));
  }, [sessions.data, search.data, searching, debounced]);

  // While searching, stick to the result list; otherwise honor a deep link
  // (?id= from Session replay) even if it's past the list limit.
  const selected =
    list.find((r) => r.session.id === selectedId)?.session ??
    list[0]?.session ??
    null;

  const showSkeleton = useDelayedLoading(sessions.isLoading);
  if (sessions.isLoading) return showSkeleton ? <TranscriptsSkeleton /> : null;

  if (sessions.isError) {
    return (
      <Page>
        <PageHeader title="Transcripts" />
        <ErrorState
          title="Couldn't read your session logs"
          body="LunoPeak couldn't open ~/.claude/projects. It may have moved, or LunoPeak needs Full Disk Access."
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      </Page>
    );
  }

  if ((sessions.data ?? []).length === 0) {
    return (
      <Page>
        <PageHeader title="Transcripts" lead="Search inside every conversation." />
        <EmptyState
          icon={ScrollText}
          title="Nothing to read yet"
          body="Conversations appear here after your first agent session."
        />
      </Page>
    );
  }

  return (
    <Page className="h-full min-h-[560px] pb-6">
      <PageHeader title="Transcripts" lead="Search inside every conversation." />
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-white/[0.035]">
        <aside className="flex w-80 shrink-0 flex-col border-r border-black/[0.06] bg-[#fafafa] pt-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <div className="px-4 pb-3">
            <label className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-[7px] focus-within:border-blue-500/50 focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.12)] dark:border-white/10 dark:bg-white/[0.05]">
              <Search size={13} strokeWidth={2} className="shrink-0 text-zinc-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search conversations"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
              />
              <span className="shrink-0 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                {searching && search.isFetching && !search.data
                  ? "Searching…"
                  : plural(list.length, "chat")}
              </span>
            </label>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3 [scrollbar-width:none]">
            {searching && search.isError ? (
              <p className="px-2.5 py-4 text-[12.5px] text-rose-700 dark:text-rose-300">
                Search failed. {search.error instanceof Error ? search.error.message : ""}
              </p>
            ) : list.length === 0 ? (
              <p className="px-2.5 py-4 text-[12.5px] text-zinc-500 dark:text-zinc-400">
                No conversation mentions “{debounced}”.
              </p>
            ) : (
              list.slice(0, LIST_LIMIT).map(({ session: s, matches }) => (
                <ChatRow
                  key={s.id}
                  session={s}
                  matches={searching ? matches : null}
                  active={selected?.id === s.id}
                  onClick={() => setSelectedId(s.id)}
                />
              ))
            )}
            {list.length > LIST_LIMIT && (
              <p className="px-2.5 py-2 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                Showing the newest {LIST_LIMIT}. Search to narrow it down.
              </p>
            )}
          </div>
        </aside>

        {selected ? (
          <Reader
            key={selected.id}
            session={selected}
            query={searching ? debounced : ""}
            onReplay={() => navigateTo("session-replay", { id: selected.id, from: "transcripts" })}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-zinc-500">
            Pick a conversation to read it.
          </div>
        )}
      </div>
    </Page>
  );
}

function ChatRow({
  session: s,
  matches,
  active,
  onClick,
}: {
  session: Session;
  matches: number | null;
  active: boolean;
  onClick: () => void;
}) {
  const when = dayLabel(s.startTs);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex gap-2.5 rounded-[9px] px-2.5 py-[9px] text-left transition-colors",
        active
          ? "bg-black/[0.06] dark:bg-white/[0.08]"
          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
      )}
    >
      <ProviderIcon provider="claude" size={13} className="mt-0.5 text-amber-600 dark:text-amber-400" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[13px] text-zinc-900 dark:text-zinc-100",
            active && "font-semibold",
          )}
        >
          {sessionTitle(s)}
        </span>
        <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {[s.projectName, when === "Today" ? `Today, ${clockTime(s.startTs)}` : when]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {matches !== null && matches > 0 && (
        <span className="shrink-0 self-center whitespace-nowrap rounded-full bg-yellow-400/25 px-[7px] py-px text-[11px] font-semibold text-yellow-800 dark:text-yellow-300">
          {plural(matches, "match", "matches")}
        </span>
      )}
    </button>
  );
}

// ── Reader ────────────────────────────────────────────────────────────

type Block =
  | { kind: "user"; ts: number; text: string }
  | { kind: "assistant"; ts: number; parts: Part[] };

type Part =
  | { kind: "text"; text: string }
  | { kind: "tools"; steps: { text: string; isError: boolean }[]; startTs: number; endTs: number };

/**
 * Fold the event stream into conversation turns: each user message is its
 * own block; everything the agent does until the next user message is one
 * "Claude" block, with consecutive tool calls folded into a single gray
 * box of plain sentences.
 */
function toBlocks(d: SessionDetail): Block[] {
  const blocks: Block[] = [];
  const pendingTools: { isError: boolean }[] = [];
  const assistantBlock = (ts: number) => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "assistant") return last;
    const b: Block = { kind: "assistant", ts, parts: [] };
    blocks.push(b);
    return b;
  };
  for (const e of d.events) {
    if (e.kind === "user") {
      blocks.push({ kind: "user", ts: e.ts, text: e.text ?? "" });
      continue;
    }
    if (e.kind === "assistant") {
      assistantBlock(e.ts).parts.push({ kind: "text", text: e.text ?? "" });
      continue;
    }
    if (e.kind === "tool_use") {
      const b = assistantBlock(e.ts);
      const last = b.parts[b.parts.length - 1];
      const step = { text: describeTool(e.toolName, e.toolSummary, d.projectPath), isError: false };
      if (last && last.kind === "tools") {
        last.steps.push(step);
        last.endTs = e.ts;
      } else {
        b.parts.push({ kind: "tools", steps: [step], startTs: e.ts, endTs: e.ts });
      }
      pendingTools.push(step);
      continue;
    }
    if (e.kind === "tool_result") markResult(e, pendingTools);
  }
  return blocks;
}

function markResult(e: SessionEvent, pending: { isError: boolean }[]) {
  const owner = pending.shift();
  if (owner && e.isError) owner.isError = true;
}

function Reader({
  session,
  query,
  onReplay,
}: {
  session: Session;
  query: string;
  onReplay: () => void;
}) {
  const detail = useQuery({
    queryKey: ["session-detail", session.id],
    queryFn: () => api.getSessionDetail(session.id),
    staleTime: 5 * 60 * 1000,
  });
  const blocks = useMemo(() => (detail.data ? toBlocks(detail.data) : []), [detail.data]);
  const totalMatches = useMemo(() => {
    if (!query) return 0;
    const q = query.toLowerCase();
    let n = 0;
    for (const b of blocks) {
      const texts = b.kind === "user" ? [b.text] : b.parts.flatMap((p) => (p.kind === "text" ? [p.text] : []));
      for (const t of texts) n += t.toLowerCase().split(q).length - 1;
    }
    return n;
  }, [blocks, query]);

  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => setCurrent(0), [query, session.id]);
  useEffect(() => {
    if (!query) return;
    scrollRef.current
      ?.querySelector(`[data-match="${current}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, query, blocks]);

  const step = (delta: number) =>
    totalMatches > 0 && setCurrent((c) => (c + delta + totalMatches) % totalMatches);

  const meta = sessionMeta(session);
  // Each render numbers the hits in document order so `data-match` lines up
  // with the navigation counter.
  const counter = { n: 0 };
  const hl = (text: string) => highlight(text, query, counter, current);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-black/[0.05] px-6 pb-3 pt-3.5 dark:border-white/[0.06]">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
            {sessionTitle(session)}
          </span>
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {[
              "Claude",
              meta.model,
              meta.repo,
              plural(session.messageCount, "message"),
              session.costUsd > 0 ? formatUsd(session.costUsd) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {query && (
          <>
            <span className="text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
              {totalMatches > 0 ? `Match ${current + 1} of ${totalMatches}` : "No matches here"}
            </span>
            <NavButton label="Previous match" disabled={totalMatches === 0} onClick={() => step(-1)}>
              <ChevronUp size={14} strokeWidth={2.25} />
            </NavButton>
            <NavButton label="Next match" disabled={totalMatches === 0} onClick={() => step(1)}>
              <ChevronDown size={14} strokeWidth={2.25} />
            </NavButton>
          </>
        )}
        <Button onClick={onReplay}>Replay session</Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[720px] flex-col gap-[18px] px-7 py-[22px]">
          {detail.isLoading ? (
            <PageLoading caption="Reading the conversation…">
              <Bone className="h-16" />
              <Bone className="h-28" />
              <Bone className="h-20" />
            </PageLoading>
          ) : detail.isError ? (
            <ErrorState
              title="Couldn't open this conversation"
              body="LunoPeak couldn't read the session's log."
              error={detail.error}
              onRetry={() => void detail.refetch()}
            />
          ) : !detail.data ? (
            <p className="text-[13px] text-zinc-500">
              This conversation's log is gone. It may have been deleted since LunoPeak last looked.
            </p>
          ) : blocks.length === 0 ? (
            <p className="text-[13px] text-zinc-500">This conversation has no messages.</p>
          ) : (
            blocks.map((b, i) =>
              b.kind === "user" ? (
                <div key={i} className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-semibold text-zinc-500 dark:text-zinc-400">
                    You{b.ts > 0 && ` · ${clockTime(b.ts)}`}
                  </span>
                  <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-900 text-pretty dark:text-zinc-100">
                    {hl(b.text)}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-semibold text-amber-700 dark:text-amber-400">
                    Claude{b.ts > 0 && ` · ${clockTime(b.ts)}`}
                  </span>
                  {b.parts.map((p, j) =>
                    p.kind === "text" ? (
                      <div
                        key={j}
                        className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-900 text-pretty dark:text-zinc-100"
                      >
                        {hl(p.text)}
                      </div>
                    ) : (
                      <ToolBox key={j} part={p} />
                    ),
                  )}
                </div>
              ),
            )
          )}
        </div>
      </div>
    </div>
  );
}

function ToolBox({ part }: { part: Extract<Part, { kind: "tools" }> }) {
  const [open, setOpen] = useState(false);
  const shown = open ? part.steps : part.steps.slice(0, 4);
  const elapsed = part.endTs - part.startTs;
  return (
    <div className="flex flex-col gap-0.5 rounded-[10px] bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
      {shown.map((s, i) => (
        <div
          key={i}
          className={cn(
            "truncate py-0.5 text-[12.5px]",
            s.isError ? "text-rose-700 dark:text-rose-300" : "text-zinc-600 dark:text-zinc-400",
          )}
          title={s.text}
        >
          {s.text}
        </div>
      ))}
      <span className="flex items-center gap-2 pt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
        {plural(part.steps.length, "step")}
        {elapsed >= 1000 && ` · ${shortDuration(elapsed)}`}
        {part.steps.length > 4 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {open ? "Show fewer" : `Show all ${part.steps.length}`}
          </button>
        )}
      </span>
    </div>
  );
}

function NavButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-[7px] border border-black/[0.09] bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-zinc-200"
    >
      {children}
    </button>
  );
}

function highlight(
  text: string,
  query: string,
  counter: { n: number },
  current: number,
): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) out.push(text.slice(at, i));
    const idx = counter.n++;
    out.push(
      <mark
        key={i}
        data-match={idx}
        className={cn(
          "rounded-[3px] px-0.5 text-inherit",
          idx === current
            ? "bg-yellow-400/80 ring-2 ring-yellow-500/60"
            : "bg-yellow-300/45 dark:bg-yellow-400/30",
        )}
      >
        {text.slice(i, i + q.length)}
      </mark>,
    );
    at = i + q.length;
  }
  if (out.length === 0) return text;
  if (at < text.length) out.push(text.slice(at));
  return out;
}

function TranscriptsSkeleton() {
  return (
    <Page className="h-full min-h-[560px] pb-6">
      <div className="flex flex-col gap-2">
        <Bone className="h-7 w-36 rounded-lg" />
        <Bone className="h-4 w-64 rounded-md" />
      </div>
      <PageLoading caption="Gathering your conversations…">
        <div className="flex h-[520px] gap-3">
          <Bone className="w-80" />
          <Bone className="flex-1" />
        </div>
      </PageLoading>
    </Page>
  );
}
