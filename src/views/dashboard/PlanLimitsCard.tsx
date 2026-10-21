import { Fragment, useEffect, useState } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/Page";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { describeInstalledAgents, useInstalledAgents } from "@/hooks/useInstalledAgents";
import { useOnline } from "@/hooks/useOnline";
import { formatCount, formatUsd } from "@/lib/format";
import { queries } from "@/lib/queries";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toastStore";
import type { ProviderStatus, ProviderUsage, UsageNotice, UsageWindow } from "@/types/api";
import {
  type Accent,
  providerAccent,
  providerAccentSecondary,
  providerLabel,
  useNow,
} from "@/views/tray-panel/shared";
import { providerStatus, resetLabel, type Status } from "@/views/tray-panel/TrayPanelView";

const STATUS_PILL: Record<Status, { label: string; tone: PillTone }> = {
  healthy: { label: "Healthy", tone: "green" },
  close: { label: "Getting close", tone: "amber" },
  out: { label: "Almost out", tone: "rose" },
};

/**
 * Home's plan limits: per provider, a status pill plus "This session" /
 * "This week" meters. Same thresholds and wording as the menu bar panel.
 */
export function PlanLimitsCard({ id, className }: { id?: string; className?: string }) {
  const online = useOnline();
  const limits = useQuery({ ...queries.usageLimits, enabled: online });
  const status = useQuery({ ...queries.providerStatus, enabled: online });
  const installed = useInstalledAgents();
  const now = useNow();
  const providers = limits.data?.providers ?? [];
  const statusByProvider = new Map<string, ProviderStatus>();
  for (const s of status.data?.providers ?? []) statusByProvider.set(s.provider, s);

  return (
    <Card id={id} className={cn("flex flex-col gap-3.5 px-[18px] pb-4 pt-3.5", className)}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Plan limits</span>
        {limits.dataUpdatedAt > 0 && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Updated {updatedAgo(limits.dataUpdatedAt, now)}
          </span>
        )}
        <RefreshAction providers={providers} />
      </div>

      {limits.isError && providers.length === 0 ? (
        <div className="flex items-center gap-3 rounded-[10px] bg-rose-500/[0.06] px-3 py-2.5 dark:bg-rose-500/10">
          <span className="min-w-0 flex-1 text-[12.5px] text-rose-800 dark:text-rose-200">
            Plan limits didn't load. {errorText(limits.error)}
          </span>
          <Button onClick={() => void limits.refetch()}>Try again</Button>
        </div>
      ) : providers.length === 0 ? (
        <p className="m-0 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          {limits.isLoading
            ? "Checking your plans…"
            : !online
              ? "You're offline. Plan limits come back when you reconnect."
              : describeInstalledAgents(installed)
                ? `Turn on ${describeInstalledAgents(installed)} in Settings to see plan limits here.`
                : "Install Claude Code, Codex or Cursor to see plan limits here."}
        </p>
      ) : (
        providers.map((p, i) => (
          <Fragment key={p.provider}>
            {i > 0 && <div className="h-px bg-black/[0.05] dark:bg-white/[0.06]" />}
            {p.provider === "cursor" ? (
              <CursorRow usage={p} service={statusByProvider.get(p.provider)} />
            ) : (
              <ProviderBlock usage={p} service={statusByProvider.get(p.provider)} />
            )}
          </Fragment>
        ))
      )}
    </Card>
  );
}

function ProviderChip({ provider }: { provider: ProviderUsage["provider"] }) {
  const accent = providerAccent(provider);
  return (
    <span className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-md", accent.chip)}>
      <ProviderIcon provider={provider} size={12} className={accent.text} />
    </span>
  );
}

function ProviderBlock({ usage, service }: { usage: ProviderUsage; service?: ProviderStatus }) {
  const name = providerLabel(usage.provider);
  const status = providerStatus(usage);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <ProviderChip provider={usage.provider} />
        <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {usage.plan ? `${capitalize(usage.plan)} plan` : null}
          <ServiceNote service={service} />
        </span>
        {status && <Pill tone={STATUS_PILL[status].tone}>{STATUS_PILL[status].label}</Pill>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Meter
          label="This session"
          usage={usage.fiveHour}
          accent={providerAccent(usage.provider)}
          tooltip={`Rolling 5-hour window tied to your ${name} plan's session limit.`}
        />
        <Meter
          label="This week"
          usage={usage.weekly}
          accent={providerAccentSecondary(usage.provider)}
          tooltip={`Rolling 7-day window tied to your ${name} plan's weekly limit. It won't match the Costs page's "Last 7 days", which counts calendar days across all tools.`}
        />
        {(usage.modelLimits ?? []).map((l) => (
          <Meter
            key={l.model}
            label={`This week · ${l.model}`}
            usage={l.window}
            accent={providerAccentSecondary(usage.provider)}
            tooltip={`A separate weekly limit for ${l.model} models. It fills on its own and can run out before the all-models week${l.isActive ? ", and it's the limit holding your account right now" : ""}.`}
          />
        ))}
      </div>
      {usage.notice && <NoticeLine notice={usage.notice} />}
    </div>
  );
}

function Meter({
  label,
  usage,
  accent,
  tooltip,
}: {
  label: string;
  usage: UsageWindow;
  accent: Accent;
  tooltip: string;
}) {
  const pct = usage.usedPercent != null ? Math.max(0, Math.min(100, usage.usedPercent)) : null;
  const caption =
    pct == null
      ? usage.tokens > 0
        ? `${formatCount(usage.tokens)} tokens used`
        : "No data yet"
      : resetLabel(usage.resetsAt);
  return (
    <div title={tooltip} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex justify-between gap-2 text-[12.5px]">
        <span className="truncate text-zinc-700 dark:text-zinc-300">{label}</span>
        <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
          {pct != null ? `${Math.round(pct)}%` : "—"}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]">
        {pct != null && (
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", accent.bar)}
            style={{ width: `${Math.max(pct, 1.5)}%` }}
          />
        )}
      </div>
      <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">{caption || " "}</span>
    </div>
  );
}

