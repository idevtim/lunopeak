import { cn } from "@/lib/utils";

interface SparkbarsProps {
  values: number[];
  /** Number of bars to render. Missing values render as muted placeholders. */
  bars?: number;
  className?: string;
  barClassName?: string;
}

export function Sparkbars({
  values,
  bars = 30,
  className,
  barClassName,
}: SparkbarsProps) {
  const padded =
    values.length >= bars
      ? values.slice(-bars)
      : [...Array(bars - values.length).fill(0), ...values];
  const max = Math.max(1, ...padded);

  return (
    <div className={cn("flex h-3 items-end gap-px", className)}>
      {padded.map((v, i) => {
        const pct = max > 0 ? Math.max(0.18, v / max) : 0.18;
        return (
          <div
            key={i}
            className={cn(
              "w-[3px] origin-bottom rounded-sm bg-blue-400/70 animate-chart-bar-grow",
              v === 0 && "bg-blue-400/20",
              barClassName,
            )}
            style={{
              height: `${Math.round(pct * 100)}%`,
              animationDelay: `${i * 8}ms`,
            }}
          />
        );
      })}
    </div>
  );
}
