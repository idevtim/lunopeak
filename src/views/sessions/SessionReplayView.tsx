import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Code2, History, Pause, Play } from "lucide-react";
import { api } from "@/lib/tauri";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { type RouteId } from "@/routes";
import { BackLink } from "@/components/ui/BackLink";
import { Card, CardHeader, Mono, Page, PageHeader } from "@/components/ui/Page";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { formatCount, formatUsd, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  STEP_META,
  buildSteps,
  clockTime,
  dayLabel,
  sessionMeta,
  sessionTitle,
  shortDuration,
  shortenPath,
  type Step,
  type StepKind,
} from "./sessionFormat";

const PLAY_STEP_MS = 700;
const LEGEND: StepKind[] = ["you", "reply", "read", "edit", "run"];

export function SessionReplayView() {
  const { params, navigateTo } = useHashRoute();
  const id = params.get("id") ?? "";
  // BackLink follows in-app history; this is only the deep-link fallback.
  const backFallback: RouteId = params.get("from") === "transcripts" ? "transcripts" : "sessions";
  const detail = useQuery({
    queryKey: ["session-detail", id],
    queryFn: () => api.getSessionDetail(id),
    enabled: id.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const openInEditor = useOpenInEditor();
  const showSkeleton = useDelayedLoading(detail.isLoading);

  const steps = useMemo(() => (detail.data ? buildSteps(detail.data) : []), [detail.data]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setCursor(0);
    setPlaying(false);
  }, [id]);

  useEffect(() => {
    if (!playing || steps.length === 0) return;
    const t = window.setInterval(() => {
      setCursor((c) => {
        if (c + 1 >= steps.length) {
          setPlaying(false);
          return steps.length - 1;
        }
        return c + 1;
      });
    }, PLAY_STEP_MS);
    return () => window.clearInterval(t);
  }, [playing, steps.length]);

  const go = (i: number) => setCursor(Math.max(0, Math.min(steps.length - 1, i)));

  // ← / → step through the replay (ignored while typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, c - 1));
      else if (e.key === "ArrowRight") setCursor((c) => Math.min(steps.length - 1, c + 1));
      else return;
      setPlaying(false);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length]);

  const back = (
    <BackLink
      fallback={backFallback}
      className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
    />
  );

  if (!id) {
    return (
      <Page>
        <PageHeader above={back} title="Session replay" />
        <EmptyState
          icon={History}
          title="No session selected"
          body="Pick a session to step through what the agent did."
          primary={{ label: "Go to Sessions", onClick: () => navigateTo("sessions") }}
        />
      </Page>
    );
  }
  if (detail.isLoading) return showSkeleton ? <ReplaySkeleton /> : null;
  if (detail.isError) {
    return (
      <Page>
        <PageHeader above={back} title="Session replay" />
        <ErrorState
          title="Couldn't read this session"
          body="LunoPeak couldn't open the session's log in ~/.claude/projects."
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />
      </Page>
    );
  }
  if (!detail.data) {
    return (
      <Page>
        <PageHeader above={back} title="Session replay" />
        <EmptyState
          icon={History}
          title="Couldn't find this session"
          body="Its log may have been deleted or moved since LunoPeak last looked."
          primary={{ label: "Go to Sessions", onClick: () => navigateTo("sessions") }}
        />
      </Page>
    );
  }

  const d = detail.data;
  const meta = sessionMeta(d);
  const current = steps[cursor];
  const tokens = d.usage.input + d.usage.output + d.usage.cacheRead + d.usage.cacheCreation;
  const toolSteps = steps.filter((s) => s.toolName).length;

  const summary = [
    { value: shortDuration(Math.max(0, d.endTs - d.startTs)), label: "long" },
    { value: d.messageCount.toLocaleString(), label: "messages" },
    { value: toolSteps.toLocaleString(), label: "steps" },
    { value: d.filesModified.length.toLocaleString(), label: "files changed" },
    { value: d.costUsd > 0 ? formatUsd(d.costUsd) : "—", label: `${formatCount(tokens)} tokens` },
  ];

  return (
    <Page className="pt-9">
      <PageHeader
        above={back}
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <ProviderIcon provider="claude" size={18} className="text-amber-600 dark:text-amber-400" />
            <span className="truncate">{sessionTitle(d)}</span>
          </span>
        }
        lead={
          <>
            {["Claude", meta.model, meta.repo].filter(Boolean).join(" · ")}
            {meta.branch && (
              <>
                {" · "}
                <Mono className="text-[12.5px]">{meta.branch}</Mono>
              </>
            )}
            {d.startTs > 0 &&
              ` · ${dayLabel(d.startTs)}, ${clockTime(d.startTs)}–${clockTime(d.endTs)}`}
          </>
        }
        actions={
          <>
            <Button onClick={() => navigateTo("transcripts", { id: d.id })}>Open transcript</Button>
            <Button
              disabled={!d.projectPath}
              onClick={() => d.projectPath && openInEditor(d.projectPath)}
            >
              <Code2 size={13} strokeWidth={1.9} />
              Open in editor
            </Button>
          </>
        }
      />

      <Card className="grid grid-cols-5 gap-3 px-[18px] py-3.5">
        {summary.map((s) => (
          <div key={s.label} className="flex flex-col gap-px">
            <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
              {s.value}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{s.label}</span>
          </div>
        ))}
      </Card>

      <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Replay</span>
          {steps.length > 0 && (
            <span className="text-[12.5px] tabular-nums text-zinc-600 dark:text-zinc-400">
              Step {cursor + 1} of {steps.length}
            </span>
          )}
          <IconButton
            label={playing ? "Pause" : "Play"}
            disabled={steps.length === 0}
            onClick={() => {
              if (!playing && cursor >= steps.length - 1) setCursor(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? <Pause size={13} strokeWidth={2.25} /> : <Play size={13} strokeWidth={2.25} />}
          </IconButton>
          <IconButton label="Previous step" disabled={cursor === 0} onClick={() => go(cursor - 1)}>
            <ChevronLeft size={15} strokeWidth={2.25} />
          </IconButton>
          <IconButton
            label="Next step"
            disabled={cursor >= steps.length - 1}
            onClick={() => go(cursor + 1)}
          >
            <ChevronRight size={15} strokeWidth={2.25} />
          </IconButton>
        </div>

        {steps.length === 0 ? (
          <p className="py-4 text-[13px] text-zinc-500 dark:text-zinc-400">
            This session has no recorded steps.
          </p>
        ) : (
          <>
            <Scrubber steps={steps} cursor={cursor} onPick={(i) => { setPlaying(false); go(i); }} />
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
              {LEGEND.concat(steps.some((s) => s.kind === "other") ? ["other"] : []).map((k) => (
                <span key={k} className="flex items-center gap-1.5">
                  <span className={cn("size-[9px] rounded-[2px]", STEP_META[k].swatch)} />
                  {STEP_META[k].label}
                </span>
              ))}
            </div>
            {current && <CurrentStep step={current} />}
          </>
        )}
      </Card>

      {d.filesModified.length > 0 && (
        <Card className="pb-3">
          <CardHeader title="Files changed" meta={plural(d.filesModified.length, "file")} />
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-[18px]">
            {d.filesModified.map((f) => (
              <span key={f} title={f} className="truncate py-1 font-mono text-[12.5px] text-zinc-800 dark:text-zinc-200">
                {shortenPath(f, d.projectPath)}
              </span>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}

function IconButton({
  label,
  children,
  ...props
}: { label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-[30px] items-center justify-center rounded-lg border border-black/10 bg-white text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:bg-white/[0.1]"
      {...props}
    >
      {children}
    </button>
  );
}

/** One segment per step: played at full opacity, the rest at 30%, current outlined. */
function Scrubber({
  steps,
  cursor,
  onPick,
}: {
  steps: Step[];
  cursor: number;
  onPick: (i: number) => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursor]);
  const dense = steps.length > 150;
  return (
    <div className="overflow-x-auto px-0.5 py-1 [scrollbar-width:thin]">
      <div className={cn("flex h-7 items-stretch", dense ? "gap-px" : "gap-[3px]")}>
        {steps.map((s, i) => (
          <button
            key={i}
            ref={i === cursor ? activeRef : undefined}
            type="button"
            onClick={() => onPick(i)}
            title={`${i + 1}. ${STEP_META[s.kind].label}${s.isError ? " (failed)" : ""}`}
            className={cn(
              "min-w-[3px] flex-1 rounded-[4px] p-0 transition-opacity",
              STEP_META[s.kind].swatch,
              i > cursor && "opacity-30 hover:opacity-60",
              i === cursor && "outline outline-2 outline-offset-2 outline-zinc-900 dark:outline-zinc-100",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function CurrentStep({ step }: { step: Step }) {
  const isTool = step.toolName !== null;
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-black/[0.025] px-4 py-3.5 dark:bg-white/[0.04]">
      <div className="flex items-center gap-2">
        <span className={cn("size-[9px] rounded-[2px]", STEP_META[step.kind].swatch)} />
        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
          {STEP_META[step.kind].label}
        </span>
        {step.ts > 0 && <span className="text-xs text-zinc-400">{clockTime(step.ts)}</span>}
        {isTool && <Mono className="text-[11.5px] text-zinc-400">{step.toolName}</Mono>}
        {step.isError && <Pill tone="rose">Failed</Pill>}
      </div>
      <span
className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-900 text-pretty dark:text-zinc-100">
        {step.text || "(empty)"}
      </span>
      {step.result && (
        <span
          className={cn(
            "max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12.5px]",
            step.isError ? "text-rose-700 dark:text-rose-300" : "text-zinc-700 dark:text-zinc-300",
          )}
        >
          {step.result}
        </span>
      )}
    </div>
  );
}

function ReplaySkeleton() {
  return (
    <Page className="pt-9">
      <div className="flex flex-col gap-2">
        <Bone className="h-4 w-20 rounded-md" />
        <Bone className="h-7 w-80 rounded-lg" />
        <Bone className="h-4 w-96 rounded-md" />
      </div>
      <PageLoading caption="Loading this session step by step…">
        <Bone className="h-[68px]" />
        <Bone className="h-56" />
        <Bone className="h-28" />
      </PageLoading>
    </Page>
  );
}
