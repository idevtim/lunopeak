import { api } from "@/lib/tauri";
import { useLogStore } from "@/stores/logStore";
import type { LogEntry, Severity } from "@/types/api";

interface LogInput {
  level: Severity;
  scope: string;
  msg: string;
  detail?: string;
}

/**
 * Record one runtime log entry: push it onto the in-memory ring buffer and,
 * under Tauri, forward it to disk via IPC so it survives restart and lands in
 * the diagnostics export. Best-effort — a failed IPC call is swallowed so
 * logging can never throw into a caller (and never recurses into itself).
 */
export function logEvent({ level, scope, msg, detail }: LogInput): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    source: "frontend",
    scope,
    msg,
    detail,
  };
  useLogStore.getState().push(entry);
  // Fire-and-forget; never await, never surface failures.
  void api.appendLog(level, scope, msg, detail).catch(() => {});
}

export const logError = (scope: string, msg: string, detail?: string) =>
  logEvent({ level: "error", scope, msg, detail });

export const logWarn = (scope: string, msg: string, detail?: string) =>
  logEvent({ level: "warn", scope, msg, detail });

/** A low-severity event marking app activity (navigation, IPC failures, etc.). */
export const breadcrumb = (scope: string, msg: string, detail?: string) =>
  logEvent({ level: "info", scope, msg, detail });
