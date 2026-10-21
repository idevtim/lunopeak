import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { describeInstalledAgents } from "@/hooks/useInstalledAgents";

const STORAGE_KEY = "lunopeak:notifications:onboarded";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function alreadyOnboarded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Called by first-run setup, which owns the prompt on fresh installs. */
export function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // No-op when storage isn't available.
  }
}

async function welcomeBody(): Promise<string> {
  // Probed at first-launch time so the welcome banner reflects what's
  // actually on the user's machine — "We found Codex on this machine" is a
  // better hello than the generic line for a Codex-only user. Any failure
  // (probe error, no agents detected) falls back to the generic copy so
  // the channel is still proven end-to-end.
  try {
    const installed = await api.getInstalledAgents();
    const detected = describeInstalledAgents(installed);
    if (detected) {
      return `We found ${detected} on this machine. We'll ping you when budgets, updates, or alerts need your attention.`;
    }
  } catch {
    // fall through to generic copy
  }
  return "Notifications are on. We'll ping you here when budgets, updates, or alerts need your attention.";
}

/**
 * Ask the OS for notification permission. Resolves true when granted, false
 * when denied or when the plugin isn't available (browser mode, old OS).
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    if (await mod.isPermissionGranted()) return true;
    return (await mod.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * On the very first launch, ask the OS for notification permission. If the
 * user grants it, deliver a welcome notification so they immediately see the
 * native banner and can confirm the channel works end-to-end. Result is
 * persisted in localStorage so we only ever prompt once — macOS itself only
 * surfaces the system prompt the first time, but we still don't want to
 * re-send the welcome on subsequent launches.
 *
 * Fresh installs ask from first-run setup's Alerts step instead, so this
 * waits for `setupComplete` (setup marks onboarding done when it finishes).
 */
export function useNotificationOnboarding(): void {
  const setupComplete = useQuery(queries.settings).data?.setupComplete;
  useEffect(() => {
    if (!isTauri()) return;
    if (setupComplete !== true) return;
    if (alreadyOnboarded()) return;

    void (async () => {
      try {
        const mod = await import("@tauri-apps/plugin-notification");
        let granted = await mod.isPermissionGranted();
        if (!granted) {
          const result = await mod.requestPermission();
          granted = result === "granted";
        }
        markOnboarded();
        if (granted) {
          await mod.sendNotification({
            title: "Welcome to LunoPeak",
            body: await welcomeBody(),
          });
        }
      } catch {
        // Plugin missing or OS rejected the call — still mark onboarded so we
        // don't retry on every launch.
        markOnboarded();
      }
    })();
  }, [setupComplete]);
}
