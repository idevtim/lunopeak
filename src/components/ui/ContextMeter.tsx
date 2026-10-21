import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { LiveAgent, LiveContext } from "@/types/api";

/** Fill at which a session's context is worth a glance. */
export const CONTEXT_WARN_PCT = 70;
/** Fill at which a session is close to auto-compacting / truncating. */
export const CONTEXT_DANGER_PCT = 85;

const agentBar: Record<LiveAgent, string> = {
  claude: "bg-gradient-to-r from-amber-500 to-orange-500",
  codex: "bg-gradient-to-r from-emerald-500 to-teal-500",
  cursor: "bg-gradient-to-r from-sky-500 to-blue-500",
};

function barClass(agent: LiveAgent, pct: number): string {
  if (pct >= CONTEXT_DANGER_PCT) return "bg-gradient-to-r from-rose-500 to-red-500";
  if (pct >= CONTEXT_WARN_PCT) return "bg-gradient-to-r from-amber-400 to-amber-600";
  return agentBar[agent] ?? agentBar.claude;
}

/** Text tone for a context percentage — neutral until it crosses a threshold. */
export function contextPctClass(pct: number | null): string {
  if (pct == null) return "text-zinc-500 dark:text-zinc-400";
  if (pct >= CONTEXT_DANGER_PCT) return "text-rose-600 dark:text-rose-400";
  if (pct >= CONTEXT_WARN_PCT) return "text-amber-700 dark:text-amber-400";
  return "text-zinc-800 dark:text-zinc-100";
}

/** Thin horizontal fill bar for one session's context window. */
export function ContextBar({
  agent,
  pct,
  className,
}: {
  agent: LiveAgent;
  pct: number | null;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]",
        className,
      )}
    >
      {pct != null && (
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", barClass(agent, pct))}
          style={{ width: `${Math.max(Math.min(pct, 100), 1.5)}%` }}
        />
      )}
    </div>
  );
}

/** "41%" or "—" when the session hasn't completed a turn yet. */
export function formatContextPct(ctx: LiveContext): string {
  return ctx.usedPercent != null ? `${Math.round(ctx.usedPercent)}%` : "—";
}

/** "412K / 1M" when token counts are known, else null (Cursor). */
export function formatContextTokens(ctx: LiveContext): string | null {
  if (ctx.usedTokens == null || ctx.windowTokens == null) return null;
  return `${formatCount(ctx.usedTokens)} / ${formatCount(ctx.windowTokens)}`;
}

/** Best human label for a session: its name, else its folder, else the agent. */
export function contextTitle(ctx: LiveContext): string {
  if (ctx.name) return ctx.name;
  const folder = ctx.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return folder || ctx.agent;
}

/** Folder basename for a session's cwd, or null. */
export function contextFolder(ctx: LiveContext): string | null {
  return ctx.cwd?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null;
}

/** `claude-opus-5-5-20260901` → `opus-5-5`. Other vendors pass through. */
export function shortModel(model: string | null): string | null {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
