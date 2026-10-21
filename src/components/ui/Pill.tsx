import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type PillTone = "green" | "amber" | "rose" | "blue" | "violet" | "neutral";

export const pillTones: Record<PillTone, string> = {
  green: "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  rose: "bg-rose-500/10 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
  blue: "bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  violet: "bg-violet-500/10 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  neutral: "bg-black/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300",
};

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
}

/** Sentence-case status pill. `justify-self-start` keeps it compact in grids. */
export function Pill({ tone = "neutral", className, ...props }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 justify-self-start whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums",
        pillTones[tone],
        className,
      )}
      {...props}
    />
  );
}
