import { useEffect, useState } from "react";

export type Platform = "macos" | "windows" | "linux";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function detectFromUserAgent(): Platform {
  if (typeof navigator === "undefined") return "macos";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

let cached: Platform | null = null;

async function detect(): Promise<Platform> {
  if (cached) return cached;
  if (isTauri()) {
    try {
      const { platform } = await import("@tauri-apps/plugin-os");
      const p = await platform();
      cached = p === "macos" || p === "windows" ? p : "linux";
      return cached;
    } catch {
      // fall through
    }
  }
  cached = detectFromUserAgent();
  return cached;
}

export function usePlatform(): Platform {
  const [platform, setPlatform] = useState<Platform>(
    cached ?? detectFromUserAgent(),
  );
  useEffect(() => {
    let active = true;
    detect().then((p) => {
      if (active) setPlatform(p);
    });
    return () => {
      active = false;
    };
  }, []);
  return platform;
}

/**
 * Sets `data-platform` on <html> as soon as we know it. Run once at startup.
 */
export async function applyPlatformAttribute() {
  const p = await detect();
  if (typeof document !== "undefined") {
    document.documentElement.dataset.platform = p;
  }
}

export function fileManagerName(platform: Platform): string {
  if (platform === "macos") return "Finder";
  if (platform === "windows") return "Explorer";
  return "Files";
}

/** Title-case label for the OS surface that hosts a status icon. */
export function trayName(platform: Platform): string {
  return platform === "macos" ? "Menu Bar" : "System Tray";
}

/** Lowercase form for use mid-sentence ("show in the {…}"). */
export function trayNoun(platform: Platform): string {
  return platform === "macos" ? "menu bar" : "system tray";
}
