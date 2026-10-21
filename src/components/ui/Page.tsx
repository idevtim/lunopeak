import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The shared page frame: 1100px centered column with the standard header
 * spacing. Every routed view renders inside one of these.
 */
export function Page({
  className,
  wide,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  /** Drop the max-width for full-bleed two-pane views. */
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-5 px-8 pb-8 pt-11",
        !wide && "max-w-[1100px]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Page title plus the one-sentence lead that answers the page's question.
 * Wrap the important numbers in `<b>` — they render darker and semibold.
 */
export function PageHeader({
  title,
  lead,
  actions,
  above,
  className,
}: {
  title: ReactNode;
  lead?: ReactNode;
  /** Controls on the right (segmented range, Customize, etc). */
  actions?: ReactNode;
  /** Rendered above the title — usually a `<BackLink />`. */
  above?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-1", className)}>
      {above && <div className="mb-2 text-[13px]">{above}</div>}
      <div className="flex items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="m-0 text-2xl font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">
            {title}
          </h1>
          {lead && <Lead>{lead}</Lead>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "m-0 text-[13.5px] leading-relaxed text-zinc-600 text-pretty dark:text-zinc-400",
        "[&_b]:font-semibold [&_b]:text-zinc-900 dark:[&_b]:text-zinc-100",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** White card with the hairline border used across the redesign. */
export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[14px] border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-white/[0.035]",
        className,
      )}
      {...props}
    />
  );
}

/** Card header row: 14px title, optional meta and action on the right. */
export function CardHeader({
  title,
  meta,
  action,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 px-[18px] pb-2.5 pt-3.5", className)}>
      <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {title}
      </h3>
      {meta && <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{meta}</span>}
      {action}
    </div>
  );
}

/** Divided row inside a card. */
export function CardRow({
  className,
  interactive,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-black/[0.05] px-[18px] py-2.5 dark:border-white/[0.06]",
        interactive && "cursor-pointer transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]",
        className,
      )}
      {...props}
    />
  );
}

/** Mono text for paths, commands, tool names and other raw values. */
export function Mono({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-mono text-[12px]", className)} {...props} />;
}
