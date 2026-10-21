import { useEffect, useState } from "react";

const hasNavigator = () => typeof navigator !== "undefined";

export function isOnline(): boolean {
  if (!hasNavigator()) return true;
  return navigator.onLine !== false;
}

/**
 * Tracks the browser's online/offline state. Used to gate network-dependent
 * queries (`usageLimits`, `providerStatus`) and cloud assistant sends so we
 * don't bang on `api.anthropic.com` / status pages / chat endpoints while the
 * machine has no connectivity.
 *
 * `navigator.onLine` is best-effort — false is a strong signal (no network
 * interface up), true can mean "captive portal" or "VPN connected but DNS
 * broken". We treat true as the optimistic default and let requests fail
 * naturally in that edge case.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => {
    if (!hasNavigator()) return;
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
