import { useState, type ReactNode } from "react";
import { AlertCircle, type LucideIcon } from "lucide-react";
import { Button } from "./Button";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toastStore";

interface StateAction {
  label: string;
  onClick: () => void;
}

/**
 * Dashed "nothing here yet" card: icon tile, title, one sentence of help and
 * a primary action. Pass `healthy` on health pages for the green
 * "All tidy" variant instead.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  primary,
  secondary,
  healthy,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body: ReactNode;
  primary?: StateAction;
  secondary?: StateAction;
  healthy?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3.5 rounded-2xl border border-dashed px-8 py-14 text-center",
        healthy
          ? "border-emerald-500/30 bg-emerald-50/60 dark:border-emerald-400/25 dark:bg-emerald-500/[0.05]"
          : "border-black/15 bg-white/70 dark:border-white/15 dark:bg-white/[0.02]",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-[52px] items-center justify-center rounded-[14px]",
          healthy
            ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
            : "bg-black/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300",
        )}
      >
        <Icon size={24} strokeWidth={1.75} />
      </span>
      <div className="flex max-w-[440px] flex-col gap-1.5">
        <span className="text-[17px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
          {title}
        </span>
        <span className="text-[13.5px] leading-relaxed text-zinc-600 text-pretty dark:text-zinc-400">
          {body}
        </span>
      </div>
      {(primary || secondary) && (
        <div className="flex gap-2 pt-1">
          {primary && (
            <Button variant="primary" size="md" onClick={primary.onClick}>
              {primary.label}
            </Button>
          )}
          {secondary && (
            <Button size="md" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Rose-bordered error card: plain title and cause, one specific action (or
 * Try again), and a Show details toggle with the raw error.
 */
export function ErrorState({
  title,
  body,
  action,
  onRetry,
  error,
  className,
}: {
  title: string;
  body: ReactNode;
  /** A specific fix ("Update key", "Open System Settings"). Falls back to Try again. */
  action?: StateAction;
  onRetry?: () => void;
  /** Raw error — shown under Show details. */
  error?: unknown;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const detail = error == null ? null : error instanceof Error ? error.message : String(error);
  const primary = action ?? (onRetry ? { label: "Try again", onClick: onRetry } : null);
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-4 rounded-2xl border border-rose-500/25 bg-white px-6 py-[22px] dark:bg-white/[0.035]",
        className,
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-rose-500/10 text-rose-600 dark:text-rose-400">
        <AlertCircle size={20} strokeWidth={2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</span>
        <span className="text-[13.5px] leading-relaxed text-zinc-700 text-pretty dark:text-zinc-300">
          {body}
        </span>
        {(primary || detail) && (
          <div className="flex gap-2 pt-1">
            {primary && (
              <Button variant="primary" size="md" onClick={primary.onClick}>
                {primary.label}
              </Button>
            )}
            {detail && (
              <Button size="md" onClick={() => setOpen((o) => !o)}>
                {open ? "Hide details" : "Show details"}
              </Button>
            )}
          </div>
        )}
        {open && detail && (
          <div className="flex flex-col gap-2 rounded-[10px] bg-black/[0.035] px-3 py-2.5 dark:bg-white/[0.05]">
            <span className="whitespace-pre-wrap break-words font-mono text-xs text-zinc-700 dark:text-zinc-300">
              {detail}
            </span>
            <button
              type="button"
              className="self-start text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(detail)
                  .then(() => toast.success("Copied error details"));
              }}
            >
              Copy details
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Wraps a page's skeleton layout: pulses it (opacity 1 → .45) and adds a
 * caption naming what this page is loading. Children should be plain gray blocks
 * shaped like the real content (see `Bone`).
 */
export function PageLoading({
  children,
  caption,
}: {
  children: ReactNode;
  /** What this page is loading, in plain words ("Reading your session history…"). */
  caption: string;
}) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
      <div className="flex flex-col gap-3 animate-lp-pulse">{children}</div>
      <span className="text-center text-xs text-zinc-500 dark:text-zinc-400">{caption}</span>
    </div>
  );
}

/** One flat gray block inside a `PageLoading` skeleton. */
export function Bone({ className }: { className?: string }) {
  return (
    <div className={cn("rounded-[14px] bg-black/[0.05] dark:bg-white/[0.06]", className)} />
  );
}
