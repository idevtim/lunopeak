import { create } from "zustand";

export interface AvailableUpdate {
  version: string;
  body?: string | null;
  /** ISO-ish publish date from the updater manifest, when present. */
  date?: string | null;
  install: () => Promise<void>;
}

export type UpdatePhase = "available" | "installing" | "ready";

interface UpdateState {
  update: AvailableUpdate | null;
  phase: UpdatePhase;
  error: string | null;
  dismissed: boolean;
  /** The What's new dialog. Opens from the update bar, the palette or Settings. */
  whatsNewOpen: boolean;
  /** Epoch ms of the last check that reached the update server. */
  checkedAt: number | null;
  /** Record a found update so the always-mounted <UpdateBar /> surfaces it. */
  setAvailable: (update: AvailableUpdate) => void;
  setPhase: (phase: UpdatePhase) => void;
  setError: (error: string | null) => void;
  dismiss: () => void;
  setWhatsNewOpen: (open: boolean) => void;
  setCheckedAt: (at: number) => void;
}

/// Shared across the main window so a check triggered anywhere (boot auto-check,
/// Settings → "Check for updates", the palette) drives the single global UpdateBar.
///
/// Why this exists: the banner used to run its own one-shot check on boot.
/// Closing the main window only *hides* it (the React tree stays mounted), so a
/// later manual check never re-rendered the banner — the user had to fully quit
/// and relaunch before the banner appeared. Routing every check through this
/// store means the bar reacts immediately, no relaunch required.
///
/// Note: the About window is a separate webview with its own JS context and thus
/// its own store instance — it carries its own inline update UI instead.
export const useUpdateStore = create<UpdateState>((set) => ({
  update: null,
  phase: "available",
  error: null,
  dismissed: false,
  whatsNewOpen: false,
  checkedAt: null,
  // Re-show on a freshly found update even if a prior one was dismissed.
  setAvailable: (update) =>
    set({ update, phase: "available", error: null, dismissed: false }),
  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error }),
  dismiss: () => set({ dismissed: true }),
  setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen }),
  setCheckedAt: (checkedAt) => set({ checkedAt }),
}));
