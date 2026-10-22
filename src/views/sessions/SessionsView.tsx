import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, History, Search } from "lucide-react";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Card, CardHeader, Page, PageHeader } from "@/components/ui/Page";
import { EmptyState, ErrorState } from "@/components/ui/PageStates";
import { Pill } from "@/components/ui/Pill";
import { Segmented } from "@/components/ui/Segmented";
import { Button } from "@/components/ui/Button";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { formatUsd, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Session } from "@/types/api";
import { SessionsSkeleton } from "./SessionsSkeleton";
import { dayLabel, friendlyModel, sessionMeta, sessionTitle, shortDuration } from "./sessionFormat";

type Range = "7" | "30" | "all";

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "all", label: "All time" },
];

const DAY_MS = 86_400_000;
const PAGE_SIZE = 60;

export function SessionsView() {
  const sessionsQ = useQuery(queries.sessions);
  const live = useQuery({ ...queries.liveContexts, refetchInterval: 10_000 });
  const { navigateTo } = useHashRoute();
  const [range, setRange] = useState<Range>("30");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const showSkeleton = useDelayedLoading(sessionsQ.isLoading);

  const all = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const inRange = useMemo(() => {
    if (range === "all") return all;
    const cutoff = Date.now() - Number(range) * DAY_MS;
    return all.filter((s) => s.endTs >= cutoff);
  }, [all, range]);

  const listed = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inRange;
    return inRange.filter(
      (s) =>
        s.firstPrompt?.toLowerCase().includes(q) ||
        s.projectName?.toLowerCase().includes(q) ||
        s.branch?.toLowerCase().includes(q),
    );
  }, [inRange, search]);

  const running = useMemo(
    () =>
      new Set(
        (live.data ?? []).filter((c) => c.agent === "claude").map((c) => c.sessionId),
      ),
    [live.data],
  );

  const groups = useMemo(() => groupByDay(listed.slice(0, limit)), [listed, limit]);

  if (sessionsQ.isLoading) return showSkeleton ? <SessionsSkeleton /> : null;

  if (sessionsQ.isError) {
    return (
      <Page>
        <PageHeader title="Sessions" />
        <ErrorState
          title="Couldn't read your session logs"
          body="LunoPeak couldn't open ~/.claude/projects. It may have moved, or LunoPeak needs Full Disk Access."
          error={sessionsQ.error}
          onRetry={() => void sessionsQ.refetch()}
        />
      </Page>
    );
  }

  if (all.length === 0) {
    return (
      <Page>
        <PageHeader title="Sessions" />
        <EmptyState
          icon={History}
          title="No sessions yet"
          body="Every agent session you run shows up here, with what it did and what it cost."
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Sessions"
        lead={<Lead sessions={inRange} all={all} range={range} />}
        actions={
          <Segmented
            ariaLabel="Time range"
            value={range}
            options={RANGE_OPTIONS}
            onChange={(r) => {
              setRange(r);
              setLimit(PAGE_SIZE);
            }}
          />
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4">
        <Card className="overflow-hidden">
          <div className="px-[18px] pb-1.5 pt-3">
            <label className="flex items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 focus-within:border-blue-500/50 dark:border-white/10 dark:bg-white/[0.04]">
              <Search size={13} strokeWidth={2} className="shrink-0 text-zinc-400" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLimit(PAGE_SIZE);
                }}
                placeholder="Find a session by task, repo or branch"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
              />
            </label>
          </div>

          {listed.length === 0 ? (
            <p className="px-[18px] pb-6 pt-4 text-[13px] text-zinc-500 dark:text-zinc-400">
              {search.trim()
                ? `No sessions match “${search.trim()}”.`
                : "No sessions in this range. Try a longer one."}
            </p>
          ) : (
            <div className="flex flex-col pb-1">
              {groups.map((g) => (
                <div key={g.label} className="flex flex-col">
                  <span className="px-[18px] pb-1.5 pt-3.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                    {g.label}
                  </span>
                  {g.sessions.map((s) => (
                    <SessionRow
                      key={s.id}
                      session={s}
                      running={running.has(s.id)}
                      onOpen={() => navigateTo("session-replay", { id: s.id })}
                    />
                  ))}
                </div>
              ))}
              {listed.length > limit && (
                <div className="flex justify-center border-t border-black/[0.04] py-2.5 dark:border-white/[0.05]">
                  <Button variant="ghost" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                    Show {Math.min(PAGE_SIZE, listed.length - limit)} more
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-3">
          <SummaryCard sessions={inRange} range={range} />
          <WhenYouWork sessions={inRange} />
          <BusiestProjects sessions={inRange} />
          <ModelsShare sessions={inRange} />
        </div>
      </div>
    </Page>
  );
}

function Lead({ sessions, all, range }: { sessions: Session[]; all: Session[]; range: Range }) {
  const n = sessions.length;
  if (range === "all") {
    const first = Math.min(...all.map((s) => s.startTs));
    const since = new Date(first).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return (
      <>
        <b>{plural(n, "session")}</b> since {since}. Click one to replay it.
      </>
    );
  }
  const perDay = n / Number(range);
  const rate =
    n === 0
      ? ""
      : perDay >= 1
        ? `, about ${Math.round(perDay)} a day`
        : `, about ${Math.max(1, Math.round(perDay * 7))} a week`;
  return (
    <>
      <b>{plural(n, "session")}</b> in the last {range} days{rate}. Click one to replay it.
    </>
  );
}

function SessionRow({
  session: s,
  running,
  onOpen,
}: {
  session: Session;
  running: boolean;
  onOpen: () => void;
}) {
  const meta = sessionMeta(s);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid grid-cols-[22px_minmax(0,1fr)_70px_64px_60px_14px] items-center gap-3 border-t border-black/[0.04] px-[18px] py-[9px] text-left transition-colors hover:bg-black/[0.025] dark:border-white/[0.05] dark:hover:bg-white/[0.03]"
    >
      <ProviderIcon provider="claude" size={14} className="text-amber-600 dark:text-amber-400" />
      <span className="flex min-w-0 flex-col gap-px">
        <span className="flex min-w-0 items-center gap-[7px] text-[13.5px] text-zinc-900 dark:text-zinc-100">
          <span className="truncate">{sessionTitle(s)}</span>
          {running && (
            <Pill tone="green" className="shrink-0">
              Running
            </Pill>
          )}
        </span>
        <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
          {[
            meta.repo,
            meta.branch && (
              <span key="b" className="font-mono text-[11.5px]">
                {meta.branch}
              </span>
            ),
            meta.model,
          ]
            .filter(Boolean)
            .map((part, i) => (
              <span key={i}>
                {i > 0 && " · "}
                {part}
              </span>
            ))}
        </span>
      </span>
      <span className="text-right text-[12.5px] tabular-nums text-zinc-700 dark:text-zinc-300">
        {shortDuration(s.endTs - s.startTs)}
      </span>
      <span className="text-right text-[12.5px] tabular-nums text-zinc-500 dark:text-zinc-400">
        {s.messageCount} msgs
      </span>
      <span
        className="text-right text-[12.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
        title={s.subagentCostUsd > 0 ? `Includes ${formatUsd(s.subagentCostUsd)} by ${plural(s.subagentCount, "subagent")}` : undefined}
      >
        {s.costUsd > 0 ? formatUsd(s.costUsd) : "—"}
      </span>
      <ChevronRight size={12} strokeWidth={2.25} className="text-zinc-400" />
    </button>
  );
}

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 pb-4">
      <CardHeader title={title} className="pb-0" />
      <div className="px-[18px]">{children}</div>
    </Card>
  );
}

