import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Activity, Bell, Check, Clock, Coins } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { Bone } from "@/components/ui/PageStates";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { providerAccent } from "@/views/tray-panel/shared";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InstalledAgents, Settings, TrayTitleStyle } from "@/types/api";
import { EASE, ob } from "./motion";

type Update = (patch: (s: Settings) => Settings) => void;

export const tildify = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, "~");

function StepTitle({ title, body }: { title: ReactNode; body: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="m-0 text-[22px] font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">
        {title}
      </h2>
      <p className="m-0 text-sm leading-relaxed text-zinc-600 text-pretty dark:text-zinc-400">{body}</p>
    </div>
  );
}

function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-black/[0.08] bg-white dark:border-white/[0.08] dark:bg-white/[0.04]",
        className,
      )}
    >
      {children}
    </div>
  );
}

const DIVIDER = "border-t border-black/[0.05] dark:border-white/[0.06]";

// ── Welcome ────────────────────────────────────────────────────────────

const FEATURES = [
  { icon: Activity, label: "What’s running" },
  { icon: Clock, label: "Plan limits" },
  { icon: Coins, label: "Spending" },
];

export function WelcomeStep({ onStart, local }: { onStart: () => void; local: string }) {
  return (
    <div className="flex w-full max-w-[520px] flex-col items-center gap-5 text-center">
      <span className="relative inline-flex">
        <span
          aria-hidden
          className="lp-ob-anim absolute -inset-[45%] rounded-full"
          style={{
            background: "radial-gradient(circle, rgba(58,82,168,0.38) 0%, rgba(58,82,168,0) 70%)",
            animation: "lp-ob-halo 3.4s ease-in-out infinite",
          }}
        />
        <img
          src="/app-icon.png"
          alt=""
          draggable={false}
          className="lp-ob-anim relative size-[72px] rounded-[17px] shadow-[0_12px_30px_rgba(0,0,0,0.15)]"
          style={{
            animation: `lp-ob-pop 650ms ${EASE} both, lp-ob-float 4.5s ease-in-out 700ms infinite`,
          }}
        />
      </span>
      <div className="lp-ob-anim flex flex-col gap-2.5" style={ob("up", 550, 180)}>
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-50">
          Welcome to Luno<span className="text-[#3a52a8] dark:text-indigo-300">Peak</span>
        </h1>
        <p className="m-0 text-[15px] leading-relaxed text-zinc-600 text-pretty dark:text-zinc-400">
          See what your AI coding agents are doing, what they cost and how close you are to your
          limits.
        </p>
      </div>
      <div className="grid w-full grid-cols-3 gap-2.5">
        {FEATURES.map(({ icon: Icon, label }, i) => (
          <div
            key={label}
            className="lp-ob-anim flex flex-col items-center gap-2 rounded-xl border border-black/[0.06] bg-white/80 px-2.5 py-3.5 dark:border-white/[0.08] dark:bg-white/[0.05]"
            style={ob("up", 500, 320 + i * 90)}
          >
            <Icon size={20} strokeWidth={1.75} className="text-[#3a52a8] dark:text-indigo-300" />
            <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
          </div>
        ))}
      </div>
      <div className="lp-ob-anim flex flex-col items-center gap-2.5" style={ob("up", 500, 620)}>
        <PrimaryButton onClick={onStart}>Get started</PrimaryButton>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Takes about a minute. Everything stays on this {local}.
        </span>
      </div>
    </div>
  );
}

export function PrimaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[9px] bg-zinc-900 px-[18px] py-[9px] text-[13.5px] font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
    >
      {children}
    </button>
  );
}

// ── 1 · Agents ─────────────────────────────────────────────────────────

const AGENTS = [
  { id: "claude", key: "claudeCode", name: "Claude Code", source: "Sessions in ~/.claude" },
  { id: "codex", key: "codex", name: "Codex", source: "Sessions in ~/.codex" },
  { id: "cursor", key: "cursor", name: "Cursor", source: "Chats in the Cursor app" },
] as const;

