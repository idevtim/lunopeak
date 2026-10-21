import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  /** Plain explanation of what will happen. */
  body: string;
  /** Affected items, shown as a mono list (branch names, paths). */
  items?: string[];
  /** Specific verb: "Delete 6 branches", "Restore snapshot". */
  confirmLabel: string;
  /** Rose trash icon + rose confirm button. */
  destructive?: boolean;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  resolve: ((ok: boolean) => void) | null;
  open: (req: ConfirmRequest) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  resolve: null,
  open: (request) =>
    new Promise<boolean>((resolve) => {
      // A second confirm replaces the first; the first resolves as cancelled.
      get().resolve?.(false);
      set({ request, resolve });
    }),
  settle: (ok) => {
    get().resolve?.(ok);
    set({ request: null, resolve: null });
  },
}));

/** `if (await confirm({...})) doIt()` — renders the global ConfirmDialog. */
export const confirm = (req: ConfirmRequest) => useConfirmStore.getState().open(req);
