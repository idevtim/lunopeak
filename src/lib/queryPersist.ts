import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { queries } from "./queries";

/**
 * Carries a few of Home's queries across launches so the dashboard paints the
 * last-known numbers instantly instead of skeletons, then refreshes in place.
 *
 * Deliberately narrow:
 * - Only cheap-to-store, slow-to-compute queries are kept. Live data (running
 *   agents, ports, contexts) and plan limits are never restored — a stale
 *   "3 agents working" or a stale limit percentage would read as current.
 * - Restored entries are marked stale (`dataUpdatedAt = 0`), so every one is
 *   refetched on mount no matter its `staleTime`.
 * - A snapshot from an earlier calendar day is dropped: "Spent today" and the
 *   activity bars are day-relative, and yesterday's numbers would be wrong.
 */

const STORAGE_KEY = "lunopeak.query-snapshot.v1";
const MAX_BYTES = 1_500_000;
const WRITE_DEBOUNCE_MS = 1_000;

const PERSISTED_KEYS: readonly string[] = [
  queries.dashboardSummary.queryKey[0],
  queries.repos.queryKey[0],
  queries.costs.queryKey[0],
  queries.settings.queryKey[0],
  queries.username.queryKey[0],
];

const isPersisted = (key: readonly unknown[]) => PERSISTED_KEYS.includes(String(key[0]));

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

type Snapshot = { day: string; state: ReturnType<typeof dehydrate> };

let restored = false;

/** True when this launch restored saved numbers, so Home can paint them at once. */
export const restoredFromSnapshot = () => restored;

/** Seed the cache from the last snapshot. Synchronous — call before render. */
export function restoreQuerySnapshot(qc: QueryClient) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const snap = JSON.parse(raw) as Snapshot;
    if (snap.day !== localDay() || !Array.isArray(snap.state?.queries)) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const kept = snap.state.queries.filter((q) => isPersisted(q.queryKey));
    for (const q of kept) q.state.dataUpdatedAt = 0;
    hydrate(qc, { mutations: [], queries: kept });
    restored = kept.length > 0;
  } catch {
    // Unreadable or blocked storage — start cold, exactly as before.
  }
}

/** Write a fresh snapshot (debounced) whenever a persisted query succeeds. */
export function persistQuerySnapshot(qc: QueryClient) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    timer = undefined;
    try {
      const state = dehydrate(qc, {
        shouldDehydrateQuery: (q) => q.state.status === "success" && isPersisted(q.queryKey),
      });
      const json = JSON.stringify({ day: localDay(), state } satisfies Snapshot);
      if (json.length > MAX_BYTES) return;
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // Quota or blocked storage — the snapshot is a nicety, not state.
    }
  };
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (!isPersisted(event.query.queryKey)) return;
    if (timer === undefined) timer = setTimeout(write, WRITE_DEBOUNCE_MS);
  });
}
