import { createContext, useContext, type ReactNode } from "react";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import { create } from "zustand";
import { cn } from "@/lib/utils";

/**
 * Building blocks for the Settings page: titled sections of divided rows,
 * pill option sets, and outbound link rows. Every row registers itself with
 * the "Search settings" filter — a row renders only when the query matches
 * its own text or its section's title, and sections / categories with no
 * visible rows hide themselves through `:has([data-setting-row])`.
 */

export const useSettingsSearch = create<{ query: string; setQuery: (q: string) => void }>(
  (set) => ({ query: "", setQuery: (query) => set({ query }) }),
);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function useMatches(text: string): boolean {
  const query = useSettingsSearch((s) => norm(s.query));
  const sectionMatched = useContext(SectionMatch);
  if (!query || sectionMatched) return true;
  return norm(text).includes(query);
}

/** True when the enclosing section's own title matched — show every row. */
const SectionMatch = createContext(false);

export function SettingsSection({
  title,
  caption,
  children,
  className,
}: {
  title?: string;
  caption?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const query = useSettingsSearch((s) => norm(s.query));
  const matched = Boolean(query && title && norm(title).includes(query));
  return (
    <section className={cn("flex flex-col gap-2 [&:not(:has([data-setting-row]))]:hidden", className)}>
      {title && (
        <div className="flex flex-col gap-0.5 px-0.5">
          <h3 className="m-0 text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
          {caption && (
            <p className="m-0 text-xs text-zinc-500 text-pretty dark:text-zinc-400">{caption}</p>
          )}
        </div>
      )}
      <div className="flex flex-col overflow-hidden rounded-xl border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-white/[0.035] [&>*+*]:border-t [&>*+*]:border-black/[0.05] dark:[&>*+*]:border-white/[0.06]">
        <SectionMatch.Provider value={matched}>{children}</SectionMatch.Provider>
      </div>
    </section>
  );
}

/**
 * One setting: 13px label, 12px explanation, control on the right. `below`
 * renders under the label (option sets, inputs). `keywords` adds search
 * terms that aren't visible.
 */
export function SettingRow({
  label,
  hint,
  control,
  below,
  keywords = "",
  leading,
  dimmed,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  control?: ReactNode;
  below?: ReactNode;
  keywords?: string;
  leading?: ReactNode;
  /** Fade a row whose parent switch is off. */
  dimmed?: boolean;
  className?: string;
}) {
  const text = [label, hint, keywords].filter((t) => typeof t === "string").join(" ");
  if (!useMatches(text)) return null;
  return (
    <div data-setting-row className={cn("flex flex-col gap-2 px-4 py-3", className)}>
      <div className={cn("flex items-center", leading ? "gap-3" : "gap-4")}>
        {leading}
        <div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", dimmed && "opacity-40")}>
          <span className="text-[13px] text-zinc-900 dark:text-zinc-100">{label}</span>
          {hint && (
            <span className="text-xs leading-[1.45] text-zinc-500 text-pretty dark:text-zinc-400">
              {hint}
            </span>
          )}
        </div>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {below && <div className={cn(dimmed && "pointer-events-none opacity-40")}>{below}</div>}
    </div>
  );
}

/** A free-form searchable block inside a section (previews, lists). */
export function SettingBlock({
  keywords,
  children,
  className,
}: {
  keywords: string;
  children: ReactNode;
  className?: string;
}) {
  if (!useMatches(keywords)) return null;
  return (
    <div data-setting-row className={cn("px-4 py-3", className)}>
      {children}
    </div>
  );
}

/** Pill option set shown under a row's label. */
export function OptionSet<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  mono,
}: {
  value: T;
  options: ReadonlyArray<{ id: T; label: ReactNode }>;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
  mono?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex w-fit max-w-full flex-wrap gap-1 rounded-[9px] bg-black/[0.04] p-[3px] dark:bg-white/[0.06]"
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] px-[11px] py-[5px] text-[12.5px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed",
              mono && "font-mono",
              active
                ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                : "text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.05] dark:hover:text-zinc-100",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Outbound link row: icon tile, label + hint, ↗. */
export function LinkRow({
  icon: Icon,
  label,
  hint,
  onClick,
  onMouseMove,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
  onMouseMove?: (e: React.MouseEvent) => void;
}) {
  if (!useMatches(`${label} ${hint}`)) return null;
  return (
    <button
      type="button"
      data-setting-row
      onClick={onClick}
      onMouseMove={onMouseMove}
      className="flex w-full items-center gap-3 px-4 py-[11px] text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
    >
      <IconTile icon={Icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[13px] text-zinc-900 dark:text-zinc-100">{label}</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
      </div>
      <ArrowUpRight size={12} strokeWidth={2} className="shrink-0 text-zinc-400" />
    </button>
  );
}

export function IconTile({ icon: Icon, tone }: { icon: LucideIcon; tone?: "green" }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-[7px]",
        tone === "green"
          ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
          : "bg-black/[0.045] text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-400",
      )}
    >
      <Icon size={15} strokeWidth={1.8} />
    </span>
  );
}

/** Text input styled like the prototype's fields. */
export const fieldClass =
  "flex items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[13px] focus-within:border-blue-500/60 dark:border-white/10 dark:bg-white/[0.04]";

/** "Warn at [slider] 80%" control used by alerts and budget. */
export function PercentSlider({
  value,
  onChange,
  label = "Warn at",
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3", disabled && "pointer-events-none opacity-40")}>
      <span className="whitespace-nowrap text-[12.5px] text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="lp-range w-full max-w-[280px]"
        style={{ ["--lp-range-pct" as string]: `${value}%` }}
      />
      <span className="w-10 text-[13px] font-semibold tabular-nums text-blue-700 dark:text-blue-400">
        {value}%
      </span>
    </div>
  );
}
