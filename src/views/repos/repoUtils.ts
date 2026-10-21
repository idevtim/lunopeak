import type { ActiveProcess, RepoOverviewEntry, Session } from "@/types/api";

const DAY_MS = 24 * 60 * 60 * 1000;
export const COST_WINDOW_DAYS = 30;

/** True when `child` is `parent` or sits somewhere under it. */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** The repo containing `path`, preferring the deepest match (nested repos). */
export function repoForPath<T extends { path: string }>(
  repos: readonly T[],
  path: string | null | undefined,
): T | undefined {
  if (!path) return undefined;
  let best: T | undefined;
  for (const r of repos) {
    if (isUnder(path, r.path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return best;
}

/** Agent spend per repo path over the last 30 days, from Claude session logs. */
export function costByRepo(
  repos: readonly RepoOverviewEntry[],
  sessions: readonly Session[] | undefined,
  now = Date.now(),
): Map<string, number> {
  const out = new Map<string, number>();
  const since = now - COST_WINDOW_DAYS * DAY_MS;
  for (const s of sessions ?? []) {
    if (s.endTs < since) continue;
    const repo = repoForPath(repos, s.projectPath);
    if (repo) out.set(repo.path, (out.get(repo.path) ?? 0) + s.costUsd);
  }
  return out;
}

/** Repo paths with an agent process running inside them right now. */
export function reposWithAgents(
  repos: readonly RepoOverviewEntry[],
  processes: readonly ActiveProcess[] | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const p of processes ?? []) {
    const repo = repoForPath(repos, p.cwd);
    if (repo) out.add(repo.path);
  }
  return out;
}

/** Home directory shortened to ~ — "/Users/tim/code" → "~/code". */
export function tildePath(path: string): string {
  const home = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Z]:\\Users\\[^\\]+)/)?.[0];
  return home ? `~${path.slice(home.length)}` : path;
}

/** Compact "when": "Just now", "6 min ago", "3 hr ago", "Yesterday", "12 days ago", "3 weeks ago". */
export function shortAgo(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ts) / 60000));
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((today.getTime() - ts) / DAY_MS);
  if (ts >= today.getTime()) return `${hr} hr ago`;
  if (days <= 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? "A year ago" : `${years} years ago`;
}

/** Whole days since `ts`. */
export function daysSince(ts: number, now = Date.now()): number {
  return Math.floor((now - ts) / DAY_MS);
}

/** "Today", "Yesterday", or "Mon, Oct 12" (with the year when it isn't this one). */
export function dayLabel(ts: number, now = Date.now()): string {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day.getTime()) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: day.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** "5 ahead of main", "3 behind main", "12 ahead, 3 behind main"; null when level. */
export function aheadBehind(b: { ahead: number; behind: number }, base: string): string | null {
  if (b.ahead > 0 && b.behind > 0) return `${b.ahead} ahead, ${b.behind} behind ${base}`;
  if (b.ahead > 0) return `${b.ahead} ahead of ${base}`;
  if (b.behind > 0) return `${b.behind} behind ${base}`;
  return null;
}
