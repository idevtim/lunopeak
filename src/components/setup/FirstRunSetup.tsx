import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BootSplash } from "@/components/BootSplash";
import { useBootReady } from "@/hooks/useBootReady";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { usePlatform } from "@/hooks/usePlatform";
import { useUpdateSettings } from "@/hooks/useUpdateSettings";
import {
  markOnboarded,
  requestNotificationPermission,
} from "@/hooks/useNotificationOnboarding";
import { api, useFixtures } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toastStore";
import type { Settings } from "@/types/api";
import { ob } from "./motion";
import {
  AgentsStep,
  AlertsStep,
  DoneStep,
  FoldersStep,
  MenuBarStep,
  PrimaryButton,
  WelcomeStep,
  type FolderScan,
  type NotifState,
} from "./SetupSteps";

const SCAN_MIN_MS = 1200;
const LEAVE_MS = 320;
const LAST_STEP = 5;

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// `npm run dev` with `?setup` in the URL replays setup against the demo fixtures.
const forceSetup = () =>
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("setup");

type Phase = "setup" | "leaving" | "splash" | "done";

/**
 * First-run setup. Rendered inside the main webview as a 680×640 card over
 * a frosted backdrop (rather than a separate native window) while
 * `settings.setupComplete` is false; finishing replays the boot splash and
 * reveals the app. Each choice saves as it's made.
 */
export function FirstRunSetup() {
  const { settings } = useUpdateSettings();
  const [active, setActive] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("setup");

  // Decide once, from the first settings read — finishing flips the flag
  // mid-flow and must not unmount us before the splash plays.
  useEffect(() => {
    if (active === null && settings) setActive(!settings.setupComplete || forceSetup());
  }, [active, settings]);

  if (!active || !settings || phase === "done") return null;
  if (phase === "splash") return <Relaunch onDone={() => setPhase("done")} />;
  return (
    <Backdrop>
      <SetupCard
        leaving={phase === "leaving"}
        onFinished={() => setPhase("leaving")}
        onLeft={() => setPhase("splash")}
      />
    </Backdrop>
  );
}

function Backdrop({ children }: { children?: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[68] flex items-center justify-center bg-[linear-gradient(155deg,rgba(199,211,230,0.94)_0%,rgba(220,214,234,0.94)_50%,rgba(239,220,203,0.94)_100%)] backdrop-blur-xl dark:bg-[linear-gradient(155deg,rgba(24,27,38,0.95)_0%,rgba(30,27,40,0.95)_50%,rgba(38,32,28,0.95)_100%)]">
      {/* The app's own title bar is covered; keep the window draggable. */}
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
      {children}
    </div>
  );
}

/** Setup's exit: the boot splash plays again, then the app shows through. */
function Relaunch({ onDone }: { onDone: () => void }) {
  const ready = useBootReady();
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(onDone, 300);
    return () => clearTimeout(t);
  }, [ready, onDone]);
  return (
    <>
      {!ready && <Backdrop />}
      <BootSplash replay />
    </>
  );
}

