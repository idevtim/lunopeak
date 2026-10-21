import { useState } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Page";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";

export type AttentionTone = "amber" | "rose" | "blue" | "neutral";

export interface AttentionItem {
  id: string;
  urgent: boolean;
  tone: AttentionTone;
  Icon: LucideIcon;
  title: string;
  detail: string;
  action: { label: string; onClick: () => void; pending?: boolean };
}

const TILE: Record<AttentionTone, string> = {
  amber: "bg-amber-500/[0.14] text-amber-600 dark:text-amber-400",
  rose: "bg-rose-500/[0.12] text-rose-600 dark:text-rose-400",
  blue: "bg-blue-500/[0.12] text-blue-600 dark:text-blue-400",
  neutral: "bg-black/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300",
};

/**
 * "Needs your attention": folded to one summary line by default, expanding
 * to one row per problem — a sentence and a single button.
 */
export function AttentionCard({ items }: { items: AttentionItem[] }) {
  const [open, setOpen] = useState(false);
  const urgent = items.filter((i) => i.urgent).length;
  const canWait = items.length - urgent;

  if (items.length === 0) {
    return (
      <Card className="flex items-center gap-2.5 px-[18px] py-3">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Needs your attention</span>
        <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">Nothing right now.</span>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-[14px] px-[18px] py-3 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
      >
        <span className="whitespace-nowrap text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Needs your attention
        </span>
        <span
          className={cn(
            "rounded-full px-2 py-px text-xs font-semibold tabular-nums",
            urgent > 0
              ? "bg-amber-500/15 text-amber-800 dark:text-amber-300"
              : "bg-black/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300",
          )}
        >
          {items.length}
        </span>
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3.5 overflow-hidden transition-opacity duration-150",
            open && "opacity-0",
          )}
        >
          {urgent > 0 && <SummaryDot className="bg-rose-600">{urgent} urgent</SummaryDot>}
          {canWait > 0 && <SummaryDot className="bg-zinc-400">{canWait} can wait</SummaryDot>}
        </span>
        <span className="whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
          {open ? "Hide" : "Show all"}
        </span>
        <ChevronRight
          size={14}
          strokeWidth={2.25}
          className={cn("shrink-0 text-zinc-500 transition-transform duration-150", open && "rotate-90")}
        />
      </button>
      {open &&
        items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-3.5 border-t border-black/[0.05] px-[18px] py-3 last:pb-3.5 dark:border-white/[0.06]"
          >
            <span className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-lg", TILE[item.tone])}>
              <item.Icon size={16} strokeWidth={2} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>
              <span className="truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">{item.detail}</span>
            </div>
            <Button disabled={item.action.pending} onClick={item.action.onClick}>
              {item.action.label}
            </Button>
          </div>
        ))}
    </Card>
  );
}

function SummaryDot({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-zinc-600 dark:text-zinc-400">
      <span className={cn("size-1.5 rounded-full", className)} />
      {children}
    </span>
  );
}
