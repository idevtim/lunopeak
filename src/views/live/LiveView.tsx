import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Code2, Folder, MessageCircle, Sparkles, Square, X } from "lucide-react";
import { queries } from "@/lib/queries";
import { api } from "@/lib/tauri";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { fileManagerName, usePlatform } from "@/hooks/usePlatform";
import { Card, Lead, Mono, Page, PageHeader } from "@/components/ui/Page";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState } from "@/components/ui/PageStates";
import { LiveDot } from "@/components/ui/LiveDot";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import {
  ContextBar,
  contextPctClass,
  formatContextPct,
  formatContextTokens,
  shortModel,
} from "@/components/ui/ContextMeter";
import { Sparkbars } from "@/components/charts/Sparkbars";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toastStore";
import { confirm } from "@/stores/confirmStore";
import {
  isStale,
  useProcessSamplesStore,
  type PidState,
} from "@/stores/processSamplesStore";
import { providerAccent, providerLabel } from "@/views/tray-panel/shared";
import type { ActiveProcess, LiveAgent, LiveContext, SessionLiveState } from "@/types/api";
import { LiveFeed } from "./LiveFeed";
import { LiveSkeleton } from "./LiveSkeleton";
import {
  SESSION_STATE_LABEL,
  basename,
  describeAction,
  memoryNote,
  runningFor,
  sessionState,
  shortAge,
  type SessionState,
} from "./describe";

const STATE_TONE: Record<SessionState, PillTone> = {
  working: "green",
  waiting: "blue",
  idle: "neutral",
};

const STATE_DOT: Record<SessionState, string> = {
  working: "bg-emerald-500",
  waiting: "bg-blue-500",
  idle: "bg-zinc-400",
};

