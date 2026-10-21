/**
 * Centralized class tokens for surface, border, and text styling.
 *
 * Reach for these instead of inlining `bg-white/[0.02]` etc. across views — it
 * keeps the visual language consistent and makes a global tweak (e.g. softening
 * every card border) a one-line change.
 *
 * Every entry pairs a light-mode value with a dark-mode value so themes flip
 * automatically. `dark:` is wired to `[data-theme="dark"]` in index.css.
 */
export const tokens = {
  bg: {
    base: "bg-zinc-50 dark:bg-zinc-950",
    /** Cards, raised surfaces */
    elevated: "bg-black/[0.02] dark:bg-white/[0.04]",
    /** Slightly stronger raised surface (e.g. tablists, segmented controls) */
    elevatedStrong: "bg-black/[0.04] dark:bg-white/[0.06]",
    /** Subtle hover bg for inline rows */
    hoverSubtle: "hover:bg-black/[0.04] dark:hover:bg-white/[0.04]",
    /** Sidebar — transparent so the OS material shows through */
    sidebar: "bg-transparent",
    /** Modals, popovers, toasts */
    overlay: "bg-white/95 dark:bg-zinc-900/95",
    /** Selected accent fill (tabs, pills) */
    selected: "bg-blue-500/12 dark:bg-blue-500/15",
  },
  border: {
    /** Hairline divider — barely visible */
    subtle: "border-black/[0.06] dark:border-white/[0.08]",
    /** Default card / input border */
    default: "border-black/[0.08] dark:border-white/[0.10]",
    /** Strong border — focus rings, active items */
    strong: "border-black/[0.12] dark:border-white/[0.14]",
    /** Lightest divider, used for inner separators */
    divider: "border-black/[0.04] dark:border-white/[0.05]",
  },
  text: {
    primary: "text-zinc-900 dark:text-zinc-50",
    secondary: "text-zinc-700 dark:text-zinc-200",
    tertiary: "text-zinc-600 dark:text-zinc-300",
    quaternary: "text-zinc-600 dark:text-zinc-300",
    quinary: "text-zinc-500 dark:text-zinc-400",
  },
  /** Used for category coding via the dot-color convention. */
  accent: {
    blue: "text-blue-600 dark:text-blue-400",
    green: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    rose: "text-rose-600 dark:text-rose-400",
  },
} as const;

/** Tone → solid dot color, used in StatCard / ListRow for category coding. */
export const toneDot = {
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  zinc: "bg-zinc-400 dark:bg-zinc-500",
} as const;

export type Tone = keyof typeof toneDot;
