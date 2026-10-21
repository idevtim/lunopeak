import { cn } from "@/lib/utils";

type Tone = "emerald" | "blue" | "amber" | "rose" | "zinc";

const fillByTone: Record<Tone, string> = {
  emerald: "bg-emerald-500",
  blue: "bg-blue-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  zinc: "bg-zinc-400 dark:bg-zinc-500",
};

const ringByTone: Record<Tone, string> = {
  emerald: "bg-emerald-500/70",
  blue: "bg-blue-500/70",
  amber: "bg-amber-500/70",
  rose: "bg-rose-500/70",
  zinc: "bg-zinc-400/60 dark:bg-zinc-500/60",
};

type Size = "xs" | "sm" | "md";
const sizeMap: Record<Size, string> = {
  xs: "size-1",
  sm: "size-1.5",
  md: "size-2",
};

interface LiveDotProps {
  tone?: Tone;
  size?: Size;
  /** Render the expanding outer ring. Default true. */
  ring?: boolean;
  /** Animate the inner core's opacity. Default true. */
  pulse?: boolean;
  className?: string;
}

/**
 * Animated status dot — expanding ring + soft inner pulse. Use anywhere a
 * stat reflects something *currently happening* (live process, generating
 * session, dirty repo). Defaults to emerald (positive/live) — pass `tone`
 * for amber/rose/etc. when the signal is warning or error.
 */
export function LiveDot({
  tone = "emerald",
  size = "sm",
  ring = true,
  pulse = true,
  className,
}: LiveDotProps) {
  const sizeCls = sizeMap[size];
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        sizeCls,
        className,
      )}
      aria-hidden
    >
      {ring && (
        <span
          className={cn(
            "absolute inset-0 inline-flex rounded-full animate-ping-slow",
            ringByTone[tone],
          )}
        />
      )}
      <span
        className={cn(
          "relative inline-flex rounded-full",
          sizeCls,
          fillByTone[tone],
          pulse && "animate-pulse-soft",
        )}
      />
    </span>
  );
}
