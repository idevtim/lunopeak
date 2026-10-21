import { ChevronLeft } from "lucide-react";
import { useHashRoute } from "@/hooks/useHashRoute";
import { allRoutes, type RouteId } from "@/routes";
import { cn } from "@/lib/utils";

/**
 * Back control that returns to the panel the user actually came from.
 *
 * The destination and label both follow the in-app history (see
 * `useHashRoute().back` / `prevRoute`). `fallback` is only used when there's no
 * history to go back to — a deep link or a fresh launch straight into a detail
 * view — so the control always does something sensible.
 */
export function BackLink({
  fallback,
  fallbackLabel,
  prefix = false,
  size = 14,
  className,
}: {
  /** Route to return to when there's no in-app history to pop. */
  fallback: RouteId;
  /** Label used when the resolved route isn't in the sidebar registry. */
  fallbackLabel?: string;
  /** Render "Back to X" instead of just "X" (used in empty/error states). */
  prefix?: boolean;
  size?: number;
  className?: string;
}) {
  const { back, prevRoute } = useHashRoute();
  const target = prevRoute() ?? fallback;
  const label =
    allRoutes.find((r) => r.id === target)?.label ?? fallbackLabel ?? "Back";
  return (
    <button
      type="button"
      onClick={() => back(fallback)}
      className={cn(
        "inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400 transition-colors hover:text-zinc-900 dark:hover:text-zinc-100",
        className,
      )}
    >
      <ChevronLeft size={size} strokeWidth={1.75} />
      {prefix ? `Back to ${label}` : label}
    </button>
  );
}
