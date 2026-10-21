import { useEffect } from "react";
import { Check, Info, X } from "lucide-react";
import { useToastStore, type Toast, type ToastTone } from "@/stores/toastStore";
import { useOnline } from "@/hooks/useOnline";
import { cn } from "@/lib/utils";

const toneStyles: Record<ToastTone, { tile: string; icon: React.ReactNode }> = {
  success: {
    tile: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    icon: <Check size={11} strokeWidth={3} />,
  },
  error: {
    tile: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
    icon: <span className="text-[12px] font-bold leading-none">!</span>,
  },
  warning: {
    tile: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    icon: <span className="text-[12px] font-bold leading-none">!</span>,
  },
  info: {
    tile: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
    icon: <Info size={11} strokeWidth={3} />,
  },
};

/** Top-right stack, newest on top. Drops below the offline bar when it shows. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const online = useOnline();
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed right-5 z-[70] flex w-[340px] flex-col gap-2 transition-[top] duration-200"
      style={{ top: online ? 48 : 92 }}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const styles = toneStyles[toast.tone];

  useEffect(() => {
    const id = window.setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div
      role="status"
      className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-white py-[11px] pl-3 pr-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.16),0_0_0_0.5px_rgba(0,0,0,0.15)] animate-lp-pop-in dark:bg-zinc-800 dark:shadow-[0_10px_30px_rgba(0,0,0,0.5),0_0_0_0.5px_rgba(255,255,255,0.12)]"
    >
      <span
        className={cn(
          "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
          styles.tile,
        )}
      >
        {styles.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
          {toast.title}
        </span>
        {toast.description && (
          <span className="break-words text-[12.5px] leading-snug text-zinc-600 text-pretty dark:text-zinc-400">
            {toast.description}
          </span>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.onClick();
            dismiss(toast.id);
          }}
          className="whitespace-nowrap rounded-md px-1.5 py-0.5 text-[12.5px] font-semibold text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
        aria-label="Dismiss notification"
      >
        <X size={11} strokeWidth={2.5} />
      </button>
    </div>
  );
}
