import { cn } from "@/lib/utils";

interface HeatmapProps {
  /** Values in chronological order (oldest → newest). */
  values: number[];
  /** Max for normalization across multiple rows. Defaults to local max. */
  max?: number;
  /** Tailwind size for each cell. */
  cellSize?: "xs" | "sm" | "md";
  className?: string;
}

const sizeMap = {
  xs: "size-2",
  sm: "size-2.5",
  md: "size-3",
} as const;

const gapMap = {
  xs: "gap-0.5",
  sm: "gap-0.5",
  md: "gap-1",
} as const;

export function Heatmap({
  values,
  max,
  cellSize = "sm",
  className,
}: HeatmapProps) {
  const upper = Math.max(1, max ?? Math.max(...values, 1));
  return (
    <div className={cn("flex", gapMap[cellSize], className)}>
      {values.map((v, i) => {
        const intensity = v === 0 ? 0 : 0.15 + (v / upper) * 0.85;
        return (
          <div
            key={i}
            className={cn(sizeMap[cellSize], "rounded-sm animate-heat-cell")}
            style={{
              backgroundColor:
                v === 0
                  ? "rgb(255 255 255 / 0.03)"
                  : `rgb(59 130 246 / ${intensity.toFixed(2)})`,
              animationDelay: `${Math.min(i * 4, 600)}ms`,
            }}
            title={`${v}`}
          />
        );
      })}
    </div>
  );
}
