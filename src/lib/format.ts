const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdCompactFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCount(n: number) {
  return compactFormatter.format(n);
}

export function formatUsd(n: number, compact = false) {
  return (compact ? usdCompactFormatter : usdFormatter).format(n);
}

export function formatRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Verbose variant: "38 minutes ago", "6 weeks ago", "4 years, 4 months ago".
 * Used in views that want a humanised timestamp inline with prose.
 */
export function formatLongRelativeTime(timestamp: number) {
  const diff = Date.now() - timestamp;
  if (diff < 0) return "just now";
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec} ${sec === 1 ? "second" : "seconds"} ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} ${day === 1 ? "day" : "days"} ago`;
  const week = Math.round(day / 7);
  if (week < 5) return `${week} ${week === 1 ? "week" : "weeks"} ago`;
  const totalMonths = Math.round(day / 30);
  if (totalMonths < 12) {
    return `${totalMonths} ${totalMonths === 1 ? "month" : "months"} ago`;
  }
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const yPart = `${years} ${years === 1 ? "year" : "years"}`;
  if (months === 0) return `${yPart} ago`;
  return `${yPart}, ${months} ${months === 1 ? "month" : "months"} ago`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number) {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (hr > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * Clock-style duration. Returns "MM:SS" for under an hour, otherwise "H:MM:SS"
 * (or "HH:MM:SS" when the hour count itself reaches two digits).
 */
export function formatClockDuration(seconds: number) {
  const sec = Math.max(0, Math.floor(seconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/** "2h 10m", "3d 4h", "12m" — for "Resets in …" captions. */
export function formatTimeUntil(epochSeconds: number, now = Date.now()) {
  const min = Math.max(0, Math.round((epochSeconds * 1000 - now) / 60000));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/** `plural(3, "file")` → "3 files"; `plural(1, "commit")` → "1 commit". */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