function SetupCard({
  leaving,
  onFinished,
  onLeft,
}: {
  leaving: boolean;
  onFinished: () => void;
  onLeft: () => void;
}) {
  const qc = useQueryClient();
  const { settings, update: rawUpdate } = useUpdateSettings();
  const installed = useInstalledAgents();
  const platform = usePlatform();
  // Wait out the launch splash so the card's entrance is actually seen.
  const bootReady = useBootReady();

  // Stable writer so step effects don't re-arm on every render.
  const updateRef = useRef(rawUpdate);
  updateRef.current = rawUpdate;
  const update = useCallback((patch: (s: Settings) => Settings) => updateRef.current(patch), []);

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<"f" | "b">("f");
  const [scan, setScan] = useState<FolderScan>(() => ({
    candidates: settings?.scanDirs ?? [],
    counts: null,
    scanning: false,
  }));
  const [notif, setNotif] = useState<NotifState>("unknown");

  const mac = platform === "macos";
  const local = mac ? "Mac" : "computer";
  const tray = mac ? "menu bar" : "system tray";
  const os = mac ? "macOS" : platform === "windows" ? "Windows" : "Your system";

  const runScan = useCallback(async (dirs: string[]) => {
    setScan((s) => ({ ...s, scanning: true }));
    const started = Date.now();
    let counts: Record<string, number> | null = null;
    try {
      const repos = await api.scanRepos();
      // Compare on "/" with trailing separators trimmed, so Windows paths and
      // folders typed with a trailing slash still match their repos.
      const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
      const repoPaths = repos.map((r) => norm(r.path));
      counts = Object.fromEntries(
        dirs.map((d) => {
          const dir = norm(d);
          return [d, repoPaths.filter((p) => p === dir || p.startsWith(dir + "/")).length];
        }),
      );
    } catch (e) {
      toast.error("Couldn't look for repos", e instanceof Error ? e.message : String(e));
    }
    await new Promise((r) => setTimeout(r, Math.max(0, SCAN_MIN_MS - (Date.now() - started))));
    setScan((s) => ({ ...s, scanning: false, counts: counts ? { ...s.counts, ...counts } : s.counts }));
  }, []);

  // First visit to Project folders scans what's already listed.
  const scannedOnce = useRef(false);
  useEffect(() => {
    if (step !== 2 || scannedOnce.current) return;
    scannedOnce.current = true;
    void runScan(scan.candidates);
  }, [step, scan.candidates, runScan]);

  // Alerts: show the green line straight away if permission was granted before.
  useEffect(() => {
    if (step !== 4 || notif !== "unknown") return;
    if (!isTauri()) {
      setNotif("off");
      return;
    }
    void import("@tauri-apps/plugin-notification")
      .then((m) => m.isPermissionGranted())
      .then((granted) => setNotif(granted ? "on" : "off"))
      .catch(() => setNotif("off"));
  }, [step, notif]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onLeft, LEAVE_MS);
    return () => clearTimeout(t);
  }, [leaving, onLeft]);

  if (!settings) return null;

  const go = (next: number) => {
    setDir(next > step ? "f" : "b");
    setStep(Math.max(0, Math.min(LAST_STEP, next)));
  };

  const addFolder = isTauri()
    ? async () => {
        try {
          const { open } = await import("@tauri-apps/plugin-dialog");
          const picked = await open({ directory: true, multiple: false });
          if (typeof picked !== "string" || scan.candidates.includes(picked)) return;
          const current = qc.getQueryData<Settings>(queries.settings.queryKey) ?? settings;
          const next = { ...current, scanDirs: [...current.scanDirs, picked] };
          // Saved before rescanning: the scan reads folders from settings.
          qc.setQueryData(queries.settings.queryKey, next);
          await api.updateSettings(next);
          setScan((s) => ({ ...s, candidates: [...s.candidates, picked] }));
          await runScan([picked]);
        } catch (e) {
          toast.error("Couldn't add that folder", e instanceof Error ? e.message : String(e));
        }
      }
    : null;

  const setLaunchAtLogin = async (v: boolean) => {
    update((s) => ({ ...s, general: { ...s.general, launchAtLogin: v } }));
    if (useFixtures()) return;
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (v) await enable();
      else await disable();
    } catch (e) {
      toast.error("Couldn't update launch-at-login", e instanceof Error ? e.message : String(e));
      update((s) => ({ ...s, general: { ...s.general, launchAtLogin: !v } }));
    }
  };

  const allowNotifications = async () => {
    // Browser mode has no OS prompt; show the confirmed state for the demo.
    const granted = isTauri() ? await requestNotificationPermission() : true;
    markOnboarded();
    setNotif(granted ? "on" : "denied");
  };

  const finish = () => {
    // Before setupComplete flips, so useNotificationOnboarding doesn't prompt again.
    markOnboarded();
    update((s) => ({ ...s, setupComplete: true }));
    // Agents and folders may have changed; drop everything read during setup.
    void qc.resetQueries({ predicate: (q) => q.queryKey[0] !== "settings" });
    onFinished();
  };

  const watched = (["claudeCode", "codex", "cursor"] as const).filter(
    (k) => settings.agents[k] && (installed?.[k] ?? true),
  ).length;
  const repoCount = scan.counts
    ? settings.scanDirs.reduce((n, d) => n + (scan.counts?.[d] ?? 0), 0)
    : null;
  const summary = `Watching ${plural(watched, "agent")}${
    repoCount ? ` across ${plural(repoCount, "repo")}` : ""
  }. Look for LunoPeak in your ${tray}.`;

  const mid = step >= 1 && step <= 4;
  const stepAnim = ob(dir === "b" ? "in-left" : "in-right", 380);

  if (!bootReady) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up LunoPeak"
      className={cn(
        "lp-ob-anim flex h-[640px] max-h-[calc(100vh-32px)] w-[680px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl",
        "bg-[radial-gradient(120%_70%_at_50%_0%,#ffffff_0%,#f7f7f8_70%,#f1f1f3_100%)] shadow-[0_40px_100px_rgba(0,0,0,0.28),0_0_0_0.5px_rgba(0,0,0,0.25)]",
        "dark:bg-[radial-gradient(120%_70%_at_50%_0%,#27272a_0%,#1f1f22_70%,#18181b_100%)] dark:shadow-[0_40px_100px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(255,255,255,0.12)]",
      )}
      style={
        leaving
          ? { animation: `lp-ob-win-out ${LEAVE_MS}ms ease-in forwards` }
          : ob("win-in", 420)
      }
    >
      <div className="flex h-9 shrink-0 items-center justify-center text-[12.5px] font-semibold text-zinc-600 dark:text-zinc-400">
        Set up LunoPeak
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-10 pb-7 pt-1">
        {step === 0 && <WelcomeStep onStart={() => go(1)} local={local} />}
        {mid && (
          <div className="flex w-full flex-col gap-[22px]">
            <div className="flex items-center gap-2.5">
              <div className="flex flex-1 gap-1.5">
                {[1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className={cn(
                      "h-1 flex-1 rounded-full transition-colors duration-200",
                      i <= step ? "bg-zinc-900 dark:bg-zinc-100" : "bg-black/10 dark:bg-white/10",
                    )}
                  />
                ))}
              </div>
              <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">Step {step} of 4</span>
            </div>
            <div key={step} className="lp-ob-anim flex flex-col gap-[18px]" style={stepAnim}>
              {step === 1 && (
                <AgentsStep settings={settings} update={update} installed={installed} local={local} />
              )}
              {step === 2 && (
                <FoldersStep settings={settings} update={update} scan={scan} onAdd={addFolder} local={local} />
              )}
              {step === 3 && (
                <MenuBarStep
                  settings={settings}
                  update={update}
                  onLaunchAtLogin={(v) => void setLaunchAtLogin(v)}
                  tray={tray}
                />
              )}
              {step === 4 && (
                <AlertsStep
                  settings={settings}
                  update={update}
                  notif={notif}
                  onAllow={() => void allowNotifications()}
                  os={os}
                />
              )}
            </div>
            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => go(step - 1)}
                className="rounded-lg px-2.5 py-2 text-[13px] font-medium text-zinc-700 hover:bg-black/[0.05] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
              >
                Back
              </button>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => go(step + 1)}
                className="rounded-lg px-2.5 py-2 text-[13px] text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                Skip
              </button>
              <PrimaryButton onClick={() => go(step + 1)}>Continue</PrimaryButton>
            </div>
          </div>
        )}
        {step === LAST_STEP && (
          <DoneStep summary={summary} onFinish={finish} tray={tray} mod={mac ? "⌘" : "Ctrl+"} />
        )}
      </div>
    </div>
  );
}
