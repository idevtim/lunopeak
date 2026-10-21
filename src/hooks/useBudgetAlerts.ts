import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { queries } from "@/lib/queries";
import { toast, type ToastTone } from "@/stores/toastStore";
import { formatUsd } from "@/lib/format";

const STORAGE_PREFIX = "lunopeak:budget-alerted";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Tries to deliver as a native macOS notification, falling back to an in-app
 * toast when permission is denied, the plugin isn't available, or we're
 * running in browser-only dev mode.
 */
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
    // Plugin missing / OS rejected the call — drop back to the toast.
    toast[opts.tone](opts.title, opts.body);
  }
}

interface BudgetState {
  daily: { spent: number; limit: number; pct: number };
  monthly: { spent: number; limit: number; pct: number };
}

/** ISO-style date string anchored on local-time today. */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** First-day-of-month key for monthly dedup. */
function monthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Sum of `byDay` entries falling within the user's current local calendar
 * month. The array is a rolling window where the last entry is today, so we
 * take the trailing `dayOfMonth` entries (today + each prior day this month).
 */
function monthToDateSpend(days: number[]): number {
  if (days.length === 0) return 0;
  const dayOfMonth = new Date().getDate();
  return days.slice(Math.max(0, days.length - dayOfMonth)).reduce((a, b) => a + b, 0);
}

function alreadyAlerted(scope: "daily" | "monthly", key: string): boolean {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}:${scope}:${key}`) === "1";
  } catch {
    return false;
  }
}

function markAlerted(scope: "daily" | "monthly", key: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}:${scope}:${key}`, "1");
  } catch {
    // No-op if storage isn't available.
  }
}

/** Computes daily/monthly spend vs configured limits. Returns null when nothing is configured. */
export function useBudgetState(): BudgetState | null {
  const costs = useQuery(queries.costs);
  const settings = useQuery(queries.settings);
  const cfg = settings.data?.costBudget;
  const days = costs.data?.byDay ?? [];
  if (!cfg || (cfg.dailyUsd <= 0 && cfg.monthlyUsd <= 0)) return null;

  const dailySpent = days.length > 0 ? (days[days.length - 1] ?? 0) : 0;
  const monthlySpent = monthToDateSpend(days);
  return {
    daily: {
      spent: dailySpent,
      limit: cfg.dailyUsd,
      pct: cfg.dailyUsd > 0 ? (dailySpent / cfg.dailyUsd) * 100 : 0,
    },
    monthly: {
      spent: monthlySpent,
      limit: cfg.monthlyUsd,
      pct: cfg.monthlyUsd > 0 ? (monthlySpent / cfg.monthlyUsd) * 100 : 0,
    },
  };
}

/**
 * App-level hook: fires a one-shot toast when daily or monthly spend crosses
 * the alert threshold. Deduped per-day / per-month via localStorage so the
 * user sees the alert once, not on every refetch.
 */
export function useBudgetAlerts() {
  const costs = useQuery(queries.costs);
  const settings = useQuery(queries.settings);

  useEffect(() => {
    const cfg = settings.data?.costBudget;
    const days = costs.data?.byDay ?? [];
    if (!cfg) return;
    const threshold = cfg.alertThresholdPct;
    if (threshold <= 0 || threshold > 100) return;

    if (cfg.dailyUsd > 0 && days.length > 0) {
      const dailySpent = days[days.length - 1] ?? 0;
      const pct = (dailySpent / cfg.dailyUsd) * 100;
      const key = todayKey();
      if (pct >= threshold && !alreadyAlerted("daily", key)) {
        markAlerted("daily", key);
        void notify({
          tone: "warning",
          title: "Daily budget alert",
          body: `You've used ${formatUsd(dailySpent)} of your ${formatUsd(cfg.dailyUsd)} daily limit (${Math.round(pct)}%).`,
        });
      }
    }

    if (cfg.monthlyUsd > 0) {
      const monthlySpent = monthToDateSpend(days);
      const pct = (monthlySpent / cfg.monthlyUsd) * 100;
      const key = monthKey();
      if (pct >= threshold && !alreadyAlerted("monthly", key)) {
        markAlerted("monthly", key);
        void notify({
          tone: "warning",
          title: "Monthly budget alert",
          body: `You've used ${formatUsd(monthlySpent)} of your ${formatUsd(cfg.monthlyUsd)} monthly limit (${Math.round(pct)}%).`,
        });
      }
    }
  }, [costs.data, settings.data]);
}