export function LiveView() {
  const procs = useQuery({
    ...queries.activeProcesses,
    refetchInterval: 3000,
  });
  const live = useQuery({
    ...queries.liveActivity,
    refetchInterval: 2000,
  });
  const contexts = useQuery({
    ...queries.liveContexts,
    refetchInterval: 3000,
  });

  const ingest = useProcessSamplesStore((s) => s.ingest);
  const samples = useProcessSamplesStore((s) => s.byPid);

  useEffect(() => {
    if (procs.data) ingest(procs.data);
  }, [procs.data, ingest]);

  const sessions = live.data?.sessions ?? [];
  const sessionsByCwdAgent = useMemo(() => {
    const map = new Map<string, SessionLiveState[]>();
    // Scanner sorts sessions by lastTs desc, so each bucket is freshest-first.
    // Key by cwd + agent so codex processes don't pull from claude sessions
    // when both agents are running in the same folder.
    for (const s of sessions) {
      const key = sessionBucketKey(s.cwd, s.agent);
      if (!key) continue;
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return map;
  }, [sessions]);

  const showSkeleton = useDelayedLoading(procs.isLoading);
  if (showSkeleton) return <LiveSkeleton />;

  if (procs.isError && !procs.data) {
    return (
      <Page>
        <PageHeader title="Live" />
        <ErrorState
          title="Couldn't see running agents"
          body="LunoPeak couldn't read the list of running processes. If your system blocks it, allow LunoPeak in your privacy settings, then try again."
          onRetry={() => void procs.refetch()}
          error={procs.error}
        />
      </Page>
    );
  }

  const list = procs.data ?? [];
  const feed = live.data?.feed ?? [];
  const now = Date.now();
  const sorted = [...list].sort((a, b) => b.runtimeSec - a.runtimeSec);

  // Context rows carry the pid when the agent lets us map it (always for
  // Claude). Several Cursor chats share one pid — the list arrives freshest
  // first, so the first row per pid wins.
  const contextList = contexts.data ?? [];
  const contextByPid = new Map<number, LiveContext>();
  for (const c of contextList) {
    if (c.pid != null && !contextByPid.has(c.pid)) contextByPid.set(c.pid, c);
  }
  const contextFor = (p: ActiveProcess): LiveContext | undefined => {
    const byPid = contextByPid.get(p.pid);
    if (byPid) return byPid;
    const agent = agentOfProcess(p.name);
    const key = agent ? sessionBucketKey(p.cwd, agent) : null;
    return key
      ? contextList.find((c) => c.pid == null && sessionBucketKey(c.cwd, c.agent) === key)
      : undefined;
  };

  // A context row names the exact session a pid is running, so pair those
  // first. The rest get their own session within (cwd, agent) (freshest
  // process gets the freshest session) so co-located instances display
  // distinct activity. Pair only same-agent sessions — a codex process must
  // not display a claude session's last action just because they share a cwd.
  const sessionByPid = new Map<number, SessionLiveState>();
  const claimed = new Set<string>();
  for (const p of sorted) {
    const ctx = contextByPid.get(p.pid);
    if (!ctx || ctx.agent === "cursor") continue;
    const exact = sessions.find((s) => s.sessionId === ctx.sessionId);
    if (exact) {
      sessionByPid.set(p.pid, exact);
      claimed.add(exact.sessionId);
    }
  }
  for (const p of sorted) {
    if (sessionByPid.has(p.pid)) continue;
    const agent = agentOfProcess(p.name);
    if (!agent) continue;
    const key = sessionBucketKey(p.cwd, agent);
    if (!key) continue;
    const next = sessionsByCwdAgent.get(key)?.find((s) => !claimed.has(s.sessionId));
    if (!next) continue;
    sessionByPid.set(p.pid, next);
    claimed.add(next.sessionId);
  }

  const rows = sorted.map((p) => {
    const session = sessionByPid.get(p.pid);
    const context = contextFor(p);
    const stale = isStale(samples[p.pid]);
    const state: SessionState = stale
      ? "idle"
      : sessionState({
          status: context?.status,
          lastTs: Math.max(session?.lastTs ?? 0, context?.lastTs ?? 0) || null,
          lastTool: session?.lastTool,
          now,
        });
    return { proc: p, session, context, stale, state };
  });
  const active = rows.filter((r) => !r.stale);
  const idleRows = rows.filter((r) => r.stale);
  const order: Record<SessionState, number> = { waiting: 0, working: 1, idle: 2 };
  active.sort((a, b) => order[a.state] - order[b.state]);

  const count = (s: SessionState) => rows.filter((r) => r.state === s).length;
  const parts = [
    count("working") > 0 && `${count("working")} working`,
    count("waiting") > 0 && `${count("waiting")} waiting for you`,
    count("idle") > 0 && `${count("idle")} idle`,
  ].filter(Boolean);

  return (
    <Page className="gap-[18px]">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">
          Live
        </h1>
        <div className="flex items-center gap-2">
          {list.length > 0 && <LiveDot size="md" tone="emerald" />}
          <Lead>
            {list.length === 0 ? (
              "No agents running right now."
            ) : (
              <>
                <b>{plural(list.length, "session")}</b> open. {parts.join(", ")}.
              </>
            )}
          </Lead>
        </div>
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3">
          {list.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No agents running"
              body="Start Claude Code, Codex or Cursor in a project. It shows up here within a few seconds."
            />
          ) : (
            <>
              {active.map((r) => (
                <SessionCard
                  key={r.proc.pid}
                  proc={r.proc}
                  samples={samples[r.proc.pid]}
                  session={r.session}
                  context={r.context}
                  state={r.state}
                  now={now}
                />
              ))}
              {idleRows.length > 0 && (
                <IdleGroup
                  rows={idleRows.map((r) => ({
                    proc: r.proc,
                    title: sessionTitle(r.proc, r.context),
                    samples: samples[r.proc.pid],
                  }))}
                  now={now}
                />
              )}
            </>
          )}
        </div>
        <LiveFeed events={feed} className="lg:sticky lg:top-4" />
      </div>
    </Page>
  );
}

interface SessionCardProps {
  proc: ActiveProcess;
  samples: PidState | undefined;
  session: SessionLiveState | undefined;
  context: LiveContext | undefined;
  state: SessionState;
  now: number;
}