function SummaryCard({ sessions, range }: { sessions: Session[]; range: Range }) {
  const totalMs = sessions.reduce((n, s) => n + Math.max(0, s.endTs - s.startTs), 0);
  const durations = sessions.map((s) => s.endTs - s.startTs).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const spent = sessions.reduce((n, s) => n + s.costUsd, 0);
  const hours = totalMs / 3_600_000;
  const stats = [
    { value: sessions.length.toLocaleString(), label: "sessions" },
    { value: hours >= 10 ? `${Math.round(hours)} h` : `${hours.toFixed(1)} h`, label: "with agents" },
    { value: shortDuration(median), label: "typical length" },
    { value: formatUsd(spent, spent >= 1000), label: "spent" },
  ];
  return (
    <SideCard title={range === "all" ? "All time" : `Last ${range} days`}>
      <div className="grid grid-cols-2 gap-3">
        {stats.map((st) => (
          <div key={st.label} className="flex flex-col">
            <span className="text-xl font-semibold tracking-[-0.01em] tabular-nums text-zinc-900 dark:text-zinc-50">
              {st.value}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{st.label}</span>
          </div>
        ))}
      </div>
    </SideCard>
  );
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const HEAT_COLS = 14;

/**
 * Weekday × hour heatmap of session starts. Shows the 14-hour window with
 * the most activity so night owls and early birds both get a useful view.
 */
function WhenYouWork({ sessions }: { sessions: Session[] }) {
  const { grid, startHour, max } = useMemo(() => {
    const counts = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const byHour = Array<number>(24).fill(0);
    for (const s of sessions) {
      const d = new Date(s.startTs);
      const dow = (d.getDay() + 6) % 7;
      counts[dow][d.getHours()] += 1;
      byHour[d.getHours()] += 1;
    }
    let best = 8;
    let bestSum = -1;
    for (let h = 0; h <= 24 - HEAT_COLS; h++) {
      const sum = byHour.slice(h, h + HEAT_COLS).reduce((a, b) => a + b, 0);
      if (sum > bestSum) {
        bestSum = sum;
        best = h;
      }
    }
    const grid = counts.map((row) => row.slice(best, best + HEAT_COLS));
    return { grid, startHour: best, max: Math.max(1, ...grid.flat()) };
  }, [sessions]);

  const tone = (v: number) => {
    if (v === 0) return "bg-black/[0.05] dark:bg-white/[0.06]";
    const r = v / max;
    if (r > 0.66) return "bg-blue-500/85";
    if (r > 0.33) return "bg-blue-500/50";
    return "bg-blue-500/25";
  };

  return (
    <SideCard title="When you work">
      <div className="flex flex-col gap-[3px]">
        {grid.map((row, d) => (
          <div key={d} className="grid grid-cols-[12px_repeat(14,minmax(0,1fr))] items-center gap-[3px]">
            <span className="text-[10.5px] text-zinc-400">{WEEKDAYS[d]}</span>
            {row.map((v, h) => (
              <span
                key={h}
                className={cn("aspect-square rounded-[3px]", tone(v))}
                title={`${plural(v, "session")} · ${hourLabel(startHour + h)}`}
              />
            ))}
          </div>
        ))}
        <div className="mt-1 grid grid-cols-[12px_minmax(0,1fr)] gap-[3px] text-[11px] text-zinc-400">
          <span />
          <span className="flex justify-between">
            <span>{hourLabel(startHour)}</span>
            <span>{hourLabel(startHour + HEAT_COLS / 2)}</span>
            <span>{hourLabel(startHour + HEAT_COLS)}</span>
          </span>
        </div>
      </div>
    </SideCard>
  );
}

function hourLabel(h: number): string {
  const hh = h % 24;
  if (hh === 0) return "12a";
  if (hh === 12) return "12p";
  return hh < 12 ? `${hh}a` : `${hh - 12}p`;
}

function BusiestProjects({ sessions }: { sessions: Session[] }) {
  const top = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const name = s.projectName ?? "Unknown folder";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [sessions]);
  const max = Math.max(1, ...top.map(([, n]) => n));
  if (top.length === 0) return null;
  return (
    <SideCard title="Busiest projects">
      <div className="flex flex-col gap-[9px]">
        {top.map(([name, n]) => (
          <div key={name} className="grid grid-cols-[minmax(0,1fr)_60px_32px] items-center gap-2.5">
            <span className="truncate font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200">{name}</span>
            <span className="h-[5px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
              <span className="block h-full rounded-full bg-blue-500" style={{ width: `${(n / max) * 100}%` }} />
            </span>
            <span className="text-right text-[12.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {n}
            </span>
          </div>
        ))}
      </div>
    </SideCard>
  );
}

