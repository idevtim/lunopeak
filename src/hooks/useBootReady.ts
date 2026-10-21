import { useEffect, useState } from "react";
import { SPLASH_MIN_MS } from "@/lib/boot";

/**
 * Returns true once the splash should dismiss. Purely time-based — the splash
 * is a visual moment, not a load gate. Views handle their own skeletons.
 */
export function useBootReady(displayMs = SPLASH_MIN_MS) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), displayMs);
    return () => clearTimeout(t);
  }, [displayMs]);

  return ready;
}
