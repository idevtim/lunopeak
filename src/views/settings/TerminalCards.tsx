import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { Switch } from "@/components/ui/Switch";
import { Button } from "@/components/ui/Button";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { Bone } from "@/components/ui/PageStates";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toastStore";
import { defaultStatuslinePrefs } from "@/lib/statusline";
import type {
  Settings,
  StatuslinePrefs,
  StatuslineSegmentId,
  StatuslineTone,
  TerminalIntegrations,
} from "@/types/api";
import { OptionSet, SettingBlock, SettingRow, SettingsSection } from "./primitives";

/**
 * Settings › Editors & terminal. Opt-ins that put LunoPeak's numbers inside
 * the agents' own terminal UIs: a Claude Code `statusLine` command (the app
 * binary run as `LunoPeak statusline`) and Codex's built-in `[tui]
 * status_line` items. State lives in those tools' config files, not LunoPeak
 * settings, so it's read back from disk rather than kept in the settings
 * store. What the Claude line *shows* is an ordinary LunoPeak setting
 * (`settings.statusline`), which the CLI reads from settings.json on every
 * repaint.
 */
export function TerminalCards({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: (s: Settings) => Settings) => void;
}) {
  const qc = useQueryClient();
  const status = useQuery(queries.terminalIntegrations);

  const onSuccess = (next: TerminalIntegrations) =>
    qc.setQueryData(queries.terminalIntegrations.queryKey, next);
  const setClaude = useMutation({
    mutationFn: api.setClaudeStatusline,
    onSuccess: (next, enabled) => {
      onSuccess(next);
      toast.success(
        enabled ? "Claude Code status line on" : "Claude Code status line off",
        enabled
          ? "Open sessions pick it up on their next message."
          : next.claude.otherCommand
            ? "Your previous status line is back."
            : undefined,
      );
    },
    onError: (e) => toast.error("Couldn't update Claude Code settings", String(e)),
  });
  const setCodex = useMutation({
    mutationFn: api.setCodexStatusline,
    onSuccess: (next, enabled) => {
      onSuccess(next);
      toast.success(
        enabled ? "Codex status line on" : "Codex status line off",
        "Takes effect in new Codex sessions.",
      );
    },
    onError: (e) => toast.error("Couldn't update Codex config", String(e)),
  });

  if (status.isError) {
    return (
      <SettingsSection title="Terminal status lines">
        <SettingRow
          label="Couldn't read your Claude Code and Codex settings"
          hint={String(status.error)}
          keywords="terminal status line claude codex"
          control={<Button onClick={() => void status.refetch()}>Try again</Button>}
        />
      </SettingsSection>
    );
  }
  if (!status.data) {
    return (
      <div className="flex flex-col gap-2 animate-lp-pulse">
        <Bone className="h-5 w-48 rounded-md" />
        <Bone className="h-36 rounded-xl" />
      </div>
    );
  }
  const { claude, codex } = status.data;
  const prefs = normalizePrefs(settings.statusline);
  const setPrefs = (patch: Partial<StatuslinePrefs>) =>
    update((cur) => ({ ...cur, statusline: { ...normalizePrefs(cur.statusline), ...patch } }));
  const canInstall = claude.available && !claude.blockedReason && !setClaude.isPending;

  return (
    <>
      <SettingsSection
        title="Claude Code status line"
        caption="A line under the prompt with this session’s context, your limits and cost. Runs locally on every message, with no network calls."
      >
        <SettingRow
          label="Show in Claude Code terminals"
          hint={
            <>
              Writes <Code>statusLine</Code> in <Code>{claude.settingsPath}</Code> and keeps a backup.
              Claude Code only runs status lines in folders you’ve trusted.
            </>
          }
          keywords="terminal status line statusline claude code"
          leading={<ProviderIcon provider="claude" size={16} className="shrink-0 text-zinc-500 dark:text-zinc-400" />}
          control={
            <Switch
              checked={claude.installed}
              disabled={!claude.available || (!claude.installed && !!claude.blockedReason) || setClaude.isPending}
              onChange={(v) => setClaude.mutate(v)}
              ariaLabel="Show in Claude Code terminals"
            />
          }
          below={claudeNotes(claude, () => setClaude.mutate(true))}
        />
        <SettingBlock keywords="status line preview terminal claude">
          {!claude.installed && (
            <Note warn className="mb-3">
              <span className="flex items-center justify-between gap-3">
                <span>Not showing in Claude Code yet. Your layout below is saved, but the status line is off.</span>
                {canInstall && (
                  <Button variant="primary" onClick={() => setClaude.mutate(true)}>
                    Turn on
                  </Button>
                )}
              </span>
            </Note>
          )}
          <TerminalPreview prefs={prefs} chained={claude.chainedCommand ?? claude.otherCommand} />
          <p className="m-0 mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            {claude.installed
              ? "Changes reach open sessions on their next repaint, no restart needed."
              : "Changes take effect once the status line is on."}{" "}
            The real context window it reports also makes the Live page’s context % exact.
          </p>
        </SettingBlock>
      </SettingsSection>

      <SegmentsSection prefs={prefs} onChange={setPrefs} />
      <StyleSection prefs={prefs} onChange={setPrefs} />

      <SettingsSection title="Codex status line">
        <SettingRow
          label="Show context and limits in Codex"
          hint={
            <>
              Codex can’t run a custom command, so this turns on its built-in model, context, 5-hour, weekly and
              branch items. Sets <Code>[tui] status_line</Code> in <Code>{codex.configPath}</Code> and leaves the
              rest of the file alone. Takes effect in new Codex sessions.
            </>
          }
          keywords="terminal status line codex tui config"
          leading={<ProviderIcon provider="codex" size={16} className="shrink-0 text-zinc-500 dark:text-zinc-400" />}
          control={
            <Switch
              checked={codex.installed}
              disabled={!codex.available || setCodex.isPending}
              onChange={(v) => setCodex.mutate(v)}
              ariaLabel="Show context and limits in Codex"
            />
          }
          below={
            !codex.available ? (
              <Note>Codex isn’t set up on this computer.</Note>
            ) : !codex.installed && codex.currentItems.length > 0 ? (
              <Note>
                Your current items (<Code>{codex.currentItems.join(", ")}</Code>) are saved and put back if you
                turn this off.
              </Note>
            ) : null
          }
        />
      </SettingsSection>
    </>
  );
}