export function AgentsStep({
  settings,
  update,
  installed,
  local,
}: {
  settings: Settings;
  update: Update;
  installed: InstalledAgents | undefined;
  local: string;
}) {
  const found = AGENTS.filter((a) => installed?.[a.key]);
  const setAgent = (key: keyof Settings["agents"], v: boolean) =>
    update((s) => ({ ...s, agents: { ...s.agents, [key]: v } }));

  return (
    <>
      <StepTitle
        title={
          !installed
            ? "Looking for agents…"
            : found.length
              ? `We found ${plural(found.length, "agent")} on this ${local}`
              : "No agents found yet"
        }
        body={
          found.length || !installed
            ? "Pick the ones you want LunoPeak to watch. You can change this later in Settings."
            : "LunoPeak didn’t find Claude Code, Codex or Cursor. You can keep going; they’re picked up as soon as you install one."
        }
      />
      {!installed ? (
        <Panel className="gap-px p-3">
          <Bone className="h-10 rounded-lg" />
          <Bone className="h-10 rounded-lg" />
        </Panel>
      ) : (
        found.length > 0 && (
          <Panel>
            {found.map((a, i) => {
              const on = settings.agents[a.key];
              const accent = providerAccent(a.id);
              return (
                <div key={a.id} className={cn(i > 0 && DIVIDER)}>
                  <div
                    className="lp-ob-anim flex items-center gap-3 px-3.5 py-3"
                    style={ob("up", 450, 150 + i * 110)}
                  >
                    <span className={cn("flex size-[30px] items-center justify-center rounded-lg", accent.chip)}>
                      <ProviderIcon provider={a.id} size={14} className={accent.text} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="flex items-center gap-2 text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                        {a.name}
                        <span
                          className="lp-ob-anim rounded-full bg-emerald-500/12 px-[7px] py-px text-[11.5px] font-semibold text-emerald-700 dark:text-emerald-300"
                          style={ob("pop", 420, 380 + i * 110)}
                        >
                          Found
                        </span>
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">{a.source}</span>
                    </div>
                    <Switch checked={on} onChange={(v) => setAgent(a.key, v)} ariaLabel={a.name} />
                  </div>
                  {a.id === "cursor" && (
                    <div
                      className={cn(
                        "flex items-start gap-3 pb-3 pl-14 pr-3.5 transition-opacity",
                        !on && "opacity-40",
                      )}
                    >
                      <div className="flex flex-1 flex-col gap-0.5">
                        <span className="text-[12.5px] text-zinc-700 dark:text-zinc-300">
                          Also read plan usage from cursor.com
                        </span>
                        <span className="text-xs text-zinc-500 text-pretty dark:text-zinc-400">
                          Uses your browser sign-in. macOS will ask for Keychain access.
                        </span>
                      </div>
                      <Switch
                        checked={settings.agents.cursorWeb}
                        disabled={!on}
                        onChange={(v) => setAgent("cursorWeb", v)}
                        ariaLabel="Cursor web usage"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </Panel>
        )
      )}
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        Not seeing an agent? LunoPeak supports Claude Code, Codex and Cursor. Install one and it’s
        picked up automatically.
      </span>
    </>
  );
}

// ── 2 · Project folders ────────────────────────────────────────────────

export interface FolderScan {
  /** Every folder offered so far, in display order. */
  candidates: string[];
  /** Repos found per folder; null until the first scan lands. */
  counts: Record<string, number> | null;
  scanning: boolean;
}

export function FoldersStep({
  settings,
  update,
  scan,
  onAdd,
  local,
}: {
  settings: Settings;
  update: Update;
  scan: FolderScan;
  /** Null when there's no native folder picker (browser mode). */
  onAdd: (() => void) | null;
  local: string;
}) {
  const checked = (dir: string) => settings.scanDirs.includes(dir);
  const toggle = (dir: string) =>
    update((s) => ({
      ...s,
      scanDirs: s.scanDirs.includes(dir)
        ? s.scanDirs.filter((d) => d !== dir)
        : scan.candidates.filter((d) => d === dir || s.scanDirs.includes(d)),
    }));
  const total = scan.counts
    ? settings.scanDirs.reduce((n, d) => n + (scan.counts?.[d] ?? 0), 0)
    : 0;

  return (
    <>
      <StepTitle
        title="Where do you keep your projects?"
        body={`LunoPeak looks for git repos inside these folders. Nothing is uploaded; it only reads them on this ${local}.`}
      />
      <Panel>
        {scan.candidates.length === 0 && (
          <span className="px-3.5 py-3 text-[13px] text-zinc-500 dark:text-zinc-400">
            No usual project folders here. Add the folder where you keep your code.
          </span>
        )}
        {scan.candidates.map((dir, i) => {
          const on = checked(dir);
          const n = scan.counts?.[dir];
          return (
            <button
              key={dir}
              type="button"
              onClick={() => toggle(dir)}
              aria-pressed={on}
              className={cn(
                "lp-ob-anim flex items-center gap-3 px-3.5 py-[11px] text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
                i > 0 && DIVIDER,
              )}
              style={ob("up", 420, 120 + i * 90)}
            >
              <span
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition-colors",
                  on ? "border-blue-500 bg-blue-500" : "border-black/25 bg-white dark:border-white/30 dark:bg-transparent",
                )}
              >
                <Check size={11} strokeWidth={3.5} className={cn("text-white", !on && "opacity-0")} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-900 dark:text-zinc-100">
                {tildify(dir)}
              </span>
              {n !== undefined && (
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
                  {n > 0 ? plural(n, "repo") : "No repos found"}
                </span>
              )}
            </button>
          );
        })}
      </Panel>
      <div className="flex items-center gap-2.5">
        {onAdd && (
          <Button size="md" onClick={onAdd} disabled={scan.scanning}>
            Add another folder…
          </Button>
        )}
        <span className="flex-1" />
        {scan.scanning ? (
          <span className="flex items-center gap-[7px] text-[12.5px] text-zinc-600 dark:text-zinc-400">
            <span
              className="size-3 rounded-full border-2 border-blue-500/25 border-t-blue-500"
              style={{ animation: "lp-ob-spin 700ms linear infinite" }}
            />
            Looking for repos…
          </span>
        ) : (
          scan.counts && (
            <span
              className={cn(
                "lp-ob-anim flex items-center gap-1.5 text-[12.5px] font-medium",
                total > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500",
              )}
              style={ob("pop", 380)}
            >
              {total > 0 && <Check size={13} strokeWidth={2.75} className="text-emerald-600" />}
              {settings.scanDirs.length === 0
                ? "Pick at least one folder"
                : total > 0
                  ? `${plural(total, "repo")} found`
                  : "No repos found yet"}
            </span>
          )
        )}
      </div>
    </>
  );
}

// ── 3 · Menu bar ───────────────────────────────────────────────────────

const WINDOW_SHORT: Record<Settings["tray"]["headlineWindow"], string> = {
  "5h": "5h",
  weekly: "Wk",
  fable: "Fable",
};

export function MenuBarStep({
  settings,
  update,
  onLaunchAtLogin,
  tray,
}: {
  settings: Settings;
  update: Update;
  onLaunchAtLogin: (v: boolean) => void;
  /** "menu bar" on macOS, "system tray" elsewhere. */
  tray: string;
}) {
  const style = settings.tray.titleStyle;
  // Example figures: the real number depends on usage LunoPeak hasn't read yet.
  const withWindow = `72% ${WINDOW_SHORT[settings.tray.headlineWindow]}`;
  const options: { id: TrayTitleStyle; label: string; desc: string }[] = [
    { id: "off", label: "Icon only", desc: "Cleanest" },
    { id: "percent", label: "72%", desc: "Just the number" },
    { id: "percentWindow", label: withWindow, desc: "Number and limit" },
  ];
  const preview = style === "off" ? null : style === "percent" ? "72%" : withWindow;

  return (
    <>
      <StepTitle
        title={`Keep an eye on limits from the ${tray}`}
        body="A small LunoPeak icon sits next to the clock. Click it for a quick look without opening this window."
      />
      <div className="flex flex-col items-end gap-2.5 rounded-xl bg-gradient-to-b from-[#dbe4ee] to-[#cfd8e3] px-[18px] pb-7 pt-4 dark:from-zinc-800 dark:to-zinc-800/70">
        <div className="flex h-7 w-full items-center justify-end gap-4 rounded-[7px] bg-white/75 px-3 text-[12.5px] text-zinc-900 dark:bg-zinc-900/70 dark:text-zinc-100">
          <span className="text-zinc-500">Wi‑Fi</span>
          <span
            className="lp-ob-anim relative flex items-center gap-[5px] overflow-hidden rounded-[5px] bg-black/[0.08] px-[7px] py-0.5 dark:bg-white/[0.1]"
            style={ob("pop", 500, 250)}
          >
            <span
              aria-hidden
              className="lp-ob-motion-only absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/80 to-transparent"
              style={{ animation: "lp-ob-sheen 2.6s ease-in-out 900ms infinite" }}
            />
            <img src="/icons/lunopeak-template.png" alt="" className="size-[15px] object-contain dark:invert" />
            {preview && <span className="font-medium tabular-nums">{preview}</span>}
          </span>
          <span className="text-zinc-500">Mon 10:24</span>
        </div>
        <span className="text-xs text-zinc-700 dark:text-zinc-400">
          Shows the agent closest to its limit
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">Next to the icon, show</span>
        <div className="flex gap-1.5">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={style === o.id}
              onClick={() => update((s) => ({ ...s, tray: { ...s.tray, titleStyle: o.id } }))}
              className={cn(
                "flex flex-1 flex-col items-start gap-[3px] rounded-[10px] border-[1.5px] px-3 py-2.5 text-left transition-colors",
                style === o.id
                  ? "border-blue-500 bg-blue-500/5"
                  : "border-black/10 bg-white hover:bg-zinc-50 dark:border-white/10 dark:bg-white/[0.03]",
              )}
            >
              <span className="text-[13px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{o.label}</span>
              <span className="text-[11.5px] text-zinc-500 dark:text-zinc-400">{o.desc}</span>
            </button>
          ))}
        </div>
      </div>
      <Panel>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-[13px] text-zinc-900 dark:text-zinc-100">Open LunoPeak when you log in</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">So the {tray} is always up to date.</span>
          </div>
          <Switch
            checked={settings.general.launchAtLogin}
            onChange={onLaunchAtLogin}
            ariaLabel="Open at login"
          />
        </div>
      </Panel>
    </>
  );
}

// ── 4 · Alerts ─────────────────────────────────────────────────────────

export type NotifState = "unknown" | "off" | "on" | "denied";

export function AlertsStep({
  settings,
  update,
  notif,
  onAllow,
  os,
}: {
  settings: Settings;
  update: Update;
  notif: NotifState;
  onAllow: () => void;
  /** "macOS", "Windows", "your system". */
  os: string;
}) {
  const alerts = settings.usageAlerts;
  // Local while dragging / typing; saved once the value settles.
  const [pct, setPct] = useState(alerts.thresholdPct);
  const [budget, setBudget] = useState(
    settings.costBudget.monthlyUsd > 0 ? String(settings.costBudget.monthlyUsd) : "",
  );

  useEffect(() => {
    if (pct === alerts.thresholdPct) return;
    const t = setTimeout(
      () => update((s) => ({ ...s, usageAlerts: { ...s.usageAlerts, thresholdPct: pct } })),
      250,
    );
    return () => clearTimeout(t);
  }, [pct, alerts.thresholdPct, update]);

  useEffect(() => {
    const usd = Number(budget) || 0;
    if (usd === settings.costBudget.monthlyUsd) return;
    const t = setTimeout(
      () => update((s) => ({ ...s, costBudget: { ...s.costBudget, monthlyUsd: usd } })),
      400,
    );
    return () => clearTimeout(t);
  }, [budget, settings.costBudget.monthlyUsd, update]);

  return (
    <>
      <StepTitle
        title="Get a heads-up before you run out"
        body="LunoPeak can send a notification when an agent is close to its plan limit or you’re close to your budget."
      />
      <Panel>
        <div className="flex flex-col gap-3 p-3.5">
          <div className="flex items-center gap-3">
            <span className="flex-1 text-[13px] text-zinc-900 dark:text-zinc-100">Warn me when a limit is nearly used</span>
            <Switch
              checked={alerts.enabled}
              onChange={(v) => update((s) => ({ ...s, usageAlerts: { ...s.usageAlerts, enabled: v } }))}
              ariaLabel="Limit alerts"
            />
          </div>
          <div className={cn("flex items-center gap-3 transition-opacity", !alerts.enabled && "opacity-40")}>
            <span className="text-[12.5px] text-zinc-600 dark:text-zinc-400">At</span>
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={pct}
              disabled={!alerts.enabled}
              onChange={(e) => setPct(Number(e.target.value))}
              aria-label="Alert threshold"
              className="m-0 flex-1 accent-blue-500"
            />
            <span className="w-10 text-[13px] font-semibold tabular-nums text-blue-700 dark:text-blue-400">{pct}%</span>
          </div>
        </div>
        <div className={cn("flex items-center gap-3 px-3.5 py-3", DIVIDER)}>
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="text-[13px] text-zinc-900 dark:text-zinc-100">Monthly budget</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Optional. Leave empty for no budget.</span>
          </div>
          <label className="flex w-[110px] items-center gap-[3px] rounded-lg border border-black/[0.12] bg-white px-2.5 py-1.5 text-[13px] focus-within:border-blue-500/60 focus-within:ring-[3px] focus-within:ring-blue-500/12 dark:border-white/[0.12] dark:bg-white/[0.04]">
            <span className="text-zinc-500">$</span>
            <input
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="400"
              aria-label="Monthly budget in dollars"
              className="min-w-0 flex-1 bg-transparent tabular-nums text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
            />
          </label>
        </div>
      </Panel>
      {notif === "on" ? (
        <div
          className="lp-ob-anim flex items-center gap-2.5 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] px-3.5 py-3 text-[13px] text-emerald-900 dark:text-emerald-300"
          style={ob("pop", 420)}
        >
          <Check size={15} strokeWidth={2.75} className="text-emerald-600" />
          {alerts.enabled
            ? `Notifications are on. You’ll get one the next time a limit passes ${pct}%.`
            : "Notifications are on."}
        </div>
      ) : notif === "denied" ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-3.5 py-3 text-[13px] text-amber-900 dark:text-amber-300">
          <Bell size={15} strokeWidth={1.9} className="shrink-0 text-amber-600" />
          {os} didn’t allow notifications. You can turn them on later in its notification settings.
        </div>
      ) : (
        notif === "off" && (
          <div className="flex items-center gap-3 rounded-xl border border-blue-500/[0.18] bg-blue-500/[0.06] px-3.5 py-3">
            <Bell
              size={18}
              strokeWidth={1.9}
              className="lp-ob-anim shrink-0 text-blue-600"
              style={{ transformOrigin: "50% 10%", ...ob("ring", 1100, 600, "ease-in-out") } as CSSProperties}
            />
            <span className="flex-1 text-[13px] text-blue-950 dark:text-blue-200">
              {os} needs your OK to show notifications.
            </span>
            <button
              type="button"
              onClick={onAllow}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-700"
            >
              Allow notifications
            </button>
          </div>
        )
      )}
    </>
  );
}

