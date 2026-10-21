import { useEffect, useRef } from "react";
import { Info, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useConfirmStore } from "@/stores/confirmStore";
import { cn } from "@/lib/utils";

/** Global confirmation dialog driven by `confirm()` from confirmStore. */
export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const settle = useConfirmStore((s) => s.settle);
  const okRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    // Destructive requests default to Cancel so a stray Enter can't confirm.
    (request.destructive ? cancelRef : okRef).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, settle]);

  if (!request) return null;
  const Icon = request.destructive ? Trash2 : Info;

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-zinc-900/25 animate-lp-fade-in"
      onClick={() => settle(false)}
    >
      <div
        role="alertdialog"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
        className="flex w-[420px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_30px_80px_rgba(0,0,0,0.3),0_0_0_0.5px_rgba(0,0,0,0.2)] animate-lp-pop-in dark:bg-zinc-900 dark:shadow-[0_30px_80px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(255,255,255,0.12)]"
      >
        <div className="flex gap-3.5 px-[22px] pb-[18px] pt-[22px]">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-[10px]",
              request.destructive
                ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                : "bg-blue-500/10 text-blue-600 dark:text-blue-400",
            )}
          >
            <Icon size={18} strokeWidth={2} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-[15.5px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
              {request.title}
            </span>
            <span className="text-[13px] leading-relaxed text-zinc-600 text-pretty dark:text-zinc-400">
              {request.body}
            </span>
            {request.items && request.items.length > 0 && (
              <div className="mt-0.5 flex max-h-40 flex-col gap-[3px] overflow-y-auto rounded-[9px] bg-black/[0.035] px-2.5 py-2 dark:bg-white/[0.05]">
                {request.items.map((item) => (
                  <span key={item} className="truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    {item}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-black/[0.06] bg-zinc-50 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <Button ref={cancelRef} size="md" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            ref={okRef}
            size="md"
            variant={request.destructive ? "destructive" : "primary"}
            onClick={() => settle(true)}
          >
            {request.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
