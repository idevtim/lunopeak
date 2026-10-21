import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, ChevronRight, Zap } from "lucide-react";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { Page, PageHeader, Card, CardHeader, Mono } from "@/components/ui/Page";
import { Segmented } from "@/components/ui/Segmented";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { cn } from "@/lib/utils";
import { formatCount, plural } from "@/lib/format";
import type { ToolStats } from "@/types/api";

type Range = "7" | "30" | "all";

const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "all", label: "All time" },
];

type Family = "read" | "edit" | "command" | "search" | "web" | "other";

interface FamilyInfo {
  label: string;
  /** Short verb for pattern descriptions ("Look, then change"). */
  verb: string;
  swatch: string;
  bar: string;
}

const FAMILIES: Record<Family, FamilyInfo> = {
  read:    { label: "Reading files",    verb: "look",   swatch: "bg-sky-500",     bar: "bg-sky-500" },
  edit:    { label: "Editing files",    verb: "change", swatch: "bg-amber-500",   bar: "bg-amber-500" },
  command: { label: "Running commands", verb: "run",    swatch: "bg-emerald-500", bar: "bg-emerald-500" },
  search:  { label: "Searching code",   verb: "find",   swatch: "bg-violet-500",  bar: "bg-violet-500" },
  web:     { label: "Using the web",    verb: "browse", swatch: "bg-cyan-500",    bar: "bg-cyan-500" },
  other:   { label: "Everything else",  verb: "other step", swatch: "bg-zinc-400", bar: "bg-zinc-400" },
};

const FAMILY_ORDER: Family[] = ["read", "edit", "command", "search", "web", "other"];

/** Raw Claude Code tool name → plain family. Unknown tools (MCP, subagents, todos) are "other". */
const TOOL_FAMILY: Record<string, Family> = {
  Read: "read",
  Glob: "read",
  LS: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "command",
  BashOutput: "command",
  KillShell: "command",
  KillBash: "command",
  Grep: "search",
  WebFetch: "web",
  WebSearch: "web",
};

const familyOf = (tool: string): Family => TOOL_FAMILY[tool] ?? "other";

/** Pairs that read better than the generic "X, then Y". */
const PATTERN_NAMES: Record<string, string> = {
  "read>edit": "Look, then change",
  "edit>command": "Change, then test",
  "command>edit": "Fix after a run",
  "search>read": "Find, then open",
  "read>read": "Read around",
  "edit>edit": "Several changes in a row",
  "command>command": "Run a few commands",
  "command>read": "Run, then check",
  "edit>read": "Change, then re-check",
};

const GLOSSARY: [string, string][] = [
  ["Read", "Opens a file to look at it"],
  ["Edit", "Changes part of a file"],
  ["Write", "Creates or replaces a whole file"],
  ["Bash", "Runs a terminal command"],
  ["Grep", "Searches file contents"],
  ["Glob", "Finds files by name"],
  ["WebFetch", "Opens a web page"],
  ["WebSearch", "Searches the web"],
  ["NotebookEdit", "Changes a cell in a Jupyter notebook"],
  ["Task", "Hands a job to a subagent"],
  ["TodoWrite", "Keeps the session’s to-do list"],
  ["ToolSearch", "Looks up other tools it can use"],
];

const ROWS = 5;

