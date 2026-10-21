import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-black/[0.05] dark:bg-white/[0.04]",
        "before:absolute before:inset-0 before:-translate-x-full",
        "before:animate-shimmer",
        "before:bg-gradient-to-r before:from-transparent before:via-black/[0.05] before:to-transparent dark:before:via-white/[0.06]",
        className,
      )}
      {...props}
    />
  );
}
