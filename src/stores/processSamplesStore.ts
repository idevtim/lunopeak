import { create } from "zustand";
import type { ActiveProcess } from "@/types/api";

const MAX_SAMPLES = 30;
const STALE_AFTER_MS = 30 * 60 * 1000;
const GENERATING_DELTA_KB = 1024;

interface PidState {
  samples: number[];
  lastChangeTs: number;
  firstSeenTs: number;
}

interface SamplesState {
  byPid: Record<number, PidState>;
  ingest: (procs: ActiveProcess[]) => void;
}

export const useProcessSamplesStore = create<SamplesState>((set) => ({
  byPid: {},
  ingest: (procs) => {
    set((s) => {
      const now = Date.now();
      const next: Record<number, PidState> = {};
      const livePids = new Set(procs.map((p) => p.pid));
      for (const pid of Object.keys(s.byPid).map(Number)) {
        if (livePids.has(pid)) next[pid] = s.byPid[pid];
      }
      for (const p of procs) {
        const prev = next[p.pid];
        if (!prev) {
          next[p.pid] = {
            samples: [p.memoryKb],
            lastChangeTs: now,
            firstSeenTs: now,
          };
          continue;
        }
        const last = prev.samples[prev.samples.length - 1] ?? p.memoryKb;
        const samples = [...prev.samples, p.memoryKb].slice(-MAX_SAMPLES);
        const changed = Math.abs(p.memoryKb - last) >= GENERATING_DELTA_KB;
        next[p.pid] = {
          samples,
          lastChangeTs: changed ? now : prev.lastChangeTs,
          firstSeenTs: prev.firstSeenTs,
        };
      }
      return { byPid: next };
    });
  },
}));

export function isStale(state: PidState | undefined): boolean {
  if (!state) return false;
  return Date.now() - state.lastChangeTs >= STALE_AFTER_MS;
}

export function isGenerating(state: PidState | undefined): boolean {
  if (!state || state.samples.length < 2) return false;
  const last = state.samples[state.samples.length - 1];
  const prev = state.samples[state.samples.length - 2];
  return Math.abs(last - prev) >= GENERATING_DELTA_KB;
}

export type { PidState };
