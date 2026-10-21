/**
 * Catalog of editors / IDEs that LunoPeak knows how to launch through the
 * `open_path_in_editor` Tauri command. Keep ids in sync with the Rust spec
 * in `src-tauri/src/scanners/processes.rs`.
 *
 * Platform notes:
 *  - macOS: every editor falls back to `open -a "<App>"` if its CLI shim
 *    isn't on PATH, so launches almost always succeed.
 *  - Linux: relies on the editor's CLI being on PATH (`code`, `cursor`,
 *    `subl`, `zed`, …). Most distro packages install one. Flatpak / Snap
 *    builds may not — point the user at the distribution's CLI shim.
 *  - Windows: most CLIs ship as `.cmd` shims and Rust's `Command::new`
 *    doesn't honor PATHEXT, so the backend additionally probes `.cmd`,
 *    `.exe`, `.bat` per name. If the CLI shim isn't installed, run the
 *    editor's "Install '<name>' command in PATH" command from its palette.
 *  - Xcode is filtered out on non-mac platforms.
 */

export interface EditorOption {
  /** Stable id passed to the backend. */
  id: string;
  label: string;
  /** Short hint shown under the row in the picker. */
  hint: string;
}

export const EDITORS: EditorOption[] = [
  {
    id: "vscode",
    label: "VS Code",
    hint: "Microsoft Visual Studio Code",
  },
  {
    id: "cursor",
    label: "Cursor",
    hint: "AI code editor (cursor.com)",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    hint: "Google's agentic IDE",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    hint: "Codeium's AI IDE",
  },
  {
    id: "zed",
    label: "Zed",
    hint: "High-performance native editor",
  },
  {
    id: "sublime",
    label: "Sublime Text",
    hint: "Lightweight editor (subl)",
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    hint: "VS Code preview channel",
  },
  {
    id: "xcode",
    label: "Xcode",
    hint: "Apple's IDE — macOS only",
  },
  {
    id: "system",
    label: "System default",
    hint: "Open with the OS-registered handler",
  },
];

export function findEditor(id: string | null | undefined): EditorOption | null {
  if (!id) return null;
  return EDITORS.find((e) => e.id === id) ?? null;
}

export function editorLabel(id: string | null | undefined): string {
  return findEditor(id)?.label ?? "Editor";
}

/**
 * Filter the catalog to entries that work on the current platform. Pass
 * the result of `useQuery(queries.availableEditors)` so we honor what the
 * Rust side says is launchable here. "system" is always allowed.
 */
export function filterEditorsForPlatform(
  available: string[] | undefined,
): EditorOption[] {
  if (!available) return EDITORS;
  const allowed = new Set([...available, "system"]);
  return EDITORS.filter((e) => allowed.has(e.id));
}
