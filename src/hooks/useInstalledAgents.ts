import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import type { InstalledAgents } from "@/types/api";

/**
 * Filesystem probe for which agents (Claude Code / Codex / Cursor) the user
 * actually has installed. Use this to genericize copy that would otherwise
 * hardcode "Claude" and to soft-disable Claude-only features (Memory, Lint)
 * for users running only Codex or Cursor.
 *
 * Returns `undefined` while loading. Treat undefined as "assume all" so
 * callers don't flash a Codex-only empty state before the probe lands.
 */
export function useInstalledAgents(): InstalledAgents | undefined {
  return useQuery(queries.installedAgents).data;
}

/**
 * Human-readable list of the agents the user has installed, e.g.
 * "Claude Code and Codex" or "Codex, Cursor, and Claude Code". Returns
 * an empty string when none are detected — callers should fall back to a
 * generic copy line in that case.
 */
export function describeInstalledAgents(agents: InstalledAgents | undefined): string {
  if (!agents) return "";
  const names: string[] = [];
  if (agents.claudeCode) names.push("Claude Code");
  if (agents.codex) names.push("Codex");
  if (agents.cursor) names.push("Cursor");
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Which agent the "Open in agent" affordance should target on this machine.
 * Priority: Claude → Codex → Cursor (the order the app's data layer can
 * actually act on). Returns null when none are installed.
 */
export function primaryInstalledAgent(
  agents: InstalledAgents | undefined,
): "claude" | "codex" | "cursor" | null {
  if (!agents) return "claude";
  if (agents.claudeCode) return "claude";
  if (agents.codex) return "codex";
  if (agents.cursor) return "cursor";
  return null;
}
