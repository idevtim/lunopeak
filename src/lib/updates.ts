import { api } from "@/lib/tauri";
import { toast } from "@/stores/toastStore";
import { useUpdateStore } from "@/stores/updateStore";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const RELEASES_URL = "https://github.com/idevtim/lunopeak/releases";

/**
 * Ask the updater for a newer release and hand it to the update store, which
 * shows the update bar. `quiet` skips the "You're up to date" / error toasts
 * (boot-time auto-check). Resolves to the new version, or null.
 */
export async function checkForUpdates({ quiet = false } = {}): Promise<string | null> {
  if (!isTauri()) {
    if (!quiet) toast.info("Updates aren't available in browser mode");
    return null;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const result = await check();
    useUpdateStore.getState().setCheckedAt(Date.now());
    if (!result) {
      if (!quiet) toast.success("You're up to date");
      return null;
    }
    useUpdateStore.getState().setAvailable({
      version: result.version,
      body: result.body,
      date: result.date ?? null,
      install: () => result.downloadAndInstall(),
    });
    return result.version;
  } catch (e) {
    if (!quiet) toast.error("Couldn't check for updates", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Install (if not already) and relaunch. Errors land on the store and a toast. */
export async function installAndRestart() {
  const { update, phase, setPhase, setError } = useUpdateStore.getState();
  if (!update) return;
  try {
    if (phase !== "ready") {
      setPhase("installing");
      await update.install();
      setPhase("ready");
    }
    await api.restartApp();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    setPhase("available");
    toast.error("Couldn't install the update", msg);
  }
}

export type ReleaseTag = "New" | "Better" | "Fixed";

export interface ReleaseItem {
  tag: ReleaseTag;
  title: string;
  body: string;
}

const FIX_RE = /\b(fix(ed|es)?|no longer|bug|crash|now (correctly|works)|regression)\b/i;

/**
 * Turn a GitHub release body (our release-notes/vX.Y.Z.md voice: `## Section`
 * headings over `- **Title.** Body` bullets) into tagged What's new items.
 * The first section's items are New; fix-sounding items are Fixed; the rest
 * are Better. Platform/"Works on" lists are skipped.
 */
export function parseReleaseNotes(body: string | null | undefined): ReleaseItem[] {
  if (!body) return [];
  const items: ReleaseItem[] = [];
  let section = -1;
  let skip = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      section += 1;
      skip = /works on|install|download/i.test(line);
      continue;
    }
    if (skip || !line.startsWith("- ")) continue;
    const m = line.match(/^- \*\*(.+?)\*\*\s*(.*)$/);
    const title = (m ? m[1] : line.slice(2)).replace(/[.:]$/, "");
    const text = m ? m[2] : "";
    const tag: ReleaseTag = FIX_RE.test(`${title} ${text}`)
      ? "Fixed"
      : section <= 0
        ? "New"
        : "Better";
    items.push({ tag, title, body: text.replace(/\*\*/g, "") });
  }
  return items;
}
