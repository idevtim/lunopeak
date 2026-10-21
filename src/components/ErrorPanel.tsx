import { AlertTriangle, Copy, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface ErrorPanelProps {
  error: Error;
  componentStack?: string | null;
  /** Reload the whole window. Always available. */
  onReload: () => void;
  /** Dismiss without reloading — only meaningful when the app is still alive
   *  (i.e. async errors caught by global listeners). For render-time errors
   *  this still works to retry the boundary, but rendering may fail again. */
  onDismiss: () => void;
  /** Heading text — slightly different copy for fatal vs. non-fatal cases. */
  title?: string;
  description?: string;
  dismissLabel?: string;
}

export function ErrorPanel({
  error,
  componentStack,
  onReload,
  onDismiss,
  title = "Something went wrong",
  description = "LunoPeak hit an unexpected error. Your data is safe — try reloading the window.",
  dismissLabel = "Try again",
}: ErrorPanelProps) {
  const handleCopy = async () => {
    const text = [
      `LunoPeak crash report`,
      `Time: ${new Date().toISOString()}`,
      `Message: ${error.message}`,
      `Stack:\n${error.stack ?? "(no stack)"}`,
      componentStack ? `Component stack:${componentStack}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard may be unavailable in some webviews
    }
  };

  return (
    <div className="w-full max-w-xl space-y-5 rounded-2xl border border-black/[0.06] bg-white/95 p-6 shadow-xl backdrop-blur-md dark:border-white/[0.06] dark:bg-zinc-900/95">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-rose-500/10 p-2 text-rose-600 ring-1 ring-rose-500/30 dark:text-rose-400">
          <AlertTriangle size={20} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
        </div>
      </div>

      <div className="rounded-lg border border-black/[0.06] bg-black/[0.03] p-3 dark:border-white/[0.06] dark:bg-black/30">
        <div className="font-mono text-xs text-rose-700 dark:text-rose-300">
          {error.name}: {error.message}
        </div>
        {(error.stack || componentStack) && (
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            {error.stack ?? componentStack}
          </pre>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={onReload}>
          <RotateCcw className="size-3.5" />
          Reload
        </Button>
        <Button size="sm" onClick={onDismiss}>
          {dismissLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void handleCopy()}>
          <Copy className="size-3.5" />
          Copy details
        </Button>
      </div>
    </div>
  );
}
