import { create } from "zustand";

interface PaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/** Command palette visibility — opened from ⌘K, the menu, or the sidebar's "Go to…". */
export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
