import type { Session, SessionDetail, SessionEvent } from "@/types/api";

/** "claude-opus-4-7-20250101" → "Opus 4.7". Falls back to the raw id. */
export function friendlyModel(model: string): string {
  const m = model.toLowerCase();
  if (/fable-?5[-.]1/.test(m)) return "Fable 5.1";
  if (/fable-?5/.test(m)) return "Fable 5";
  if (/fable/.test(m)) return "Fable";
  if (/mythos-?5[-.]1/.test(m)) return "Mythos 5.1";
  if (/mythos-?5/.test(m)) return "Mythos 5";
  if (/mythos/.test(m)) return "Mythos";
  if (/opus-?5[-.]5/.test(m)) return "Opus 5.5";
  if (/opus-?5/.test(m)) return "Opus 5";
  if (/opus-?4-?8/.test(m)) return "Opus 4.8";
  if (/opus-?4-?7/.test(m)) return "Opus 4.7";
  if (/opus-?4-?6/.test(m)) return "Opus 4.6";
  if (/opus-?4-?5/.test(m)) return "Opus 4.5";
  if (/opus/.test(m)) return "Opus";
  if (/sonnet-?5[-.]5/.test(m)) return "Sonnet 5.5";
  if (/sonnet-?5/.test(m)) return "Sonnet 5";
  if (/sonnet-?4-?7/.test(m)) return "Sonnet 4.7";
  if (/sonnet-?4-?6/.test(m)) return "Sonnet 4.6";
  if (/sonnet-?4-?5/.test(m)) return "Sonnet 4.5";
  if (/sonnet/.test(m)) return "Sonnet";
  if (/haiku-?5[-.]5/.test(m)) return "Haiku 5.5";
  if (/haiku-?4-?5/.test(m)) return "Haiku 4.5";
  if (/haiku/.test(m)) return "Haiku";
  return model;
}

/** A session's display title: the first line of its opening prompt. */
export function sessionTitle(s: Pick<Session, "firstPrompt">): string {
  const line = s.firstPrompt?.trim().split("\n")[0]?.trim();
  return line || "Untitled session";
}

/** "repo · branch · model" meta line, skipping the parts we don't know. */
export function sessionMeta(
  s: Pick<Session, "projectName" | "branch" | "model">,
): { repo: string | null; branch: string | null; model: string | null } {
  return {
    repo: s.projectName,
    branch: s.branch && s.branch !== "HEAD" ? s.branch : null,
    model: s.model ? friendlyModel(s.model) : null,
  };
}

/** "1h 12m" / "34m" / "40s" — minute precision for list rows. */
export function shortDuration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** "Today", "Yesterday", or "Mon, Oct 14" for a day bucket. */
export function dayLabel(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const diffDays = Math.round(
    (start.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Trim an absolute path to its project-relative tail. */
export function shortenPath(path: string, root?: string | null, segments = 3): string {
  if (!path) return "";
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (!path.includes("/")) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

// ── Steps ─────────────────────────────────────────────────────────────
// Replay and Transcripts show tool calls as plain sentences ("Read
// src/auth/session.ts") grouped into five families, with the raw tool name
// kept as secondary detail.

export type StepKind = "you" | "reply" | "read" | "edit" | "run" | "other";

export const STEP_META: Record<StepKind, { label: string; swatch: string }> = {
  you: { label: "You", swatch: "bg-zinc-400" },
  reply: { label: "Claude replied", swatch: "bg-amber-500" },
  read: { label: "Read or searched", swatch: "bg-sky-500" },
  edit: { label: "Edited a file", swatch: "bg-violet-500" },
  run: { label: "Ran a command", swatch: "bg-emerald-500" },
  other: { label: "Other step", swatch: "bg-zinc-300 dark:bg-zinc-600" },
};

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function toolKind(name: string | null): StepKind {
  if (!name) return "other";
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (name === "Bash") return "run";
  return "other";
}

/** Plain-English sentence for a tool call. */
export function describeTool(
  name: string | null,
  summary: string | null,
  root?: string | null,
): string {
  const arg = summary?.trim() ?? "";
  const path = shortenPath(arg, root);
  switch (name) {
    case "Read":
      return arg ? `Read ${path}` : "Read a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return arg ? `Edited ${path}` : "Edited a file";
    case "Write":
      return arg ? `Wrote ${path}` : "Wrote a file";
    case "Bash":
      return arg ? `Ran ${arg}` : "Ran a command";
    case "Grep":
      return arg ? `Searched for ${arg}` : "Searched the code";
    case "Glob":
      return arg ? `Looked for files matching ${arg}` : "Looked for files";
    case "LS":
      return arg ? `Listed ${path}` : "Listed a folder";
    case "WebFetch":
      return arg ? `Opened ${arg}` : "Opened a web page";
    case "WebSearch":
      return arg ? `Searched the web for ${arg}` : "Searched the web";
    case "Task":
    case "Agent":
      return arg ? `Handed off to a subagent: ${arg}` : "Handed off to a subagent";
    case "Skill":
      return arg ? `Used the ${arg} skill` : "Used a skill";
    case "TodoWrite":
      return "Updated its to-do list";
    default:
      return arg ? `Used ${name ?? "a tool"}: ${arg}` : `Used ${name ?? "a tool"}`;
  }
}

export interface Step {
  kind: StepKind;
  ts: number;
  /** Plain sentence (tool steps) or message text. */
  text: string;
  toolName: string | null;
  result: string | null;
  isError: boolean;
}

/**
 * Collapse the raw event stream into replay steps: each tool call absorbs
 * the result that answers it, so "Ran pnpm test" carries "2 failed, 14
 * passed" instead of being two separate beats.
 */
export function buildSteps(detail: SessionDetail): Step[] {
  const steps: Step[] = [];
  const pending: Step[] = [];
  for (const e of detail.events) {
    if (e.kind === "tool_result") {
      const owner = pending.shift();
      if (owner) {
        owner.result = e.toolResult;
        owner.isError = e.isError;
      }
      continue;
    }
    if (e.kind === "tool_use") {
      const step: Step = {
        kind: toolKind(e.toolName),
        ts: e.ts,
        text: describeTool(e.toolName, e.toolSummary, detail.projectPath),
        toolName: e.toolName,
        result: null,
        isError: false,
      };
      steps.push(step);
      pending.push(step);
      continue;
    }
    if (e.kind === "system") continue;
    steps.push({
      kind: e.kind === "user" ? "you" : "reply",
      ts: e.ts,
      text: e.text ?? "",
      toolName: null,
      result: null,
      isError: false,
    });
  }
  return steps;
}

export function isToolEvent(e: SessionEvent): boolean {
  return e.kind === "tool_use" || e.kind === "tool_result";
}
