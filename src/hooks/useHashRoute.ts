import { useEffect, useState, useCallback } from "react";
import { allRoutes, defaultRouteId, type RouteId } from "@/routes";

const isRouteId = (v: string): v is RouteId =>
  allRoutes.some((r) => r.id === v);

interface ParsedHash {
  route: RouteId;
  params: URLSearchParams;
}

function routeOf(hash: string): RouteId {
  const raw = hash.replace(/^#\/?/, "");
  const qIdx = raw.indexOf("?");
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  return isRouteId(path) ? path : defaultRouteId;
}

function parseHash(): ParsedHash {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const qIdx = raw.indexOf("?");
  const queryStr = qIdx === -1 ? "" : raw.slice(qIdx + 1);
  return {
    route: routeOf(window.location.hash),
    params: new URLSearchParams(queryStr),
  };
}

const emptyParsed: ParsedHash = {
  route: defaultRouteId,
  params: new URLSearchParams(),
};

// ── In-app navigation history ─────────────────────────────────────────────
// useHashRoute is mounted by many components, so the history stack lives at
// module scope as a single shared source of truth (cheaper than a store and it
// never needs to drive re-renders — `back()` reads it imperatively). Each entry
// is a full hash including its query string, so going back restores params
// (e.g. a filtered list). A single module-level `hashchange` listener keeps the
// stack current for ALL navigations — including `<a href="#/…">` clicks that
// bypass navigate()/navigateTo().
const historyStack: string[] = [];

function currentHash(): string {
  return window.location.hash || `#/${defaultRouteId}`;
}

function installHistoryTracker() {
  if (typeof window === "undefined") return;
  historyStack.push(currentHash());
  window.addEventListener("hashchange", () => {
    const hash = currentHash();
    // Dedup consecutive duplicates. `back()` pops before changing the hash, so
    // the resulting hashchange already matches the new top and won't re-push.
    if (historyStack[historyStack.length - 1] !== hash) {
      historyStack.push(hash);
    }
  });
}
installHistoryTracker();

export function useHashRoute() {
  const [parsed, setParsed] = useState<ParsedHash>(() =>
    typeof window === "undefined" ? emptyParsed : parseHash(),
  );

  useEffect(() => {
    const handler = () => setParsed(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = useCallback((id: RouteId) => {
    window.location.hash = `/${id}`;
  }, []);

  const navigateTo = useCallback(
    (id: RouteId, params?: Record<string, string>) => {
      const query = params ? new URLSearchParams(params).toString() : "";
      window.location.hash = query ? `/${id}?${query}` : `/${id}`;
    },
    [],
  );

  // Return to the panel the user came from. Pops the current entry and restores
  // the previous one (with its params). Falls back to `fallback` when there's no
  // in-app history to return to — e.g. a deep link / fresh launch straight into
  // a detail view — so back controls always do something sensible.
  const back = useCallback(
    (fallback?: RouteId) => {
      if (historyStack.length > 1) {
        historyStack.pop();
        window.location.hash = historyStack[historyStack.length - 1];
      } else if (fallback) {
        window.location.hash = `/${fallback}`;
      }
    },
    [],
  );

  // The route id of the panel `back()` would return to, or null if there's no
  // in-app history. Lets back controls label themselves with the real previous
  // panel (e.g. "Diffs") instead of a hardcoded guess. Reads the live history
  // stack on each call; callers re-render on hashchange via `parsed`, so the
  // value stays fresh.
  const prevRoute = useCallback(
    (): RouteId | null =>
      historyStack.length > 1
        ? routeOf(historyStack[historyStack.length - 2])
        : null,
    [],
  );

  return {
    route: parsed.route,
    params: parsed.params,
    navigate,
    navigateTo,
    back,
    prevRoute,
  };
}