/** Caveats under the Claude toggle, or null when there's nothing to say. */
function claudeNotes(claude: TerminalIntegrations["claude"], onRepair: () => void) {
  const notes: React.ReactNode[] = [];
  if (!claude.available) notes.push(<Note key="na">Claude Code isn’t set up on this computer.</Note>);
  if (claude.blockedReason && !claude.installed)
    notes.push(
      <Note key="blocked" warn>
        {claude.blockedReason}
      </Note>,
    );
  if (claude.stalePath)
    notes.push(
      <Note key="stale" warn>
        <span className="flex items-center justify-between gap-3">
          <span>The status line points at a LunoPeak that has moved or been replaced.</span>
          <Button onClick={onRepair}>Repair</Button>
        </span>
      </Note>,
    );
  if (!claude.installed && claude.otherCommand)
    notes.push(
      <Note key="other">
        You already have a status line (<Code>{claude.otherCommand}</Code>). LunoPeak keeps it, adds its line
        underneath, and puts it back if you turn this off.
      </Note>,
    );
  if (claude.installed && claude.chainedCommand)
    notes.push(
      <Note key="chained">
        Also running your previous status line: <Code>{claude.chainedCommand}</Code>
      </Note>,
    );
  if (notes.length === 0) return null;
  return <div className="flex flex-col gap-2">{notes}</div>;
}

