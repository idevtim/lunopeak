import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Pill-track segmented control: 7 days / 30 days / All time, etc. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  ariaLabel,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-center rounded-[9px] bg-black/[0.05] p-[3px] dark:bg-white/[0.07]",
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "whitespace-nowrap rounded-[7px] px-2.5 py-1 text-[12.5px] font-medium transition-colors",
              active
                ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)] dark:bg-white/[0.14] dark:text-zinc-50"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
