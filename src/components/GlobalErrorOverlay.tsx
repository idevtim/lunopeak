import { useEffect } from "react";
import { useCrashStore } from "@/stores/crashStore";
import { logError } from "@/lib/logger";
import { ErrorPanel } from "./ErrorPanel";

/// Promotes window-level uncaught errors and unhandled promise rejections
/// (i.e. anything React's error boundary can't catch) into the same crash UI.
/// Mounted at the App root so it can blanket the whole window.
export function GlobalErrorOverlay() {
  const error = useCrashStore((s) => s.error);
  const setError = useCrashStore((s) => s.setError);
  const clear = useCrashStore((s) => s.clear);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const err =
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Unknown error");
      logError("window", err.message, err.stack);
      setError(err);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const err =
        reason instanceof Error
          ? reason
          : new Error(
              typeof reason === "string" ? reason : safeStringify(reason),
            );
      logError("unhandledrejection", err.message, err.stack);
      setError(err);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [setError]);

  if (!error) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-100/70 p-6 backdrop-blur-sm dark:bg-zinc-950/80">
      <ErrorPanel
        error={error}
        onReload={() => window.location.reload()}
        onDismiss={clear}
        title="An unexpected error occurred"
        description="The app caught an error in the background. Dismiss to keep working, or reload if things look wrong."
        dismissLabel="Dismiss"
      />
    </div>
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "Unknown rejection";
  } catch {
    return String(v);
  }
}
