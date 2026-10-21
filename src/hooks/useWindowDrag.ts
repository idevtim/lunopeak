import { useEffect, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [data-no-drag]';

/**
 * Make the referenced element a window-drag handle. Single-click → drag,
 * double-click → toggle maximize. Children matching INTERACTIVE_SELECTOR
 * (or marked `data-no-drag`) are skipped.
 *
 * Why not Tauri's `data-tauri-drag-region` attribute? On macOS with custom
 * title bars + vibrancy, the data-attribute path is unreliable (the runtime
 * listener checks event.target rather than walking the ancestor chain in
 * some versions). Calling `startDragging()` ourselves is bulletproof.
 */
export function useWindowDrag(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !isTauri()) return;

    const w = getCurrentWindow();

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(INTERACTIVE_SELECTOR)) return;
      if (e.detail === 2) {
        void w.toggleMaximize();
        return;
      }
      void w.startDragging();
    };

    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [ref]);
}
