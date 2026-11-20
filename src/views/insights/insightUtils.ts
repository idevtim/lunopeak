import type { InsightAuthor, InsightBucketUnit, InsightPr, PrInsights, RepoInsight, RepoInsights } from "@/types/api";

export const PERIODS = [
  { value: "1", label: "24 hours", noun: "24h" },
  { value: "7", label: "7 days", noun: "week" },
  { value: "30", label: "30 days", noun: "30d" },
  { value: "90", label: "90 days", noun: "90d" },
] as const;
export type PeriodValue = (typeof PERIODS)[number]["value"];

export function parsePeriod(raw: string | null): PeriodValue {
  return PERIODS.some((p) => p.value === raw) ? (raw as PeriodValue) : "7";
}

export function periodNoun(days: number) {
  return PERIODS.find((p) => Number(p.value) === days)?.noun ?? `${days} days`;
}

/** Stack colors for the busiest repos; everything past them shares the last. */
export const REPO_COLORS = [
  "bg-blue-500",
  "bg-amber-500",
  "bg-teal-500",
  "bg-violet-400",
  "bg-rose-400",
];
export const OTHER_COLOR = "bg-zinc-300 dark:bg-zinc-600";

export function bucketLabel(ms: number, unit: InsightBucketUnit, count: number) {
  const d = new Date(ms);
  if (unit === "hour") return d.toLocaleTimeString(undefined, { hour: "numeric" });
  if (unit === "week") return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return count <= 7
    ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function rangeLabel(data: RepoInsights) {
  const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return data.bucketUnit === "hour" ? "Last 24 hours" : `${fmt(data.sinceMs)} – ${fmt(data.untilMs)}`;
}

/** Element-wise sum of equal-length series. */
export function sumSeries(series: number[][], length: number) {
  const out = new Array<number>(length).fill(0);
  for (const s of series) s.forEach((v, i) => (out[i] += v));
  return out;
}

export function totals(repos: RepoInsight[]) {
  return repos.reduce(
    (t, r) => ({
      commits: t.commits + r.commits,
      prevCommits: t.prevCommits + r.prevCommits,
      allBranchCommits: t.allBranchCommits + r.allBranchCommits,
      additions: t.additions + r.additions,
      deletions: t.deletions + r.deletions,
      filesChanged: t.filesChanged + r.filesChanged,
      agentCommits: t.agentCommits + r.agentCommits,
      sessions: t.sessions + r.sessions,
      agentCostUsd: t.agentCostUsd + r.agentCostUsd,
    }),
    { commits: 0, prevCommits: 0, allBranchCommits: 0, additions: 0, deletions: 0, filesChanged: 0, agentCommits: 0, sessions: 0, agentCostUsd: 0 },
  );
}

/** Authors merged across repos by email (case-insensitive). */
export function mergeAuthors(repos: RepoInsight[]): (InsightAuthor & { repos: number })[] {
  const by = new Map<string, InsightAuthor & { repos: number }>();
  for (const r of repos) {
    for (const a of r.authors) {
      const key = (a.email || a.name).toLowerCase();
      const cur = by.get(key);
      if (cur) {
        cur.commits += a.commits;
        cur.additions += a.additions;
        cur.deletions += a.deletions;
        cur.repos += 1;
      } else by.set(key, { ...a, repos: 1 });
    }
  }
  return [...by.values()].sort((a, b) => b.commits - a.commits);
}

/** Percent change vs the previous period, or null when there's no baseline. */
export function deltaPct(now: number, prev: number) {
  if (prev === 0) return null;
  return Math.round(((now - prev) / prev) * 100);
}

export function median(xs: number[]) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** "42m", "2h 10m", "3d 4h". */
export function formatSpan(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 ? `${hr}h ${min % 60}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  return hr % 24 ? `${day}d ${hr % 24}h` : `${day}d`;
}

export type MergedPr = InsightPr & { repoName: string; repoPath: string };

export function allMerged(prs: PrInsights | undefined, repoPath?: string): MergedPr[] {
  if (!prs) return [];
  return prs.repos
    .filter((r) => !repoPath || r.path === repoPath)
    .flatMap((r) => r.merged.map((p) => ({ ...p, repoName: r.name, repoPath: r.path })))
    .sort((a, b) => b.mergedAtMs - a.mergedAtMs);
}

/** Index of the bucket a timestamp falls in, or -1 before the first. */
export function bucketIndex(starts: number[], ms: number) {
  let i = -1;
  while (i + 1 < starts.length && starts[i + 1] <= ms) i++;
  return i;
}

/**
 * Merged-PR count and median time-to-merge per bucket. Bucketed here,
 * against the git query's `buckets`, so the two charts can't disagree when
 * the cached PR data is older than the latest git refresh.
 */
export function prSeries(merged: InsightPr[], starts: number[]) {
  const count = new Array<number>(starts.length).fill(0);
  const spans: number[][] = Array.from({ length: starts.length }, () => []);
  for (const p of merged) {
    const b = bucketIndex(starts, p.mergedAtMs);
    if (b < 0) continue;
    count[b] += 1;
    spans[b].push(p.mergedAtMs - p.createdAtMs);
  }
  return { count, median: spans.map((s) => median(s)) };
}

export const nf = new Intl.NumberFormat();

const compact1 = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const compact0 = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 });

/**
 * Exact below 10,000, compact above ("12.4k", "646k", "1.2m") so tile
 * numbers fit a narrow card. Pair with a `title` carrying `nf.format(n)`.
 */
export function big(n: number) {
  const a = Math.abs(n);
  if (a < 10_000) return nf.format(n);
  return (a < 100_000 ? compact1 : compact0).format(n).toLowerCase();
}

/** "▲ 42% vs last 30d" — the short trend hint for a stat tile. */
export function trendHint(pct: number, days: number) {
  return `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct)}% vs last ${periodNoun(days)}`;
}