function TerminalPreview({ prefs, chained }: { prefs: StatuslinePrefs; chained: string | null }) {
  // Keep showing the previous line while the next one renders, so dragging a
  // threshold doesn't flash an empty terminal.
  const preview = useQuery({ ...queries.statuslinePreview(prefs), placeholderData: keepPreviousData });
  const spans = preview.data ?? [];
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-zinc-950 px-3.5 py-3 font-mono text-[11.5px] leading-relaxed dark:border-white/[0.08]">
      <div className="text-zinc-500">
        <span className="text-zinc-300">&gt;</span> fix the flaky auth test
      </div>
      {chained && <div className="truncate text-zinc-500">…your current status line…</div>}
      <div className="truncate whitespace-pre text-zinc-200" title={spans.map((s) => s.text).join("")}>
        {spans.length === 0 ? (
          <span className="text-zinc-600">Nothing selected. Turn on a segment below.</span>
        ) : (
          spans.map((s, i) => (
            <span key={i} className={prefs.color ? toneClass[s.tone] : s.tone === "dim" ? "text-zinc-500" : undefined}>
              {s.text}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

/** Terminal-ish ANSI colors for the preview (dim = SGR 2, then 32/33/31). */
const toneClass: Record<StatuslineTone, string | undefined> = {
  plain: undefined,
  dim: "text-zinc-500",
  ok: "text-emerald-400",
  warn: "text-amber-300",
  danger: "text-rose-400",
};

// ── Line editor ──────────────────────────────────────────────────────

const SEGMENT_META: Record<StatuslineSegmentId, { label: string; hint: string }> = {
  context: { label: "Context", hint: "How full this session's context window is" },
  fiveHour: { label: "5-hour limit", hint: "Your plan's rolling session window" },
  weekly: { label: "Weekly limit", hint: "Your plan's all-models weekly window" },
  modelLimits: { label: "Model limits", hint: "Separate weekly caps like Fable" },
  sessionCost: { label: "Session cost", hint: "What this session has cost so far" },
  todayCost: { label: "Today's cost", hint: "All tools today, while LunoPeak is running" },
  model: { label: "Model", hint: "The model this session is on" },
  folder: { label: "Folder", hint: "The session's working folder" },
  branch: { label: "Git branch", hint: "Current branch, or commit when detached" },
};

/**
 * Settings saved by an older build may predate a segment; append any that
 * are missing (off) so they show up here to be switched on.
 */
function normalizePrefs(p: StatuslinePrefs | undefined): StatuslinePrefs {
  const base = { ...defaultStatuslinePrefs, ...p };
  const known = new Set(Object.keys(SEGMENT_META));
  const seen = new Set<string>();
  const segments = base.segments.filter((s) => {
    const ok = known.has(s.id) && !seen.has(s.id);
    seen.add(s.id);
    return ok;
  });
  for (const d of defaultStatuslinePrefs.segments) {
    if (!seen.has(d.id)) segments.push({ id: d.id, enabled: false });
  }
  return { ...base, segments };
}

type PrefsProps = { prefs: StatuslinePrefs; onChange: (patch: Partial<StatuslinePrefs>) => void };

function SegmentsSection({ prefs, onChange }: PrefsProps) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...prefs.segments];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ segments: next });
  };
  const toggle = (i: number, enabled: boolean) =>
    onChange({ segments: prefs.segments.map((s, k) => (k === i ? { ...s, enabled } : s)) });

  return (
    <SettingsSection
      title="What the Claude Code line shows"
      caption="Switch segments on and use the arrows to change their order."
    >
      {prefs.segments.map((seg, i) => {
        const meta = SEGMENT_META[seg.id];
        return (
          <SettingRow
            key={seg.id}
            className="py-2.5"
            label={meta.label}
            hint={meta.hint}
            keywords="status line segment"
            leading={<Switch checked={seg.enabled} onChange={(v) => toggle(i, v)} ariaLabel={`Show ${meta.label}`} />}
            control={
              <div className="flex gap-0.5">
                <IconButton label={`Move ${meta.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ChevronUp size={14} />
                </IconButton>
                <IconButton
                  label={`Move ${meta.label} down`}
                  disabled={i === prefs.segments.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ChevronDown size={14} />
                </IconButton>
              </div>
            }
          />
        );
      })}
      <SettingBlock keywords="status line reset default layout" className="py-2.5">
        <Button variant="ghost" onClick={() => onChange(defaultStatuslinePrefs)}>
          Reset the line to default
        </Button>
      </SettingBlock>
    </SettingsSection>
  );
}

function StyleSection({ prefs, onChange }: PrefsProps) {
  const contextOn = prefs.segments.some((s) => s.id === "context" && s.enabled);
  return (
    <SettingsSection title="How the Claude Code line looks">
      <SettingRow
        label="Context bar"
        hint="A 10-cell bar before the context percentage."
        keywords="status line"
        dimmed={!contextOn}
        control={
          <Switch
            checked={prefs.contextBar}
            disabled={!contextOn}
            onChange={(v) => onChange({ contextBar: v })}
            ariaLabel="Context bar"
          />
        }
      />
      <SettingRow
        label="Context tokens"
        hint="“340K/1M” after the context percentage."
        keywords="status line"
        dimmed={!contextOn}
        control={
          <Switch
            checked={prefs.contextTokens}
            disabled={!contextOn}
            onChange={(v) => onChange({ contextTokens: v })}
            ariaLabel="Context tokens"
          />
        }
      />
      <SettingRow
        label="Colors"
        hint="Green, then yellow and red as numbers climb."
        keywords="status line colour"
        control={<Switch checked={prefs.color} onChange={(v) => onChange({ color: v })} ariaLabel="Colors" />}
      />
      <SettingRow
        label="Reset countdown"
        hint="When a limit shows the time until it resets."
        keywords="status line"
        below={
          <OptionSet
            value={prefs.resetHint}
            onChange={(v) => onChange({ resetHint: v })}
            ariaLabel="Reset countdown"
            options={[
              { id: "nearLimit", label: "Near limit" },
              { id: "always", label: "Always" },
              { id: "never", label: "Never" },
            ]}
          />
        }
      />
      <SettingRow
        label="Separator"
        hint="Between segments."
        keywords="status line"
        below={
          <OptionSet
            value={prefs.separator}
            onChange={(v) => onChange({ separator: v })}
            ariaLabel="Separator"
            mono
            options={[
              { id: "bar", label: "│" },
              { id: "dot", label: "·" },
              { id: "pipe", label: "|" },
              { id: "space", label: "space" },
            ]}
          />
        }
      />
      <SettingRow
        label="Thresholds"
        hint="Percent at which numbers turn yellow, then red. Also sets when the countdown appears."
        keywords="status line warn danger"
        control={
          <>
            <PercentInput
              label="Yellow at"
              value={prefs.warnPercent}
              min={1}
              max={prefs.dangerPercent - 1}
              tone="text-amber-600 dark:text-amber-400"
              onChange={(v) => onChange({ warnPercent: v })}
            />
            <PercentInput
              label="Red at"
              value={prefs.dangerPercent}
              min={prefs.warnPercent + 1}
              max={100}
              tone="text-rose-600 dark:text-rose-400"
              onChange={(v) => onChange({ dangerPercent: v })}
            />
          </>
        }
      />
    </SettingsSection>
  );
}

function PercentInput({
  label,
  value,
  min,
  max,
  tone,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  tone: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <span className={tone}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="w-14 rounded-md border border-black/10 bg-white px-2 py-1 text-right text-xs tabular-nums text-zinc-800 outline-none focus:border-blue-500/60 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200"
      />
      <span>%</span>
    </label>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 disabled:pointer-events-none disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
    >
      {children}
    </button>
  );
}

function Note({ children, warn, className }: { children: React.ReactNode; warn?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-lg border px-3 py-2 text-xs",
        warn
          ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
          : "border-black/[0.06] bg-black/[0.02] text-zinc-600 dark:border-white/[0.07] dark:bg-white/[0.03] dark:text-zinc-400",
        className,
      )}
    >
      {warn && <AlertTriangle size={13} className="mt-px shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-black/[0.05] px-1 py-px font-mono text-[11px] break-all dark:bg-white/[0.08]">
      {children}
    </code>
  );
}
