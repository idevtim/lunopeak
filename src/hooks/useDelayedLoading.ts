import { useEffect, useRef, useState } from "react";

/**
 * Returns true while we should show a loading skeleton.
 *
 * - First load (no data yet): the skeleton paints immediately so users
 *   never see a frame of empty defaults before the skeleton appears.
 * - Subsequent refetches (data already on screen): defers the skeleton by
 *   `delay` ms so a fast refresh doesn't flash a skeleton over real data.
 */
export function useDelayedLoading(loading: boolean, delay = 200) {
  const [show, setShow] = useState(loading);
  const hasResolvedOnce = useRef(!loading);

  useEffect(() => {
    if (!loading) {
      hasResolvedOnce.current = true;
      setShow(false);
      return;
    }
    if (!hasResolvedOnce.current) {
      // First load — no data to bridge with, paint skeleton now.
      setShow(true);
      return;
    }
    // Refetch — there's already data on screen; only show the skeleton if
    // the refetch is genuinely slow.
    const t = setTimeout(() => setShow(true), delay);
    return () => clearTimeout(t);
  }, [loading, delay]);

  return show;
}
