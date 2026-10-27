# LunoPeak — Claude Code instructions

Local-first dev dashboard. Tauri 2 (Rust shell) + React 19 + TypeScript + Vite + Tailwind 4.

## Commands

- `npm run dev` — Vite-only. UI mounts with `api.*` fallbacks; no Rust runtime.
- `npm run tauri:dev` — full app. First Rust compile takes minutes; subsequent runs are fast.
- `npm run typecheck` — `tsc -b --noEmit`.
- `npm run build` — `tsc -b && vite build`.
- `npm run tauri:build` — platform bundles to `src-tauri/target/release/bundle/`. Unsigned, no release.
- `npm run dist:mac` / `dist:win` / `dist:nix` — full end-to-end release per platform: preflight (version triple + `release-notes/vX.Y.Z.md`), build, sign, and draft the GitHub release. `build:mac` / `build:win` / `build:linux` are aliases.
- `dist:nix` dispatches on the host: `build-linux.sh` natively on Linux, `docker-build-linux.sh` in an amd64 container on macOS. `-- --build-only` skips the tag/upload (`dist:nix:docker` forces the container path). See [RELEASE.md](RELEASE.md#building-linux-from-macos).

## Architecture

- **Routing single source of truth:** `src/routes.ts`. Sidebar entries, hash routes, and view registration all derive from it. Add new views by registering them here.
- **Typed IPC boundary:** `src/lib/tauri.ts` exposes an `api` object that invokes Rust commands in `src-tauri/src/commands.rs`. When running outside the Tauri runtime (`npm run dev`), `api.*` returns inline fallbacks so the UI still mounts in a browser tab.
- **Serde contract:** Rust models in `src-tauri/src/models.rs` use `#[serde(rename_all = "camelCase")]`. Their TS mirrors live in `src/types/api.ts` — keep them 1:1 when editing either side.
- **Every view is wired.** All sidebar destinations render live data. The `_placeholder` view is kept only as the fallback for a route that lacks an implementation.
- **Multi-agent live activity:** `LiveEvent` / `SessionLiveState` carry an `agent` field (`LiveAgent = "claude" | "codex" | "cursor"`). The Claude scanner reads `~/.claude/projects/`; the Codex scanner (`scanners/live_codex.rs`) reads `~/.codex/sessions/**/rollout-*.jsonl`; the Cursor scanner (`scanners/live_cursor.rs`) opens Cursor's SQLite chat DB at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (and platform equivalents) read-only — mining `ItemTable["composer.composerHeaders"]` for sessions and `cursorDiskKV` for bubble-by-bubble messages. Cursor doesn't expose structured tool logs, so events surface as generic Chat / User messages. `commands::get_live_activity` merges all three feeds, gated on `claude_enabled` / `codex_enabled` / `cursor_enabled` (see `settings::AgentSources`). In `LiveView.tsx`, sessions are bucketed by `(cwd, agent)` so a codex process never shows a claude session's last action when multiple agents run in the same folder.
- **Subagent spend rolls up:** Claude Code writes each subagent run to `<project>/<session-id>/subagents/agent-*.jsonl`; the parent transcript records only the result, not the tokens. `sessions::subagent_files` finds them, and both `sessions::scan_all` (cost view, replay, today's total) and `usage::claude_usage` (5h/7d windows) fold their tokens and cost into the parent. Messages and tool stats stay main-thread. The session cache stamp covers subagent mtimes, so a finishing subagent re-parses its parent.
- **Session parse cache persists across launches:** `sessions::scan_all` keeps parsed sessions keyed by transcript path and a `Stamp` (newest mtime across the main and subagent transcripts, plus the subagent count), re-parses only stale entries in parallel, and saves them to `sessions-cache.json` in the app dir. The window and menu-bar processes share that file, so writes go to a pid-suffixed temp file and are renamed into place. `DISK_CACHE_VERSION` includes `CARGO_PKG_VERSION`, so every release re-parses once; bump its `/N` suffix for parser changes made between releases. `usage::claude_usage` keeps its own in-memory mtime cache (`CLAUDE_TURNS`) for the 5h/7d windows.
- **Per-session context %:** `commands::get_live_contexts` → `LiveContext` rows (Live view, tray "Running now", dashboard). Claude maps pid → session exactly via `~/.claude/sessions/<pid>.json` (stale files outlive their process — liveness is checked), then tail-reads the transcript's last main-chain assistant turn: `input + cache_creation + cache_read` over a model-inferred window (`live::claude_context_window` — transcripts don't record it). Codex uses the rollout's last `token_count` (`last_token_usage.total_tokens / model_context_window`), paired to running codex processes by cwd. Cursor uses per-composer `contextUsagePercent`.
- **Terminal status lines (`src-tauri/src/statusline.rs`):** the app binary doubles as Claude Code's `statusLine` command — `main.rs` dispatches `LunoPeak statusline [--chain]` before any Tauri setup (keep it that way; it runs on every repaint, ~10ms). It renders from stdin + app files only (`usage-cache.json` for Fable, `statusline-snapshot.json` for today's cost, refreshed by the tray loop), never the network, and records each session's real window to `claude-contexts/<session_id>.json`, which `live::contexts` prefers over the model heuristic. Layout comes from `settings.statusline` (`StatuslinePrefs`: segment order/on-off, style, thresholds), which the CLI reads straight out of the app's settings.json; `render_spans` returns toned spans that the CLI turns into ANSI and Settings renders as its live preview (`preview_statusline`; `demoFixtures.previewStatusline` mirrors it for browser mode). Install/uninstall edits `~/.claude/settings.json` (chaining + restoring any existing status line) and `~/.codex/config.toml` `[tui] status_line` via `toml_edit` (Codex has no custom-command status line).
- **Process relabeling:** `scanners::processes::TARGET_NAMES` is `["claude", "codex", "cursor", "cline"]`. `match_target` returns the display name. When the match comes from an argv basename (a Node CLI like the `@openai/codex` or `@anthropic-ai/claude-code` npm package, where `proc.name()` is "node"), the row is relabeled to the matched target ("codex" / "claude"). Direct matches on process / exe basename keep `proc.name()` verbatim. Cursor's macOS helper fan-out (Renderer, GPU, Plugin) is collapsed into a single "Cursor" row via `collapse_helpers` — the top-level `Cursor.app` process has cwd `/Applications` and gets filtered by `is_project_cwd`, so without keeping helpers we'd see no Cursor row at all.

