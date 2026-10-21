import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyPlatformAttribute } from "./hooks/usePlatform";
import { resolveTheme } from "./hooks/useTheme";
import { prefetchOnBoot } from "./lib/queries";
import { useFixtures } from "./lib/tauri";
import { demoConversations, demoCurrentConversationId } from "./lib/demoFixtures";
import { useAssistantStore } from "./stores/assistantStore";
import { breadcrumb, logEvent } from "./lib/logger";
import "./index.css";

applyPlatformAttribute();

// Mirror console.error/warn into the diagnostics log. The originals still run,
// so the dev console is unchanged; logEvent never calls console, so this can't
// recurse. Installed once at module load.
{
  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    logEvent({ level: "error", scope: "console", msg: fmt(args) });
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    logEvent({ level: "warn", scope: "console", msg: fmt(args) });
    origWarn(...args);
  };
}

// Breadcrumb hash-route navigation so the log shows where the user was when an
// error fired. Routes are hash-based (see src/routes.ts).
window.addEventListener("hashchange", () => {
  breadcrumb("nav", window.location.hash || "#");
});

// Apply the system theme synchronously before first paint. Once settings
// load, useTheme overrides this with the user's saved preference.
document.documentElement.dataset.theme = resolveTheme("system");

window.addEventListener("contextmenu", (event) => event.preventDefault());

if (import.meta.env.PROD) {
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key === "f12") {
      event.preventDefault();
      return;
    }
    const inspectChord =
      (event.metaKey && event.altKey && (key === "i" || key === "j" || key === "c")) ||
      (event.ctrlKey && event.shiftKey && (key === "i" || key === "j" || key === "c"));
    if (inspectChord) {
      event.preventDefault();
    }
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 min default — views can override
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

// Kick off prefetch immediately so the Rust scanners run while the splash
// animates. By the time the splash fades, hot queries are already cached
// and the dashboard paints with data instead of skeletons.
void prefetchOnBoot(queryClient);

// Demo mode: seed assistant history so the page has chats to screenshot.
// `seedDemo` is a no-op once any conversation exists, so a user's real
// history (persisted to localStorage) is never clobbered.
if (useFixtures()) {
  useAssistantStore
    .getState()
    .seedDemo(demoConversations, demoCurrentConversationId);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
