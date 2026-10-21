import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/tokens";
import { LiveDot } from "./LiveDot";
import { Skeleton } from "./Skeleton";

interface StatCardProps {
  label: string;
  value: ReactNode;
  /** Only used for the live dot's color. */
  tone?: Tone;
  /** One line of context under the value ("A typical day is about $9"). */
  hint?: ReactNode;
  className?: string;
  to?: string;
  /** Prefix the label with an animated dot. */
  live?: boolean;
}

/** Label, big number, one line of context. */
export function StatCard({ label, value, tone = "emerald", hint, className, to, live }: StatCardProps) {
  const Wrapper = to ? "a" : "div";
  const wrapperProps = to ? { href: to } : {};
  return (
    <Wrapper
      {...wrapperProps}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-[14px] border border-black/[0.07] bg-white px-4 py-3.5 text-inherit no-underline dark:border-white/[0.08] dark:bg-white/[0.035]",
        to && "transition-colors hover:border-black/[0.14] dark:hover:border-white/[0.16]",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] text-zinc-600 dark:text-zinc-400">
        {live && <LiveDot tone={tone === "zinc" ? "zinc" : tone} size="sm" />}
        {label}
      </span>
      <span className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-zinc-900 tabular-nums dark:text-zinc-50">
        {value}
      </span>
      {hint && <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </Wrapper>
  );
}

export function StatCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-[14px] border border-black/[0.07] bg-white px-4 py-3.5 dark:border-white/[0.08] dark:bg-white/[0.035]",
        className,
      )}
    >
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-20" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}
