import { create } from "zustand";
import type { LogEntry } from "@/types/api";

/** Newest entries are kept; older ones fall off the end. */
const CAP = 300;

interface LogState {
  entries: LogEntry[];
  /** Append one entry, evicting the oldest once over {@link CAP}. */
  push: (entry: LogEntry) => void;
}

/// In-memory mirror of the runtime log. Under Tauri the file on disk is the
/// source of truth (the diagnostics export reads it back); this buffer is the
/// browser-mode fallback and keeps a session view without a disk round-trip.
export const useLogStore = create<LogState>((set) => ({
  entries: [],
  push: (entry) =>
    set((s) => ({
      entries:
        s.entries.length >= CAP
          ? [...s.entries.slice(s.entries.length - CAP + 1), entry]
          : [...s.entries, entry],
    })),
}));