// ── Done ───────────────────────────────────────────────────────────────

const BURST = [
  [58, 0, 8, "#3a52a8", 0, true],
  [64, 37, 6, "#f97316", 30, false],
  [29, 50, 6, "#10b981", 60, true],
  [0, 74, 8, "#f59e0b", 90, false],
  [-29, 50, 6, "#3a52a8", 0, true],
  [-64, 37, 6, "#f97316", 30, false],
  [-58, 0, 8, "#10b981", 60, true],
  [-64, -37, 6, "#f59e0b", 90, false],
  [-29, -50, 6, "#3a52a8", 0, true],
  [0, -74, 8, "#f97316", 30, false],
  [29, -50, 6, "#10b981", 60, true],
  [64, -37, 6, "#f59e0b", 90, false],
] as const;

const TIPS = [
  ["⌘K", "Go to any page, setting or action"],
  ["Menu bar icon", "A quick look at limits and what’s running"],
  ["Settings", "Change anything you picked here"],
] as const;

export function DoneStep({
  summary,
  onFinish,
  tray,
  mod,
}: {
  summary: string;
  onFinish: () => void;
  tray: string;
  /** "⌘" on macOS, "Ctrl+" elsewhere. */
  mod: string;
}) {
  const tips = TIPS.map(([k, v]) => [
    k === "⌘K" ? `${mod}K` : k === "Menu bar icon" ? `${tray[0].toUpperCase()}${tray.slice(1)} icon` : k,
    v,
  ]);
  return (
    <div className="flex w-full max-w-[520px] flex-col items-center gap-5 text-center">
      <span className="relative flex size-16 items-center justify-center">
        {BURST.map(([dx, dy, size, color, delay, round], i) => (
          <span
            key={i}
            aria-hidden
            className="lp-ob-anim lp-ob-motion-only absolute left-1/2 top-1/2 -m-[3px]"
            style={
              {
                width: size,
                height: size,
                borderRadius: round ? 999 : 2,
                background: color,
                "--dx": `${dx}px`,
                "--dy": `${dy}px`,
                ...ob("burst", 900, 300 + delay),
              } as CSSProperties
            }
          />
        ))}
        <span className="lp-ob-anim absolute inset-0 rounded-full bg-emerald-500/[0.14]" style={ob("pop", 500)} />
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="relative">
          <path
            d="M20 6 9 17l-5-5"
            className="lp-ob-anim"
            style={{ strokeDasharray: 32, ...ob("draw", 450, 250, "ease-out") }}
          />
        </svg>
      </span>
      <div className="lp-ob-anim flex flex-col gap-2" style={ob("up", 500, 350)}>
        <h2 className="m-0 text-[26px] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-50">
          You’re all set
        </h2>
        <p className="m-0 text-[14.5px] text-zinc-600 dark:text-zinc-400">{summary}</p>
      </div>
      <div className="lp-ob-anim w-full text-left" style={ob("up", 500, 500)}>
        <Panel>
          {tips.map(([k, v], i) => (
            <div key={k} className={cn("flex items-center gap-3 px-3.5 py-[11px]", i > 0 && DIVIDER)}>
              <span className="w-[118px] shrink-0 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                <span className="rounded-[5px] border border-black/[0.12] bg-zinc-50 px-1.5 py-px dark:border-white/[0.12] dark:bg-white/[0.05]">
                  {k}
                </span>
              </span>
              <span className="text-[13px] text-zinc-700 dark:text-zinc-300">{v}</span>
            </div>
          ))}
        </Panel>
      </div>
      <PrimaryButton onClick={onFinish}>Open LunoPeak</PrimaryButton>
    </div>
  );
}
