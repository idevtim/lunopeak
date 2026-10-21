import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { toast, type ToastTone } from "@/stores/toastStore";
import type { ProviderUsage, UsageProvider, UsageWindow } from "@/types/api";

const STORAGE_PREFIX = "lunopeak:usage-alerted";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function notify(opts: {
  title: string;
  body: string;
  tone: ToastTone;
}): Promise<void> {
  if (!isTauri()) {
    toast[opts.tone](opts.title, opts.body);
    return;
  }
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    let granted = await mod.isPermissionGranted();
    if (!granted) {
      const result = await mod.requestPermission();
      granted = result === "granted";
    }
    if (!granted) {
      toast[opts.tone](opts.title, opts.body);
      return;
    }
    await mod.sendNotification({ title: opts.title, body: opts.body });
  } catch {
    toast[opts.tone](opts.title, opts.body);
  }
}

function alreadyAlerted(key: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}:${key}`) === "1";
  } catch {
    return false;
  }
}

function markAlerted(key: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}:${key}`, "1");
  } catch {
    // No-op if storage isn't available.
  }
}

function providerLabel(p: UsageProvider): string {
  if (p === "claude") return "Claude Code";
  if (p === "codex") return "Codex";
  if (p === "cursor") return "Cursor";
  return p;
}

/**
 * Dedup key — pinned to the window's reset time so each new billing cycle
 * gets a fresh alert. Falls back to a day-bucket when the provider doesn't
 * give us a `resetsAt` (Claude OAuth: weekly resets are reported, 5-hour
 * windows often aren't).
 */
function dedupKey(
  provider: UsageProvider,
  window: string,
  w: UsageWindow,
): string {
  const cycle = w.resetsAt != null ? `r${w.resetsAt}` : `d${dayBucket()}`;
  return `${provider}:${window}:${cycle}`;
}

function dayBucket(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function checkWindow(
  provider: UsageProvider,
  windowKey: string,
  w: UsageWindow,
  threshold: number,
  scope: string,
): void {
  const pct = w.usedPercent;
  if (pct == null || pct < threshold) return;
  const key = dedupKey(provider, windowKey, w);
  if (alreadyAlerted(key)) return;
  markAlerted(key);

  const label = providerLabel(provider);
  void notify({
    tone: pct >= 90 ? "error" : "warning",
    title: `${label} usage alert`,
    body: `${label} ${scope} usage is at ${Math.round(pct)}%.`,
  });
}

/**
 * App-level hook: fires a one-shot notification when any provider's 5-hour
 * or weekly usage window crosses the configured threshold. Deduped per
 * window's reset cycle so the user sees the alert once per billing window,
 * not on every refetch.
 */
export function useUsageAlerts() {
  const usage = useQuery(queries.usageLimits);
  const settings = useQuery(queries.settings);

  useEffect(() => {
    const cfg = settings.data?.usageAlerts;
    const providers = usage.data?.providers ?? [];
    if (!cfg || !cfg.enabled) return;
    const threshold = cfg.thresholdPct;
    if (threshold <= 0 || threshold > 100) return;

    for (const p of providers as ProviderUsage[]) {
      checkWindow(p.provider, "fiveHour", p.fiveHour, threshold, "5-hour");
      checkWindow(p.provider, "weekly", p.weekly, threshold, "weekly");
      for (const l of p.modelLimits ?? []) {
        checkWindow(p.provider, `weekly:${l.model}`, l.window, threshold, `${l.model} weekly`);
      }
    }
  }, [usage.data, settings.data]);
}
