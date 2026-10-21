import { invoke } from "@tauri-apps/api/core";
import type { Session } from "@/types/api";

/**
 * Tool definitions sent to Anthropic. Each name maps to an executor below.
 * Keep input_schema strict so the model doesn't hallucinate arguments.
 */
export const TOOLS = [
  {
    name: "list_repos",
    description:
      "List all git repos LunoPeak has detected across the user's scan directories. Returns repo name, path, branch, last activity, and whether it has uncommitted changes or a CLAUDE.md.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "session_stats",
    description:
      "Aggregate stats over every AI coding session captured locally (Claude Code, Codex, or Cursor — whichever the user runs): total sessions, total messages, total spend in USD, hour-of-day histogram, 30-day daily session counts, and per-model breakdown.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "cost_breakdown",
    description:
      "USD spend broken down by model, by repo, and by day for the last 30 days. Computed from local session token usage × Anthropic list prices.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "hygiene_issues",
    description:
      "Per-repo config / safety issues — missing CLAUDE.md, missing .gitignore, .env files that aren't gitignored. Ordered by severity (errors first).",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "active_processes",
    description:
      "Currently running AI dev processes (claude, cursor, cline) with their PID, cwd, runtime, and memory.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "recent_sessions",
    description:
      "The 20 most recent AI coding sessions captured locally with project, model, message count, duration, cost, and the first user prompt.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "tool_usage",
    description:
      "Aggregate tool-use distribution across all sessions: which tools the assistant called, how often, and how many of those returned errors.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

const HANDLERS: Record<ToolName, () => Promise<unknown>> = {
  list_repos: () => invoke("scan_repos"),
  session_stats: () => invoke("get_session_stats"),
  cost_breakdown: () => invoke("get_costs"),
  hygiene_issues: () => invoke("get_hygiene"),
  active_processes: () => invoke("get_active_processes"),
  recent_sessions: async () => {
    const all = await invoke<Session[]>("get_sessions");
    return all.slice(0, 20);
  },
  tool_usage: () => invoke("get_tool_stats"),
};

export interface ToolExecution {
  content: string;
  isError: boolean;
}

export async function executeTool(name: string): Promise<ToolExecution> {
  const handler = HANDLERS[name as ToolName];
  if (!handler) {
    return {
      content: `Unknown tool: ${name}`,
      isError: true,
    };
  }
  try {
    const result = await handler();
    return { content: JSON.stringify(result, null, 2), isError: false };
  } catch (e) {
    return { content: e instanceof Error ? e.message : String(e), isError: true };
  }
}