function SessionCard({ proc, samples, session, context, state, now }: SessionCardProps) {
  const platform = usePlatform();
  const fmName = fileManagerName(platform);
  const openInEditor = useOpenInEditor();
  const agent = agentOfProcess(proc.name);
  const title = sessionTitle(proc, context);
  const folder = basename(proc.cwd);
  const model = shortModel(context?.model ?? null);
  const subline = [folder !== title ? folder : null, model, `running ${runningFor(proc.runtimeSec)}`]
    .filter(Boolean)
    .join(" · ");
  const memMb = Math.round(proc.memoryKb / 1024);

  const todos = session?.todos ?? [];
  const inProgress = todos.find((t) => t.status === "in_progress");
  const step = inProgress ? todos.indexOf(inProgress) + 1 : 0;
  const asked = session?.lastTool === "AskUserQuestion";
  const lastAction = session?.lastSummary || session?.lastTool ? session : null;

  const onReveal = async () => {
    if (!proc.cwd) {
      toast.warning("No working folder", `PID ${proc.pid} has no working folder.`);
      return;
    }
    try {
      await api.revealInFinder(proc.cwd);
    } catch (e) {
      toast.error(`Couldn't open in ${fmName}`, String(e));
    }
  };

  return (
    <Card className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <ProviderTile agent={agent} name={proc.name} />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </span>
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{subline}</span>
        </div>
        <span
          className="hidden shrink-0 items-center gap-1.5 text-[11.5px] tabular-nums text-zinc-500 sm:flex dark:text-zinc-400"
          title={`Memory use over the last ${samples?.samples.length ?? 0} samples · PID ${proc.pid}`}
        >
          <Sparkbars
            values={samples?.samples ?? []}
            bars={24}
            className="h-3 w-12"
            barClassName={state === "working" ? "bg-emerald-400/70" : undefined}
          />
          {memMb} MB
        </span>
        <Pill tone={STATE_TONE[state]} className="shrink-0">
          <span className={cn("size-1.5 rounded-full", STATE_DOT[state])} />
          {SESSION_STATE_LABEL[state]}
        </Pill>
      </div>

      {asked && state === "waiting" ? (
        <div className="flex items-start gap-2.5 rounded-[10px] border border-blue-500/15 bg-blue-500/[0.06] px-3 py-2.5 dark:border-blue-400/20 dark:bg-blue-500/10">
          <MessageCircle size={15} strokeWidth={1.9} className="mt-px shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">
              {providerLabel(agent ?? proc.name)} asked you a question
            </span>
            <span className="text-[13px] text-zinc-900 dark:text-zinc-100">
              It's paused until you answer. Reply in your terminal.
            </span>
          </div>
        </div>
      ) : (
        inProgress && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Now</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-900 dark:text-zinc-100">
                {inProgress.content}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                Step {step} of {todos.length}
              </span>
            </div>
            <div
              className="grid gap-[3px]"
              style={{ gridTemplateColumns: `repeat(${todos.length}, minmax(0, 1fr))` }}
            >
              {todos.map((t, i) => (
                <span
                  key={i}
                  title={t.content}
                  className={cn(
                    "h-1 rounded-full",
                    t.status === "completed"
                      ? "bg-emerald-500"
                      : t.status === "in_progress"
                        ? "bg-emerald-500/45"
                        : "bg-black/[0.07] dark:bg-white/[0.08]",
                  )}
                />
              ))}
            </div>
          </div>
        )
      )}

      {lastAction && <LastAction session={lastAction} now={now} />}

      <div className="flex flex-wrap items-center gap-3 border-t border-black/[0.05] pt-2.5 dark:border-white/[0.06]">
        <ChatMemory context={context} />
        <SessionActions
          proc={proc}
          fmName={fmName}
          onOpenInEditor={proc.cwd ? () => openInEditor(proc.cwd!) : undefined}
          onReveal={onReveal}
        />
      </div>
    </Card>
  );
}

function ProviderTile({ agent, name }: { agent: LiveAgent | null; name: string }) {
  const accent = agent ? providerAccent(agent) : null;
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg",
        accent?.chip ?? "bg-black/[0.05] dark:bg-white/[0.07]",
      )}
    >
      {agent ? (
        <ProviderIcon provider={agent} size={14} className={accent?.text} />
      ) : (
        <Sparkles size={14} strokeWidth={1.75} className="text-zinc-600 dark:text-zinc-300" aria-label={name} />
      )}
    </span>
  );
}