## App icon

Two pipelines, one per family of platforms:

- **Windows / Linux + legacy macOS** — `src-tauri/icons/source.png` (1024×1024 raster) → `npm run icons` → the PNG/`.icns`/`.ico` set listed in `tauri.conf.json`'s `bundle.icon`.
- **macOS 26+ (Liquid Glass)** — `src-tauri/icons/LunoPeak.icon/`, an Icon Composer bundle: `icon.json` + three flat SVG layers in `Assets/`. The glass comes from `icon.json`, not the artwork — a `fill` gradient for the sky, a flat back group (`specular: false`) holding moon and mountains, and a `glass: true` group holding the owl. Layers must stay **flat, shadowless, and full-bleed 1024×1024**: the system supplies the squircle, the shadow, the refraction and the specular pass, so anything baked into the art fights it.

macOS renders a different variant per appearance (Default, Dark, Clear ×2, Tinted ×2). By default it recolours unspecialized back-group layers from the `fill` gradient, which in Dark turns the moon navy — so the Moon layer pins `fill-specializations` (solid cream) and `opacity-specializations` (1.0) for `appearance: "dark"`. Those are per-layer arrays; an entry with no `appearance` key is the default. The full vocabulary (`hidden-`, `position-`, `specular-`, `blend-mode-`, … `-specializations`) is in `IconComposerFoundation`. Clear and Tinted are deliberately left automatic — they're meant to be uniform.

`scripts/embed-glass-icon.sh` compiles the bundle with `xcrun actool` (standalone — no Xcode project needed) and injects `Assets.car` + `CFBundleIconName` into the built `.app`, overwriting Tauri's flat `icon.icns` with actool's flattened fallback for pre-26 systems. `build-dmg.sh` calls it **before** `embed-menubar-helper.sh`, whose re-seal covers the modified `Contents/`.

`npm run icons:mac` renders every appearance to `src-tauri/icons/.preview/` and opens it. It shells out to Icon Composer's `ictool` by absolute path on purpose — **not** `xcrun ictool`, which resolves to a same-named actool sibling that has no `--export-image`, reports the unknown argument in a plist, and still exits 0. Test for the output file, never the exit code.

## Conventions

### Skeleton loading
Every async view exports a `<ViewNameSkeleton />` matching the shape of its real content. Views call `useDelayedLoading(isLoading)` so the skeleton only renders if data hasn't arrived within ~200ms — this avoids flash on fast loads. See `src/hooks/useDelayedLoading.ts` and `ReadoutSkeleton` / `RepoListSkeleton` for the pattern.

### UI primitives
Reach for existing components in `src/components/ui/` (`Skeleton`, `StatCard`, `SectionCard`, `ListRow`, `Badge`, `Button`) before adding new ones. Charts go through `src/components/charts/BarChart` — a thin-bar variant of Recharts. Layout chrome lives in `src/components/layout/` (`TitleBar`, `Sidebar`, `AppShell`).

### State
TanStack Query for anything backed by `api.*`. Zustand for ephemeral UI state. Don't introduce React Context for shared state.

## Gotchas

- Tauri capabilities are explicit — new IPC commands must be allowed in `src-tauri/capabilities/default.json` or they fail at runtime.
- Icons are committed (all of `src-tauri/icons/`), so a fresh clone builds. Regenerate with `npm run icons`, never `npx @tauri-apps/cli icon` directly — the CLI's `.ico` omits the 128px frame that Windows 11 picks for several shell surfaces, and `build-icons.sh` rebuilds it with ImageMagick.
- `tsconfig.tsbuildinfo` is gitignored but can cause stale build state — delete it if `tsc -b` behaves oddly.
- The frontend must keep working in plain browser mode (no Tauri). When adding `api.*` calls, also add a sensible fallback in `src/lib/tauri.ts`.
