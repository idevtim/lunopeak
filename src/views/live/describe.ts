import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  ListTodo,
  MessageCircle,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { LiveContext } from "@/types/api";

/** How long after its last event a session still counts as working. */
export const WORKING_WINDOW_MS = 30 * 1000;

export type SessionState = "working" | "waiting" | "idle";

export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  working: "Working",
  waiting: "Waiting for you",
  idle: "Idle",
};

/**
 * Working / waiting / idle for a session from what the scanners actually
 * know. Only Claude reports busy/idle — its "idle" means the turn finished
 * and it's waiting on your next message. Agents that don't report it count
 * as working while events are fresh and idle otherwise.
 */
export function sessionState({
  status,
  lastTs,
  lastTool,
  now = Date.now(),
}: {
  status: LiveContext["status"] | undefined;
  lastTs: number | null | undefined;
  lastTool?: string | null;
  now?: number;
}): SessionState {
  if (lastTool === "AskUserQuestion" && status !== "busy") return "waiting";
  if (status === "busy") return "working";
  if (lastTs != null && now - lastTs <= WORKING_WINDOW_MS) return "working";
  if (status === "idle") return "waiting";
  return "idle";
}

export interface ActionDescription {
  Icon: LucideIcon;
  /** Plain-words verb phrase: "Ran", "Edited", "Asked you a question". */
  verb: string;
  /** Raw target (path, command, query) shown mono after the verb. */
  detail: string | null;
}

const PATH_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Turn a raw tool event into plain words, keeping the raw target as detail. */
export function describeAction(tool: string | null, summary: string | null): ActionDescription {
  const raw = summary?.trim() || null;
  const detail = raw && tool && PATH_TOOLS.has(tool) ? shortenPath(raw) : raw;
  switch (tool) {
    case "Read":
      return { Icon: FileText, verb: "Read", detail };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { Icon: FilePen, verb: "Edited", detail };
    case "Write":
      return { Icon: FilePlus, verb: "Wrote", detail };
    case "Bash":
      return { Icon: Terminal, verb: detail ? "Ran" : "Ran a command", detail };
    case "Glob":
    case "Grep":
      return { Icon: Search, verb: detail ? "Searched for" : "Searched the code", detail };
    case "Task":
    case "Agent":
      return { Icon: Bot, verb: "Started a subagent", detail };
    case "Skill":
      return { Icon: Sparkles, verb: "Used a skill", detail };
    case "WebFetch":
      return { Icon: Globe, verb: "Opened a web page", detail };
    case "WebSearch":
      return { Icon: Globe, verb: "Searched the web for", detail };
    case "TodoWrite":
      return { Icon: ListTodo, verb: "Updated its to-do list", detail: null };
    case "AskUserQuestion":
      return { Icon: MessageCircle, verb: "Asked you a question", detail: null };
    case "Chat":
      return { Icon: MessageCircle, verb: "Replied", detail };
    case "User":
      return { Icon: MessageCircle, verb: "You wrote", detail };
    case null:
      return { Icon: Wrench, verb: "Did something", detail };
    default:
      return { Icon: Wrench, verb: `Used ${tool}`, detail };
  }
}

export function shortenPath(path: string, segments = 2): string {
  if (!path.includes("/")) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= segments) return path;
  return `…/${parts.slice(-segments).join("/")}`;
}

export function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (idx >= 0 ? trimmed.slice(idx + 1) : trimmed) || null;
}

/** Compact age for feeds: "12s", "4m", "2h", "3d". */
export function shortAge(ts: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

/** "1h 12m", "34m", "2d 4h" — how long a process has been running. */
export function runningFor(sec: number): string {
  const min = Math.max(1, Math.floor(sec / 60));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Note under a chat-memory bar. */
export function memoryNote(pct: number | null): { text: string; tone: "rose" | "amber" | "muted" } | null {
  if (pct == null) return null;
  if (pct >= 85) return { text: "Almost full. Start a new chat soon.", tone: "rose" };
  if (pct >= 70) return { text: "Getting full.", tone: "amber" };
  return { text: "Plenty of room", tone: "muted" };
}
