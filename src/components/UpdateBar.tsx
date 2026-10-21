import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { queries } from "@/lib/queries";
import { checkForUpdates, installAndRestart } from "@/lib/updates";
import { useUpdateStore } from "@/stores/updateStore";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Re-check this often, so a window left open for days still hears about releases. */
const RECHECK_MS = 6 * 60 * 60 * 1000;
/** How often to look at the clock. Timers stall while the machine sleeps, so
 *  "is a re-check due" is measured against `checkedAt`, not one long timeout. */
const POLL_MS = 15 * 60 * 1000;

/**
 * Boot-time (then every 6h) update check + the dark "LunoPeak X is ready" pill at the bottom
 * of the main area. Renders nothing in dev, browser mode, or when no updater
 * config is present — the check is quiet, so missing config never shows an error.
 *
 * State lives in {@link useUpdateStore} so a manual check anywhere (Settings,
 * the palette) surfaces this same bar.
 */
export function UpdateBar() {
  const settings = useQuery(queries.settings);
  const autoCheck = settings.data?.general.checkUpdates ?? false;
  const autoInstall = settings.data?.general.autoInstallUpdates ?? false;
  const { update, phase, dismissed, setPhase, setError, dismiss, setWhatsNewOpen } =
    useUpdateStore();

  useEffect(() => {
    if (!isTauri() || !autoCheck) return;
    let cancelled = false;
    const run = async () => {
      // Once one is found there's nothing newer to learn until it's installed.
      if (useUpdateStore.getState().update) return;
      const version = await checkForUpdates({ quiet: true });
      if (cancelled || !version || !autoInstall) return;
      // Install in the background; the bar then reads "ready, restart".
      const found = useUpdateStore.getState().update;
      if (!found) return;
      setPhase("installing");
      try {
        await found.install();
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("available");
        }
      }
    };
    const t = setTimeout(() => void run(), 4000); // let the app finish painting first
    const poll = setInterval(() => {
      const { checkedAt } = useUpdateStore.getState();
      if (checkedAt == null || Date.now() - checkedAt >= RECHECK_MS) void run();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(poll);
    };
  }, [autoCheck, autoInstall, setPhase, setError]);

  if (!update || dismissed) return null;

  return (
    <div
      role="status"
      className="fixed bottom-5 z-40 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-xl bg-zinc-900 py-2.5 pl-4 pr-2.5 text-white shadow-[0_12px_32px_rgba(0,0,0,0.25)] animate-lp-pop-in dark:bg-zinc-800 dark:ring-1 dark:ring-white/10"
      style={{ left: "calc(232px + (100% - 232px) / 2)" }}
    >
      <span className="size-2 rounded-full bg-emerald-500" />
      <span className="text-[13px]">
        <b className="font-semibold">LunoPeak {update.version} is ready.</b>{" "}
        {phase === "installing" ? "Installing…" : "Restart to update."}
      </span>
      <button
        type="button"
        onClick={() => setWhatsNewOpen(true)}
        className="rounded-md px-2 py-[5px] text-[12.5px] font-medium text-zinc-300 underline decoration-white/30 underline-offset-[3px] hover:bg-white/[0.08] hover:text-white"
      >
        What's new
      </button>
      <button
        type="button"
        disabled={phase === "installing"}
        onClick={() => void installAndRestart()}
        className="rounded-[7px] bg-white px-3 py-1.5 text-[12.5px] font-semibold text-zinc-900 hover:bg-zinc-200 disabled:opacity-60"
      >
        Restart
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex size-[26px] items-center justify-center rounded-md text-zinc-400 hover:bg-white/10"
      >
        <X size={13} strokeWidth={2.25} />
      </button>
    </div>
  );
}