function LastAction({ session, now }: { session: SessionLiveState; now: number }) {
  const { Icon, verb, detail } = describeAction(session.lastTool, session.lastSummary);
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-zinc-600 dark:text-zinc-400">
      <Icon size={13} strokeWidth={1.9} className="shrink-0 text-zinc-500 dark:text-zinc-400" />
      <span className="min-w-0 flex-1 truncate" title={session.lastSummary ?? undefined}>
        {verb}
        {detail && (
          <>
            {" "}
            <Mono className="text-zinc-700 dark:text-zinc-300">{detail}</Mono>
          </>
        )}
        {session.lastTool && (
          <Mono className="ml-2 text-[11px] text-zinc-400 dark:text-zinc-500">{session.lastTool}</Mono>
        )}
      </span>
      <span className="shrink-0 text-zinc-400 dark:text-zinc-500">{shortAge(session.lastTs, now)} ago</span>
    </div>
  );
}

function ChatMemory({ context }: { context: LiveContext | undefined }) {
  if (!context) return <span className="min-w-0 flex-1" />;
  const note = memoryNote(context.usedPercent);
  const tokensLabel = formatContextTokens(context);
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-1"
      title="How much of the model's context window this chat's latest turn used"
    >
      <div className="flex items-center gap-2.5">
        <span className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">Chat memory</span>
        <ContextBar agent={context.agent} pct={context.usedPercent} className="h-[5px] w-[120px] shrink-0" />
        <span className={cn("text-[12.5px] font-semibold tabular-nums", contextPctClass(context.usedPercent))}>
          {formatContextPct(context)}
        </span>
        {tokensLabel && (
          <span className="truncate text-[11.5px] tabular-nums text-zinc-400 dark:text-zinc-500">
            {tokensLabel}
          </span>
        )}
      </div>
      {note && (
        <span
          className={cn(
            "text-xs",
            note.tone === "rose"
              ? "text-rose-700 dark:text-rose-300"
              : note.tone === "amber"
                ? "text-amber-700 dark:text-amber-300"
                : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          {note.text}
        </span>
      )}
    </div>
  );
}

function SessionActions({
  proc,
  fmName,
  onOpenInEditor,
  onReveal,
}: {
  proc: ActiveProcess;
  fmName: string;
  onOpenInEditor?: () => void;
  onReveal: () => void;
}) {
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);

  const onStop = async () => {
    setStopping(true);
    try {
      await api.killProcess(proc.pid);
      toast.success(`Stopped ${processLabel(proc.name)}`, `PID ${proc.pid}`);
      void qc.invalidateQueries({ queryKey: queries.activeProcesses.queryKey });
    } catch (e) {
      toast.error(`Couldn't stop PID ${proc.pid}`, String(e));
    } finally {
      setStopping(false);
      setAsking(false);
    }
  };

  if (asking) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-[12.5px] text-zinc-700 dark:text-zinc-300">
          Stop this session?
        </span>
        <Button onClick={() => setAsking(false)}>Cancel</Button>
        <Button variant="destructive" disabled={stopping} onClick={() => void onStop()}>
          Stop
        </Button>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      {onOpenInEditor && (
        <Button onClick={onOpenInEditor}>
          <Code2 size={13} strokeWidth={1.9} />
          Open in editor
        </Button>
      )}
      {proc.cwd && (
        <Button onClick={onReveal} title={`Show in ${fmName}`}>
          <Folder size={13} strokeWidth={1.9} />
          {fmName}
        </Button>
      )}
      <Button onClick={() => setAsking(true)} title={`Stop PID ${proc.pid}`}>
        <Square size={12} strokeWidth={1.9} />
        Stop
      </Button>
    </span>
  );
}

