/** Shared wording helpers for the Costs and Cost detail pages. */

const FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"] as const;

/**
 * Plain model name: `claude-opus-5-5-20260901` → "Opus 5.5",
 * `gpt-5-codex` → "GPT-5 Codex". Unknown ids pass through.
 */
export function modelName(model: string): string {
  const id = model.toLowerCase().replace(/^claude-/, "").replace(/-\d{8}$/, "");
  for (const fam of FAMILIES) {
    // Both `opus-4-5` and the older `3-5-sonnet` orderings.
    const after = id.match(new RegExp(`${fam}-(\\d+)(?:-(\\d))?(?!\\d)`));
    const before = id.match(new RegExp(`(\\d+)(?:-(\\d))?-${fam}`));
    const m = after ?? before;
    const name = fam[0].toUpperCase() + fam.slice(1);
    if (m) return m[2] ? `${name} ${m[1]}.${m[2]}` : `${name} ${m[1]}`;
    if (id.includes(fam)) return name;
  }
  if (id.startsWith("gpt-")) {
    const [, ver, ...rest] = id.split("-");
    const tail = rest.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    return `GPT-${ver}${tail ? ` ${tail}` : ""}`;
  }
  return model;
}

/** Bar fill per model family, matching the provider accents. */
export function modelTone(model: string): string {
  const id = model.toLowerCase();
  if (id.includes("opus")) return "bg-orange-500";
  if (id.includes("sonnet")) return "bg-amber-500";
  if (id.includes("haiku")) return "bg-amber-400";
  if (id.includes("fable") || id.includes("mythos")) return "bg-orange-400";
  if (id.startsWith("gpt") || id.startsWith("o3") || id.startsWith("o4") || id.includes("codex")) {
    return "bg-emerald-500";
  }
  return "bg-zinc-400";
}

/** "Oct 31", or "Thursday, Oct 16" with `weekday`. */
export function monthDay(d: Date, weekday = false): string {
  return d.toLocaleDateString(undefined, {
    weekday: weekday ? "long" : undefined,
    month: "short",
    day: "numeric",
  });
}

/** "half of", "about a third of", "12% of" — for "… of everything you spent". */
export function shareOf(part: number, whole: number): string {
  if (whole <= 0) return "";
  const r = part / whole;
  if (r >= 0.97) return "nearly all of";
  if (r >= 0.45 && r <= 0.55) return "about half of";
  if (r >= 0.3 && r <= 0.36) return "about a third of";
  if (r >= 0.22 && r <= 0.28) return "about a quarter of";
  if (r < 0.01) return "less than 1% of";
  return `${Math.round(r * 100)}% of`;
}
