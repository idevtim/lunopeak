import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneDot, tokens, type Tone } from "@/lib/tokens";

interface ListRowProps extends HTMLAttributes<HTMLDivElement> {
  primary: ReactNode;
  secondary?: ReactNode;
  meta?: ReactNode;
  tone?: Tone;
  /** Render the meta column with tabular-nums + a min-width so values right-align cleanly. */
  metaTabular?: boolean;
}

export function ListRow({
  primary,
  secondary,
  meta,
  tone = "zinc",
  className,
  metaTabular = true,
  ...props
}: ListRowProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2 transition-colors",
        "hover:bg-black/[0.03] dark:hover:bg-white/[0.03]",
        className,
      )}
      {...props}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", toneDot[tone])} />
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", tokens.text.primary)}>{primary}</div>
        {secondary && (
          <div className={cn("truncate text-xs", tokens.text.quaternary)}>
            {secondary}
          </div>
        )}
      </div>
      {meta && (
        <div
          className={cn(
            "shrink-0 text-right text-xs",
            tokens.text.quaternary,
            metaTabular && "min-w-[3.5rem] tabular-nums",
          )}
        >
          {meta}
        </div>
      )}
    </div>
  );
}