export function ToolsView() {
  const [project, setProject] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("30");
  const days = range === "all" ? null : Number(range);
  const stats = useQuery({
    ...queries.toolStats(project, days),
    // Keep the old numbers on screen while a new project / range loads.
    placeholderData: (prev) => prev,
  });
  const showSkeleton = useDelayedLoading(stats.isLoading);

  const controls = (projects: string[]) => (
    <>
      <ProjectFilter projects={projects} value={project} onChange={setProject} />
      <Segmented value={range} options={RANGES} onChange={setRange} ariaLabel="Range" />
    </>
  );

  if (stats.isError && !stats.data) {
    return (
      <Page>
        <PageHeader title="Tools" />
        <ErrorState
          title="Couldn’t read tool usage"
          body="LunoPeak couldn’t read your agent session logs. They may have moved, or LunoPeak needs Full Disk Access."
          onRetry={() => void stats.refetch()}
          error={stats.error}
        />
      </Page>
    );
  }
  if (!stats.data) return showSkeleton ? <ToolsSkeleton /> : null;

  const s = stats.data;
  if (s.totalCalls === 0) {
    return (
      <Page>
        <PageHeader title="Tools" actions={controls(s.projects)} />
        <EmptyState
          icon={Zap}
          title={range === "7" ? "No tool calls this week" : range === "30" ? "No tool calls in the last 30 days" : "No tool calls yet"}
          body="When agents read files, run commands or search, you’ll see the breakdown here."
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title="Tools" lead={<Lead s={s} range={range} />} actions={controls(s.projects)} />
      <ShareCard s={s} />
      <div className="grid grid-cols-2 gap-3">
        <FilesCard s={s} />
        <CommandsCard s={s} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FailuresCard s={s} />
        <PatternsCard s={s} />
      </div>
      <Glossary />
    </Page>
  );
}

function Lead({ s, range }: { s: ToolStats; range: Range }) {
  // Week-over-week from the day series, which always spans every session.
  const sum = (xs: { calls: number }[]) => xs.reduce((a, d) => a + d.calls, 0);
  const last7 = sum(s.byDay.slice(-7));
  const prev7 = sum(s.byDay.slice(-14, -7));
  const delta = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : null;
  const change = delta === null ? null : delta === 0 ? null : `${Math.abs(delta)}% ${delta > 0 ? "more" : "fewer"}`;
  const trend =
    delta === null
      ? ""
      : range === "7"
        ? change
          ? `, ${change} than last week`
          : ", about the same as last week"
        : change
          ? `, with ${change} this week than last`
          : ", about as many this week as last";
  const failed = s.errorRatePct > 0 && s.errorRatePct < 0.1 ? "<0.1%" : `${s.errorRatePct.toFixed(1)}%`;
  const when = range === "7" ? "this week" : range === "30" ? "in the last 30 days" : "in total";

  return (
    <>
      Agents made <b>{plural(s.totalCalls, "tool call")}</b> {when}
      {trend}.{" "}
      {s.totalErrors > 0 ? (
        <>
          <b>{failed}</b> of them failed.
        </>
      ) : (
        "None of them failed."
      )}
    </>
  );
}

interface FamilyRow {
  family: Family;
  calls: number;
  errors: number;
  tools: string[];
}

/** Fold the per-tool rows into families; whatever isn't itemised lands in "other". */
function families(s: ToolStats): FamilyRow[] {
  const rows = new Map<Family, FamilyRow>(
    FAMILY_ORDER.map((f) => [f, { family: f, calls: 0, errors: 0, tools: [] }]),
  );
  for (const t of s.byTool) {
    const r = rows.get(familyOf(t.name))!;
    r.calls += t.calls;
    r.errors += t.errors;
    r.tools.push(t.name);
  }
  const itemised = [...rows.values()].reduce((a, r) => a + r.calls, 0);
  rows.get("other")!.calls += Math.max(0, s.totalCalls - itemised);
  return [...rows.values()];
}

function ShareCard({ s }: { s: ToolStats }) {
  const rows = families(s).filter((r) => r.calls > 0);
  const total = Math.max(1, rows.reduce((a, r) => a + r.calls, 0));
  return (
    <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">What agents spend their time on</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Share of all tool calls</span>
      </div>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {rows.map((r) => (
          <span
            key={r.family}
            className={cn("origin-left animate-chart-bar-grow-x", FAMILIES[r.family].bar)}
            style={{ flex: r.calls }}
            title={`${FAMILIES[r.family].label} · ${formatCount(r.calls)} calls`}
          />
        ))}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(rows.length, 5)}, minmax(0, 1fr))` }}>
        {rows.map((r) => (
          <div key={r.family} className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
              <span className={cn("size-2 shrink-0 rounded-[2px]", FAMILIES[r.family].swatch)} />
              <span className="truncate">{FAMILIES[r.family].label}</span>
            </span>
            <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {pct(r.calls / total)}
            </span>
            <Mono className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400" title={r.tools.join(", ")}>
              {r.tools.length > 0 ? r.tools.join(", ") : "Other tools"}
            </Mono>
          </div>
        ))}
      </div>
    </Card>
  );
}

function MeterList({
  rows,
  bar,
  rtl,
}: {
  rows: { key: string; label: string; title?: string; count: number }[];
  bar: string;
  /** Truncate from the left so a path keeps its file name. */
  rtl?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="flex flex-col gap-[9px] px-[18px]">
      {rows.map((r, i) => (
        <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_80px_36px] items-center gap-2.5" title={r.title ?? r.label}>
          <Mono
            className={cn("truncate text-[12.5px] text-zinc-800 dark:text-zinc-200", rtl && "text-left [direction:rtl]")}
          >
            {/* The bidi isolate keeps leading slashes/dots in place under rtl. */}
            {rtl ? <bdi>{r.label}</bdi> : r.label}
          </Mono>
          <span className="h-[5px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
            <span
              className={cn("block h-full origin-left rounded-full animate-chart-bar-grow-x", bar)}
              style={{ width: `${(r.count / max) * 100}%`, animationDelay: `${i * 40}ms` }}
            />
          </span>
          <span className="text-right text-[12.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatCount(r.count)}
          </span>
        </div>
      ))}
    </div>
  );
}

function FilesCard({ s }: { s: ToolStats }) {
  return (
    <Card className="flex flex-col pb-4">
      <CardHeader title="Files edited most" meta="times edited" />
      {s.topFiles.length === 0 ? (
        <Quiet>No file edits in this range.</Quiet>
      ) : (
        <MeterList
          rtl
          bar="bg-amber-500"
          rows={s.topFiles.slice(0, ROWS).map((f) => ({
            key: f.path,
            label: repoRelative(f.path, f.repo),
            title: f.path,
            count: f.count,
          }))}
        />
      )}
    </Card>
  );
}

function CommandsCard({ s }: { s: ToolStats }) {
  return (
    <Card className="flex flex-col pb-4">
      <CardHeader title="Commands run most" meta="times run" />
      {s.topCommands.length === 0 ? (
        <Quiet>No commands run in this range.</Quiet>
      ) : (
        <MeterList
          bar="bg-emerald-500"
          rows={s.topCommands.slice(0, ROWS).map((c) => ({ key: c.command, label: c.command, count: c.count }))}
        />
      )}
    </Card>
  );
}

function FailuresCard({ s }: { s: ToolStats }) {
  const rows = families(s)
    .filter((r) => r.errors > 0 && r.calls > 0)
    .map((r) => ({ ...r, rate: r.errors / r.calls }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 3);
  return (
    <Card className="flex flex-col">
      <CardHeader title="Where things fail" />
      {rows.length === 0 ? (
        <Quiet className="pb-4">Nothing failed in this range.</Quiet>
      ) : (
        <div className="flex flex-col px-[18px] pb-1.5">
          {rows.map((r, i) => {
            const failing = s.byTool
              .filter((t) => t.errors > 0 && familyOf(t.name) === r.family)
              .map((t) => t.name);
            return (
              <div
                key={r.family}
                className={cn("flex items-center gap-3 py-[9px]", i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]")}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="text-[13px] text-zinc-900 dark:text-zinc-100">{FAMILIES[r.family].label}</span>
                  <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {formatCount(r.errors)} of {plural(r.calls, "call")}
                    {failing.length > 0 && (
                      <>
                        {" · "}
                        <Mono className="text-[11.5px]">{failing.join(", ")}</Mono>
                      </>
                    )}
                  </span>
                </div>
                <span
                  className={cn(
                    "whitespace-nowrap text-[12.5px] font-semibold",
                    r.rate >= 0.04
                      ? "text-rose-600 dark:text-rose-400"
                      : r.rate >= 0.015
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-zinc-500 dark:text-zinc-400",
                  )}
                >
                  {pct(r.rate, 1)} failed
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function PatternsCard({ s }: { s: ToolStats }) {
  const rows = s.sequences.slice(0, 4);
  return (
    <Card className="flex flex-col pb-4">
      <CardHeader title="Common patterns" meta="Steps agents often take in a row" />
      {rows.length === 0 ? (
        <Quiet>Not enough steps in this range to spot patterns.</Quiet>
      ) : (
        <div className="flex flex-col gap-2.5 px-[18px]">
          {rows.map((p) => (
            <div key={`${p.from}>${p.to}`} className="flex items-center gap-2.5">
              <span className="flex items-center gap-1">
                <Step>{p.from}</Step>
                <ArrowRight size={12} strokeWidth={2} className="text-zinc-400" />
                <Step>{p.to}</Step>
              </span>
              <span className="flex-1 truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">
                {patternName(p.from, p.to)}
              </span>
              <span className="text-[12.5px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                {formatCount(p.count)}×
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Step({ children }: { children: string }) {
  return (
    <Mono className="rounded-[5px] bg-black/[0.05] px-1.5 py-0.5 text-zinc-800 dark:bg-white/[0.07] dark:text-zinc-200">
      {children}
    </Mono>
  );
}

function Glossary() {
  const [open, setOpen] = useState(false);
  return (
    <Card className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-[14px] px-[18px] py-3.5 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">What does each tool do?</span>
        <ChevronRight
          size={14}
          strokeWidth={2}
          className={cn("text-zinc-500 transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-6 px-[18px] pb-3.5">
          {GLOSSARY.map(([name, desc]) => (
            <div key={name} className="flex gap-3 border-t border-black/[0.05] py-2 dark:border-white/[0.06]">
              <Mono className="w-[96px] shrink-0 text-[12.5px] text-zinc-900 dark:text-zinc-100">{name}</Mono>
              <span className="text-[12.5px] text-zinc-600 dark:text-zinc-400">{desc}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: string[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex max-w-[220px] items-center gap-1.5 rounded-lg border border-black/[0.09] bg-white px-2.5 py-1.5 text-[12.5px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:bg-white/[0.1]"
      >
        <span className="truncate">{value ?? "All projects"}</span>
        <ChevronDown size={12} strokeWidth={2.25} className="shrink-0 text-zinc-500" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-[10px] border border-black/[0.08] bg-white py-1 shadow-lg dark:border-white/[0.1] dark:bg-zinc-900"
        >
          <ProjectOption label="All projects" checked={value === null} onClick={() => pick(null)} />
          {projects.length > 0 && <div className="my-1 border-t border-black/[0.06] dark:border-white/[0.06]" />}
          {projects.map((p) => (
            <ProjectOption key={p} label={p} checked={value === p} onClick={() => pick(p)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectOption({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] text-zinc-800 transition-colors hover:bg-black/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.06]"
    >
      <span className="truncate">{label}</span>
      {checked && <Check size={13} strokeWidth={2} className="shrink-0 text-blue-600 dark:text-blue-400" />}
    </button>
  );
}

function Quiet({ children, className }: { children: string; className?: string }) {
  return <span className={cn("px-[18px] text-[13px] text-zinc-500 dark:text-zinc-400", className)}>{children}</span>;
}

function patternName(from: string, to: string): string {
  const a = familyOf(from);
  const b = familyOf(to);
  const named = PATTERN_NAMES[`${a}>${b}`];
  if (named) return named;
  const text = `${FAMILIES[a].verb}, then ${FAMILIES[b].verb}`;
  return text[0].toUpperCase() + text.slice(1);
}

/** Path from the repo root when the repo name appears in it, else the last three segments. */
function repoRelative(path: string, repo: string | null): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const idx = repo ? parts.lastIndexOf(repo) : -1;
  if (idx >= 0 && idx < parts.length - 1) return parts.slice(idx + 1).join("/");
  return parts.slice(-3).join("/");
}

function pct(ratio: number, digits = 0): string {
  const v = ratio * 100;
  if (v > 0 && v < 1 && digits === 0) return "<1%";
  return `${v.toFixed(digits)}%`;
}

function ToolsSkeleton() {
  return (
    <Page>
      <PageHeader title="Tools" />
      <PageLoading caption="Counting the tools your agents used…">
        <Bone className="h-[124px]" />
        <div className="grid grid-cols-2 gap-3">
          <Bone className="h-[190px]" />
          <Bone className="h-[190px]" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Bone className="h-[160px]" />
          <Bone className="h-[160px]" />
        </div>
      </PageLoading>
    </Page>
  );
}
