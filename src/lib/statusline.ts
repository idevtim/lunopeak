import type { StatuslinePrefs } from "@/types/api";

/** Mirrors `StatuslinePrefs::default()` in `src-tauri/src/models.rs`. */
export const defaultStatuslinePrefs: StatuslinePrefs = {
  segments: [
    { id: "context", enabled: true },
    { id: "fiveHour", enabled: true },
    { id: "weekly", enabled: true },
    { id: "modelLimits", enabled: true },
    { id: "sessionCost", enabled: true },
    { id: "todayCost", enabled: true },
    { id: "model", enabled: false },
    { id: "folder", enabled: false },
    { id: "branch", enabled: false },
  ],
  contextBar: true,
  contextTokens: true,
  color: true,
  warnPercent: 70,
  dangerPercent: 85,
  resetHint: "nearLimit",
  separator: "bar",
  owl: true,
};

/** Mirrors `OWL_FLAP` in `src-tauri/src/statusline.rs`: one frame a second while working. */
export const OWL_FLAP = ["\\{o,o}/", "/{o,o}\\", "\\{o,o}/", "/{o,o}\\", "\\{o,o}/", "/{-,-}\\"];