const MODEL_SWATCHES = ["bg-orange-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500", "bg-violet-500"];

/** Share of sessions per model family, top four plus "Other". */
function ModelsShare({ sessions }: { sessions: Session[] }) {
  const shares = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (!s.model) continue;
      // Collapse versions so the bar stays readable: "Opus 4.7" → "Opus".
      const family = friendlyModel(s.model).split(" ")[0];
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const head = sorted.slice(0, 4);
    const rest = sorted.slice(4).reduce((n, [, v]) => n + v, 0);
    if (rest > 0) head.push(["Other", rest]);
    return head.map(([name, n]) => ({ name, n, pct: total ? Math.round((n / total) * 100) : 0 }));
  }, [sessions]);
  if (shares.length === 0) return null;
  return (
    <SideCard title="Models">
      <div className="flex flex-col gap-3">
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {shares.map((m, i) => (
            <span key={m.name} className={MODEL_SWATCHES[i]} style={{ flex: m.n }} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {shares.map((m, i) => (
            <span key={m.name} className="flex items-center gap-1.5 text-[12.5px] text-zinc-800 dark:text-zinc-200">
              <span className={cn("size-2 rounded-[2px]", MODEL_SWATCHES[i])} />
              <span className="flex-1 truncate">{m.name}</span>
              <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{m.pct}%</span>
            </span>
          ))}
        </div>
      </div>
    </SideCard>
  );
}

function groupByDay(sessions: Session[]): { label: string; sessions: Session[] }[] {
  const now = new Date();
  const out: { label: string; sessions: Session[] }[] = [];
  for (const s of sessions) {
    const label = dayLabel(s.endTs, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.sessions.push(s);
    else out.push({ label, sessions: [s] });
  }
  return out;
}
