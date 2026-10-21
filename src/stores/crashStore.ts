import { create } from "zustand";

interface CrashState {
  error: Error | null;
  setError: (e: Error) => void;
  clear: () => void;
}

/// Holds the most recent uncaught async error (window.onerror / unhandledrejection).
/// Synchronous render errors are caught by `ErrorBoundary` and not stored here —
/// they're handled inside the boundary's own state.
export const useCrashStore = create<CrashState>((set) => ({
  error: null,
  setError: (error) => set({ error }),
  clear: () => set({ error: null }),
}));
