import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { UsageProvider } from "@/types/api";

/**
 * Wraps a section in a div that plays the `lp-tray-item-rise` keyframe with
 * a per-section delay. The panel's `<div key={cycle}>` remounts this on every
 * open so the animation replays from frame 0 without any imperative reset.
 */
export function StaggerItem({
  delay,
  className,
  children,
}: {
  delay: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("lp-tray-item", className)}
      style={{ ["--lp-tray-delay" as string]: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/** Sentence-case section label ("Plan limits", "Alerts"). */
export function GroupLabel({
  children,
  caption,
}: {
  children: React.ReactNode;
  caption?: string;
}) {
  return (
    <div className="flex flex-col gap-px px-0.5">
      <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">
        {children}
      </span>
      {caption && (
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{caption}</span>
      )}
    </div>
  );
}

/** The panel's card surface — provider cards and settings groups share it. */
export const cardSurface =
  "rounded-xl border border-black/[0.05] bg-white/60 dark:border-white/[0.06] dark:bg-white/[0.02]";

/** Re-render every `ms` so relative times ("Updated 2m ago") stay current. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

// ── Palette ──────────────────────────────────────────────────────────

export interface Accent {
  text: string;
  chip: string;
  bar: string;
}

export function providerAccent(p: UsageProvider): Accent {
  if (p === "claude")
    return {
      text: "text-amber-600 dark:text-amber-400",
      chip: "bg-amber-500/15 dark:bg-amber-500/20",
      bar: "bg-gradient-to-r from-amber-500 to-orange-500",
    };
  if (p === "codex")
    return {
      text: "text-emerald-600 dark:text-emerald-400",
      chip: "bg-emerald-500/15 dark:bg-emerald-500/20",
      bar: "bg-gradient-to-r from-emerald-500 to-teal-500",
    };
  return {
    text: "text-sky-600 dark:text-sky-400",
    chip: "bg-sky-500/15 dark:bg-sky-500/20",
    bar: "bg-gradient-to-r from-sky-500 to-blue-500",
  };
}

/**
 * Weekly bars share the provider's color family but desaturate so they read
 * as the second beat beside the session bar.
 */
export function providerAccentSecondary(p: UsageProvider): Accent {
  if (p === "claude")
    return {
      text: "text-orange-500/80",
      chip: "bg-orange-500/10",
      bar: "bg-gradient-to-r from-orange-400/80 to-orange-600/80",
    };
  if (p === "codex")
    return {
      text: "text-teal-500/80",
      chip: "bg-teal-500/10",
      bar: "bg-gradient-to-r from-teal-400/80 to-teal-600/80",
    };
  return {
    text: "text-blue-500/80",
    chip: "bg-blue-500/10",
    bar: "bg-gradient-to-r from-blue-400/80 to-blue-600/80",
  };
}

export function providerLabel(p: string): string {
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  if (p === "cursor") return "Cursor";
  return p;
}
