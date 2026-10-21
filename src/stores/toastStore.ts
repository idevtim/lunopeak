import { create } from "zustand";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastAction {
  /** Short text action — "Undo", "Details", "Open", "Watch". */
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: ToastAction;
  durationMs: number;
}

/** Older toasts beyond this drop off the bottom of the stack. */
const MAX_TOASTS = 3;

interface ToastState {
  toasts: Toast[];
  push: (
    t: Omit<Toast, "id" | "durationMs"> & { durationMs?: number },
  ) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: ({ tone, title, description, action, durationMs = 5000 }) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Newest first; the Toaster renders top-down.
    set((s) => ({
      toasts: [{ id, tone, title, description, action, durationMs }, ...s.toasts].slice(
        0,
        MAX_TOASTS,
      ),
    }));
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

type ToastOptions = { action?: ToastAction; durationMs?: number };

const pushTone =
  (tone: ToastTone) => (title: string, description?: string, opts?: ToastOptions) =>
    useToastStore.getState().push({ tone, title, description, ...opts });

export const toast = {
  info: pushTone("info"),
  success: pushTone("success"),
  warning: pushTone("warning"),
  error: pushTone("error"),
};
