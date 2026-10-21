import { create } from "zustand";

interface EditorPickerState {
  pendingPath: string | null;
  open: (path: string) => void;
  close: () => void;
}

/**
 * Single-slot picker. The first "Open" click without a configured default
 * sets `pendingPath`; the global EditorPicker dialog watches this slot,
 * lets the user pick an editor, and clears the slot when done.
 */
export const useEditorPickerStore = create<EditorPickerState>((set) => ({
  pendingPath: null,
  open: (path) => set({ pendingPath: path }),
  close: () => set({ pendingPath: null }),
}));
