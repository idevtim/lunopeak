import { useState } from "react";
import { cn } from "@/lib/utils";

export interface BarDatum {
  label: string;
  value: number;
  /** Overrides the default `{label}: {value}` hover tooltip when set. */
  tooltip?: string;
  /** Per-bar fill override (e.g. days above budget pace). */
  className?: string;
  /** Renders an empty dotted slot instead of a bar (days still to come). */
  placeholder?: boolean;
}

interface BarChartProps {
  data: BarDatum[];
  /** Tailwind class for the bar fill, e.g. "bg-blue-500". */
  barClassName?: string;
  height?: number;
  className?: string;
  showLabels?: boolean;
  /** Tailwind gap class between bars. Tight default for that "Sonoma activity row" feel. */
  gapClassName?: string;
  /** Endpoint labels rendered below the chart when `showLabels` is false. */
  axisLabels?: { left?: string; right?: string };
  /** Dashed horizontal line at `value` (a budget pace), with an optional label. */
  referenceLine?: { value: number; label?: string };
}

export function BarChart({
  data,
  barClassName = "bg-blue-500",
  height = 96,
  className,
  showLabels = true,
  gapClassName = "gap-[3px]",
  axisLabels,
  referenceLine,
}: BarChartProps) {
  const max = Math.max(1, referenceLine?.value ?? 0, ...data.map((d) => d.value));
  const [hovered, setHovered] = useState<number | null>(null);

  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn("relative flex items-end", gapClassName)}
        style={{ height }}
        role="img"
        aria-label="Bar chart"
        onMouseLeave={() => setHovered(null)}
      >
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const tooltip =
            d.tooltip ?? (d.label ? `${d.label}: ${d.value}` : `${d.value}`);
          const isHovered = hovered === i;
          if (d.placeholder) {
            return (
              <div
                key={i}
                className="flex-1 self-stretch border-b-2 border-dotted border-black/[0.12] dark:border-white/[0.12]"
                aria-hidden
              />
            );
          }
          // Anchor the tooltip toward the left edge when near the right
          // border so it doesn't overflow the chart container.
          const nearRight = i > data.length - Math.max(3, data.length * 0.15);
          return (
            <div
              key={i}
              className="group relative flex flex-1 items-end"
              style={{ height: "100%" }}
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              tabIndex={0}
              aria-label={tooltip}
            >
              <div
                className={cn(
                  "w-full origin-bottom rounded-t-sm animate-chart-bar-grow transition-opacity",
                  isHovered ? "opacity-100" : "group-hover:opacity-80",
                  hovered !== null && !isHovered && "opacity-50",
                  d.className ?? barClassName,
                )}
                style={{
                  height: `${Math.max(2, pct)}%`,
                  animationDelay: `${Math.min(i * 12, 400)}ms`,
                }}
              />
              {isHovered && (
                <div
                  className={cn(
                    "pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap",
                    "rounded-md border border-black/[0.08] bg-white/95 px-2 py-1 text-[11px] text-zinc-800 shadow-md backdrop-blur",
                    "dark:border-white/[0.08] dark:bg-zinc-900/95 dark:text-zinc-100",
                    nearRight ? "right-0" : "left-1/2 -translate-x-1/2",
                  )}
                >
                  {tooltip}
                </div>
              )}
            </div>
          );
        })}
        {referenceLine && referenceLine.value > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 border-t-[1.5px] border-dashed border-rose-600/55 dark:border-rose-400/55"
            style={{ bottom: `${(referenceLine.value / max) * 100}%` }}
            aria-hidden
          >
            {referenceLine.label && (
              // Near the top of the chart the label would poke out above
              // the plot (into the card header), so hang it below the line.
              <span
                className={cn(
                  "absolute right-0 bg-white px-1 text-[11px] font-semibold text-rose-700 dark:bg-zinc-900 dark:text-rose-300",
                  referenceLine.value / max > 0.75 ? "top-1" : "bottom-1",
                )}
              >
                {referenceLine.label}
              </span>
            )}
          </div>
        )}
      </div>
      {showLabels && (
        <div className={cn("mt-2 flex text-[10px] text-zinc-500 dark:text-zinc-400", gapClassName)}>
          {data.map((d, i) => (
            <div key={i} className="flex-1 truncate text-center">
              {d.label}
            </div>
          ))}
        </div>
      )}
      {!showLabels && axisLabels && (axisLabels.left || axisLabels.right) && (
        <div className="mt-1.5 flex justify-between text-[10px] text-zinc-500 dark:text-zinc-400">
          <span>{axisLabels.left ?? ""}</span>
          <span>{axisLabels.right ?? ""}</span>
        </div>
      )}
    </div>
  );
}