function IdleGroup({
  rows,
  now,
}: {
  rows: Array<{ proc: ActiveProcess; title: string; samples: PidState | undefined }>;
  now: number;
}) {
  const qc = useQueryClient();
  const totalMb = Math.round(rows.reduce((sum, r) => sum + r.proc.memoryKb, 0) / 1024);

  const onCloseAll = async () => {
    const n = rows.length;
    const ok = await confirm({
      title: `Close ${plural(n, "idle session")}?`,
      body: `${n === 1 ? "This session hasn't" : "These sessions haven't"} done anything for 30 minutes or more. Closing stops the process and frees ${totalMb.toLocaleString()} MB. The chat history stays on disk.`,
      items: rows.map((r) => `${r.title} · PID ${r.proc.pid}`),
      confirmLabel: n === 1 ? "Close session" : `Close ${n} sessions`,
      destructive: true,
    });
    if (!ok) return;
    const results = await Promise.allSettled(rows.map((r) => api.killProcess(r.proc.pid)));
    const closed = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - closed;
    void qc.invalidateQueries({ queryKey: queries.activeProcesses.queryKey });
    if (failed === 0) {
      toast.success(`Closed ${plural(closed, "idle session")}`);
    } else if (closed === 0) {
      toast.error("Couldn't close the idle sessions", "Try again, or stop them from your terminal.");
    } else {
      toast.warning(`Closed ${closed} of ${results.length} idle sessions`, `${failed} couldn't be stopped.`);
    }
  };

  return (
    <div className="flex flex-col gap-2 pt-1.5">
      <div className="flex items-center gap-2.5 px-0.5">
        <span className="flex-1 text-[13px] font-semibold text-zinc-600 dark:text-zinc-400">
          Idle for a while
        </span>
        <Button onClick={() => void onCloseAll()}>
          <X size={13} strokeWidth={1.9} />
          Close idle sessions
        </Button>
      </div>
      {rows.map(({ proc, title, samples }) => {
        const agent = agentOfProcess(proc.name);
        const quietMin = samples ? Math.round((now - samples.lastChangeTs) / 60000) : null;
        const detail = [
          basename(proc.cwd) !== title ? basename(proc.cwd) : null,
          quietMin != null ? `no activity for ${quietMin} min` : null,
          `using ${Math.round(proc.memoryKb / 1024).toLocaleString()} MB`,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={proc.pid}
            className="flex items-center gap-2.5 rounded-xl border border-dashed border-black/[0.14] bg-white/60 px-4 py-3 dark:border-white/[0.14] dark:bg-white/[0.02]"
          >
            <span className="opacity-55">
              {agent ? (
                <ProviderIcon provider={agent} size={14} className="text-zinc-500" />
              ) : (
                <Sparkles size={14} strokeWidth={1.75} className="text-zinc-500" />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[13px] text-zinc-700 dark:text-zinc-300">{title}</span>
              <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{detail}</span>
            </div>
            <Pill tone="neutral" className="shrink-0">
              Idle
            </Pill>
          </div>
        );
      })}
    </div>
  );
}

/** Session name when the agent records one, else the folder, else the process. */
function sessionTitle(proc: ActiveProcess, context: LiveContext | undefined): string {
  return context?.name || basename(proc.cwd) || processLabel(proc.name);
}

/// Stable lookup key for matching a process cwd to a session cwd. Sysinfo on
/// Windows reports a trailing separator and may differ in drive-letter case
/// from what Claude Code records in the session JSONL — normalize both sides.
function cwdKey(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

/// Bucket key combining cwd + agent so claude and codex sessions in the same
/// folder live in separate pools.
function sessionBucketKey(
  path: string | null | undefined,
  agent: LiveAgent,
): string | null {
  const c = cwdKey(path);
  return c ? `${agent}::${c}` : null;
}

/// Map a process's reported name to its agent type. Returns null for agents
/// we don't have a live-data scanner for (cline) — those rows show the
/// process card but no per-session activity.
function agentOfProcess(name: string): LiveAgent | null {
  const n = name.toLowerCase().replace(/\.exe$/, "");
  if (n === "claude" || n.startsWith("claude ")) return "claude";
  if (n === "codex" || n.startsWith("codex ")) return "codex";
  if (n === "cursor" || n.startsWith("cursor ")) return "cursor";
  return null;
}

function processLabel(name: string): string {
  return name.replace(/\.exe$/i, "");
}
