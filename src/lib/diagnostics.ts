import { save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { useLogStore } from "@/stores/logStore";
import { toast } from "@/stores/toastStore";
import type { LogEntry } from "@/types/api";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Build a redacted diagnostics payload (settings + version + UA), then
 * either save it via the Tauri save dialog or trigger a browser download.
 *
 * Used by the About popup, the Settings → About card, and the application
 * menu's Help → Export Diagnostics Log… item — all three feed through
 * here so the file format stays consistent.
 *
 * Toasts on both success and failure; the caller doesn't need to handle
 * the result.
 */
export async function exportDiagnostics(version: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `lunopeak-diagnostics-${stamp}.json`;
  try {
    const settings = await api.getSettings();
    // Under Tauri the on-disk log is the source of truth (and already
    // secret-scrubbed by the backend); in browser mode there's no file, so fall
    // back to the in-memory ring buffer.
    const logs: LogEntry[] = isTauri()
      ? await api.readDiagnosticsLog(500)
      : useLogStore.getState().entries;
    const payload = {
      app: "LunoPeak",
      version,
      exportedAt: new Date().toISOString(),
      platform:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      settings: {
        ...settings,
        apiKeys: { anthropic: "***", openai: "***", gemini: "***", xai: "***" },
      },
      logCounts: {
        error: logs.filter((l) => l.level === "error").length,
        warn: logs.filter((l) => l.level === "warn").length,
        info: logs.filter((l) => l.level === "info").length,
      },
      logs,
    };
    const json = JSON.stringify(payload, null, 2);

    if (!isTauri()) {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Diagnostics exported", defaultName);
      return;
    }

    const path = await save({
      title: "Export diagnostics log",
      defaultPath: defaultName,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    await api.writeDiagnosticsLog(path, json);
    toast.success("Diagnostics exported", path);
  } catch (e) {
    toast.error(
      "Couldn't export diagnostics",
      e instanceof Error ? e.message : String(e),
    );
  }
}

/**
 * Read the running app's version. Returns "dev" outside Tauri and "?" if
 * the lookup fails — never throws.
 */
export async function getAppVersion(): Promise<string> {
  if (!isTauri()) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "?";
  }
}
