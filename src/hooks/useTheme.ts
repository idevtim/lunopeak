import { useEffect } from "react";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia(QUERY).matches ? "dark" : "light";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? systemTheme() : pref;
}

/**
 * Applies the resolved theme to <html data-theme="…"> and re-applies it
 * whenever the OS color scheme changes (only relevant when pref is "system").
 *
 * To keep the swap feeling instant, we briefly tag <html> with
 * `data-theme-switching` so the global CSS rule can suppress
 * `transition-colors` animations for the frame in which the swap happens.
 * Otherwise every elevated surface, border, and label would interpolate
 * over its 150ms color transition and the flip would read as a fade.
 */
export function useTheme(pref: ThemePref) {
  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(pref);
      const root = document.documentElement;
      if (root.dataset.theme === next) return;
      root.dataset.themeSwitching = "true";
      root.dataset.theme = next;
      // Two RAFs: the first lets the browser commit the new colors with
      // transitions disabled; the second restores normal transition
      // behaviour once the new colors are painted.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          delete root.dataset.themeSwitching;
        });
      });
    };
    apply();
    if (pref !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia(QUERY);
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);
}