function CursorRow({ usage, service }: { usage: ProviderUsage; service?: ProviderStatus }) {
  const w = usage.fiveHour;
  const pct = w.usedPercent != null ? Math.max(0, Math.min(100, w.usedPercent)) : null;
  // With the cursor.com read on, the headline is plan usage for the billing
  // period; otherwise it's the most active chat's context fill.
  const plan = w.resetsAt != null;
  const caption =
    pct == null
      ? "Send a message in Cursor to see how full the chat is"
      : plan
        ? `${Math.round(pct)}% of this billing period's plan used`
        : `Current chat is ${Math.round(pct)}% full`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ProviderChip provider="cursor" />
        <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">Cursor</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
          {[
            usage.plan ? `${capitalize(usage.plan)} plan` : null,
            caption,
            plan && usage.weekly.costUsd > 0 ? `${formatUsd(usage.weekly.costUsd, true)} on-demand` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          <ServiceNote service={service} />
        </span>
        <span className="h-1.5 w-[90px] shrink-0 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.06]">
          {pct != null && (
            <span
              className={cn("block h-full rounded-full", providerAccent("cursor").bar)}
              style={{ width: `${Math.max(pct, 1.5)}%` }}
            />
          )}
        </span>
      </div>
      {usage.notice && <NoticeLine notice={usage.notice} />}
    </div>
  );
}

/** " · Service issues" after the plan name when the provider's status page reports trouble. */
function ServiceNote({ service }: { service?: ProviderStatus }) {
  if (!service || service.indicator === "none" || service.indicator === "unknown") return null;
  const incidents = service.incidents
    .slice(0, 3)
    .map((i) => `• ${i.name} (${i.status})`)
    .join("\n");
  return (
    <span
      title={incidents ? `${service.description}\n${incidents}` : service.description}
      className={cn(
        "ml-1",
        service.indicator === "minor" ? "text-amber-700 dark:text-amber-300" : "text-rose-700 dark:text-rose-300",
      )}
    >
      · {service.description}
    </span>
  );
}

function NoticeLine({ notice }: { notice: UsageNotice }) {
  const retry = formatRetryHint(notice.retryAt);
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs",
        notice.kind === "rateLimited" || notice.kind === "staleSource"
          ? "bg-amber-500/[0.08] text-amber-800 dark:text-amber-300"
          : "bg-rose-500/[0.08] text-rose-700 dark:text-rose-300",
      )}
    >
      <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0" />
      <span>
        {notice.message}
        {retry && <> Trying again in {retry}.</>}
      </span>
    </div>
  );
}

/**
 * Force-refresh button. A manual refresh during a real 429 can't produce new
 * numbers — retrying just re-arms the server's timer — so it's disabled until
 * the soonest rate-limit retry passes.
 */
function RefreshAction({ providers }: { providers: ProviderUsage[] }) {
  const qc = useQueryClient();
  const online = useOnline();
  const isFetching = useIsFetching({ queryKey: queries.usageLimits.queryKey }) > 0;
  const blockedUntilMs = soonestRetryMs(providers);
  useExpiryTick(blockedUntilMs);
  const blocked = blockedUntilMs != null && blockedUntilMs > Date.now();
  const title = !online
    ? "Offline. Connect to refresh plan limits"
    : blocked
      ? `Rate-limited. Try again in ${formatRetryHint(Math.ceil(blockedUntilMs / 1000))}`
      : "Refresh plan limits";
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      disabled={isFetching || blocked || !online}
      onClick={async () => {
        try {
          // Bypass Rust's backoff cache — the registered queryFn never forces.
          await qc.fetchQuery({
            queryKey: queries.usageLimits.queryKey,
            queryFn: () => api.getUsageLimits(true),
            staleTime: 0,
          });
          toast.success("Plan limits refreshed");
        } catch (e) {
          toast.error("Couldn't refresh plan limits", errorText(e));
        }
      }}
      className="inline-flex size-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-700 disabled:pointer-events-none disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
    >
      <RefreshCw size={13} strokeWidth={1.9} className={isFetching ? "animate-spin" : undefined} />
    </button>
  );
}

/** Re-render once when `untilMs` passes so the refresh button re-enables. */
function useExpiryTick(untilMs: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (untilMs == null) return;
    const delay = untilMs - Date.now();
    if (delay <= 0) return;
    const id = window.setTimeout(() => setTick((t) => t + 1), delay + 100);
    return () => window.clearTimeout(id);
  }, [untilMs]);
}

// Only a genuine 429 disables the button; transient failures stay retryable.
function soonestRetryMs(providers: ProviderUsage[]): number | null {
  const now = Date.now();
  let soonest: number | null = null;
  for (const p of providers) {
    if (p.notice?.kind !== "rateLimited" || p.notice.retryAt == null) continue;
    const ms = p.notice.retryAt * 1000;
    if (ms > now && (soonest == null || ms < soonest)) soonest = ms;
  }
  return soonest;
}

function formatRetryHint(retryAt: number | null | undefined): string {
  if (!retryAt) return "";
  const min = Math.round((retryAt * 1000 - Date.now()) / 60000);
  if (min < 1) return "a moment";
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

function updatedAgo(at: number, now: number): string {
  const sec = Math.max(0, (now - at) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
