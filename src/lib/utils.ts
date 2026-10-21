import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Open a URL in the default browser (Tauri shell), or a new tab in browser mode. */
export function openExternal(url: string) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noreferrer");
  }
}
