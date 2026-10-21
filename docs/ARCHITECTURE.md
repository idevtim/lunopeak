# LunoPeak architecture

How LunoPeak is put together, for anyone changing it. The user-facing overview is the [README](../README.md); the short map for coding agents is [`CLAUDE.md`](../CLAUDE.md).

## Stack

- **Shell:** Tauri 2 (Rust) with tray icon, window-state, and auto-updater plugins
- **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS 4
- **State:** TanStack Query + Zustand
- **Storage:** JSON-backed settings + snapshots; API keys in the OS keychain
- **Charts:** Recharts (custom `BarChart`, `Heatmap`, `Sparkbars`, `Sparkline`)

## Status

All 25 sidebar destinations are wired and rendering real data — Dashboard, Assistant, Live, Sessions, Transcripts, Tools, Costs, Repos, Work Graph, Timeline, Diffs, Repo Pulse, Setup, Skills, Agents, Memory, Hooks, Hygiene, Lint, Deps, Env, Ports, Snapshots, Worktrees, Settings (plus deep-link-only Session Replay and Repo Detail, for 27 live views in total). The `_placeholder` view is kept as the fallback for any route that ever lacks a live implementation.

## Prerequisites

- Rust (stable) — `rustup` is fine
- Node 20+ (this repo was scaffolded against Node 24)
- Platform deps for Tauri — see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
- App icons are committed, so a fresh clone builds. To regenerate them from `src-tauri/icons/source.png`, run `npm run icons` (see `CLAUDE.md` → App icon)

## Develop

```bash
npm install
npm run tauri:dev
```

The first Rust compile will take a few minutes. Subsequent runs are fast.

`npm run dev` runs Vite alone — the UI mounts in a browser tab and `api.*` calls return inline fallbacks defined in `src/lib/tauri.ts`.

## Build

```bash
npm run tauri:build
```

Outputs unsigned platform-native bundles to `src-tauri/target/release/bundle/`.

For a real release, use the per-platform `dist:*` scripts. Each one runs end to end — preflight (version triple matches, `release-notes/vX.Y.Z.md` exists), build, sign, and draft the GitHub release:

```bash
npm run dist:mac   # notarized universal macOS DMG      (scripts/build-dmg.sh)
npm run dist:win   # signed NSIS installers, x64 + arm64 (scripts/build-windows.ps1) — Windows host only
npm run dist:nix   # deb, rpm, AppImage                  (scripts/dist-linux.sh)
```

`dist:nix` dispatches on the host: it runs `build-linux.sh` natively on Linux, and `docker-build-linux.sh` — the same script inside an amd64 Ubuntu container — on macOS. Pass `-- --build-only` to produce bundles without tagging or uploading. `build:mac` / `build:win` / `build:linux` remain as aliases.

For signed, auto-updating release builds (CI workflow, signing keys, GitHub secrets, `latest.json` shape, in-app prompt behavior), see [`RELEASE.md`](../RELEASE.md). Per-version notes go in `release-notes/`.

## Project layout

```
src/                  # React frontend
  App.tsx             # shell + hash router + tray nav listener
  routes.ts           # sidebar/router config (single source of truth)
  components/
    layout/           # AppShell, Sidebar, WindowControls
    ui/               # Skeleton, StatCard, SectionCard, ListRow, Badge,
                      # Button, Switch, LiveDot, Toaster
    charts/           # BarChart, Heatmap, Sparkbars, Sparkline
    BootSplash, ErrorBoundary, GlobalErrorOverlay,
    UpdateBanner, UpdateAutoCheckPrompt, UsageLimitsCard
  hooks/              # useDelayedLoading, useHashRoute, useTheme,
                      # useBudgetAlerts, useBootReady, usePlatform,
                      # useWindowDrag
  views/              # one folder per route (each ships its own Skeleton)
  lib/                # tauri.ts (typed IPC), queries.ts (TanStack keys),
                      # boot, format, tokens, utils, assistantTools,
                      # providers/
  types/              # frontend mirror of Rust models
src-tauri/
  src/
    lib.rs            # Tauri builder + plugin registration
    commands.rs       # invoke handlers
    models.rs         # serde types (mirrored in src/types/api.ts)
    settings.rs       # local JSON-backed settings
    pricing.rs        # token/cost pricing tables
    tray.rs           # tray icon menu + navigation events
    statusline.rs     # `LunoPeak statusline` subcommand + installers
    scanners/         # git, git_log, github, sessions, live, live_codex,
                      # live_cursor, ports, processes, health, install,
                      # snapshots, usage, audit, status, config, codex,
                      # codex_web, cursor_web
  tauri.conf.json
  capabilities/default.json
release-notes/        # per-version notes consumed by the updater
scripts/              # build helpers (build-dmg.sh, build-windows.ps1,
                      # dist-windows.mjs, dist-linux.sh, build-linux.sh,
                      # docker-build-linux.sh, build-icons.sh, dev-*)
```

## Skeleton loading pattern

Every async view exports a `<ViewNameSkeleton />` matching the shape of the real content. Views use `useDelayedLoading(isLoading)` to avoid flash for fast loads (<200 ms) and only show the skeleton if the data hasn't arrived in time. See `src/hooks/useDelayedLoading.ts` and the `DashboardSkeleton` / `CostsSkeleton` examples.

## Live activity

The Live view watches two roots: `~/.claude/projects/` (Claude Code) and `~/.codex/sessions/` (Codex CLI rollouts). Each emitted `LiveEvent` / `SessionLiveState` is tagged with `agent: "claude" | "codex"`, and the frontend buckets sessions by `(cwd, agent)` so a codex process running in the same folder as a claude session shows its own activity, not the other agent's. Processes whose `proc.name()` is "node" but whose argv carries a matching CLI basename (e.g. `node /…/bin/codex`) are relabeled to the target name in the process scanner.

`scanners::live::contexts()` pairs each running process with its conversation and reports context fill. Claude processes are matched by PID through the transcript, so two sessions in the same folder are told apart exactly; Codex records no process/conversation link, so each Codex process is paired with the newest conversation in its folder.

## Codex data sources

Codex 0.163 changed both halves of what LunoPeak reads.

**Rollouts are zstd-compressed.** `~/.codex/sessions/.../rollout-*.jsonl` became `rollout-*.jsonl.zst`, and Codex rewrote existing files too, so the whole history went unreadable at once. `scanners::codex` accepts either extension and decodes `.zst` through `ruzstd` — a pure-Rust decoder, chosen to keep the build free of a C toolchain for libzstd. The line format inside is unchanged.

**Plan limits come from the network now.** Codex stopped leaving its `codex.rate_limits` payloads in `logs_2.sqlite` (only the event name is logged), and rollouts only carry a `rate_limits` block for turns that ran locally — so between sessions there is no local copy of the live numbers. `scanners::codex_web` asks the same endpoint the Codex CLI reads for `/status`, using the ChatGPT sign-in Codex keeps in `~/.codex/auth.json`.

That token is **read, never refreshed**: refresh tokens rotate, and spending one here would sign the user's Codex out. Codex refreshes it on its next run. Responses are cached with three TTLs — a few minutes on success, a minute on a network blip or 5xx, and a long backoff when signed out, lapsed, or rate-limited, since nothing changes until Codex runs again. On failure `usage::codex_usage` falls back to whatever Codex last wrote locally. Disabling Codex in Settings stops the request entirely.

## Cost model

`src-tauri/src/pricing.rs` holds the per-model rate tables; `cost_of(model, usage, ts_millis)` prices a single assistant turn. Two wrinkles:

- **Haiku 5.5 is priced by prompt length** — the first Claude model where the rate depends on request size. Past `HAIKU_5_5_LONG_THRESHOLD` (100K) the whole turn bills at the long-prompt tier, and "prompt length" is the entire input side: fresh input + cache reads + cache writes.
- **Cache writes split by TTL.** `usage.cache_creation` is the 5m+1h total, so the 1h portion is subtracted out and each half bills at its own rate.

`ts_millis` is threaded through from the scanners even though no Anthropic rate is time-boxed today (Sonnet 5's introductory price became its permanent one), so a future dated change slots into `cost_of` without touching callers.

## Terminal status line

`src-tauri/src/statusline.rs` backs both halves of `Settings → Terminal`.

**Claude Code** runs a user-configured command on every repaint and pipes it the session as JSON on stdin. The app binary doubles as that command — `main.rs` intercepts `argv[1] == "statusline"` before the Tauri runtime starts and exits through `statusline_cli`, so the same executable serves the GUI and the status line. One line comes back: context fill, the plan's 5h / weekly windows, per-model weekly caps, and cost. Everything is read from stdin or from files the app already keeps on disk, so a repaint never hits the network.

Each run also records that session's **authoritative** context window under `contexts_dir()`, keyed by session id. Transcripts don't carry the window size, so `scanners::live` otherwise infers it from the model name via `claude_context_window` (1M for the Fable, Mythos, Opus 5, Sonnet 5 and Haiku 5 families, plus Opus 4.6-4.8, Sonnet 4.6, and any model tagged `[1m]`; 200K for older models; anything already past 200K is treated as 1M whatever the model says). With a record on disk it uses the number Claude Code itself reported.

**Codex** can't run a custom command in its status line — only built-in item ids under `[tui] status_line` — so the Codex half just opts the user into the built-in context and limit items.

Both installers edit the user's own config files and preserve what was there: an existing Claude status line is chained (it runs first and its output is kept above ours) and restored on uninstall, and a previous Codex item list is saved and put back.

## Assistant providers

The Assistant talks to five providers, one module each under `src/lib/providers/`: Anthropic, OpenAI, Gemini, xAI, and Ollama. Requests go straight from the user's machine to the vendor endpoint — no LunoPeak server sits in the path — and API keys are written to the OS keychain by `src-tauri/src/settings.rs` (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux), never to `settings.json`. Curated model lists live in `PROVIDER_MODELS` in `src/lib/providers/index.ts`; Ollama's is deliberately empty and fetched from the local daemon's `/api/tags` at runtime. Every provider receives the same tool definitions from `src/lib/assistantTools.ts`, so tool use behaves the same whichever model is answering.

## Open in editor

Skills, Agents, Memory, Hooks, Live processes, and Repo Detail all surface a one-click "Open" affordance. The catalog of editors lives in `src-tauri/src/scanners/processes.rs` (the canonical `EditorSpec` list) and is mirrored in `src/lib/editors.ts`. Each spec carries a CLI command list, an optional macOS `.app` bundle name, and a platform mask; the Rust side launches in this order:

1. Try each CLI command on PATH. On Windows we also try `<cli>.cmd`, `<cli>.exe`, and `<cli>.bat` because `Command::new` doesn't honor `PATHEXT`.
2. On macOS, fall back to `open -a "<App Name>"` so installs without a CLI shim still launch.
3. Otherwise, return a friendly error pointing the user at the editor's "Install '<cli>' command in PATH" palette command.

The editor id `"system"` (or `null`) bypasses this path and opens via the OS's file handler (`open` / `xdg-open` / `cmd /C start`). The `get_available_editors` command returns the platform-filtered id list so the picker hides Mac-only entries (Xcode) on Windows / Linux.

When the user has no `editor.defaultEditor` set, the first click on any "Open" button pops the global `EditorPicker` modal (mounted in `App.tsx`, driven by `useEditorPickerStore`). Picking an editor with "Remember as default" checked persists it through `api.updateSettings` so future clicks open directly.

## Sidebar customization

`Settings → Appearance → Sidebar` opens a dialog (`SidebarCustomizer`) for hiding/showing items and reordering them. Reordering uses pointer events — not the HTML5 drag-and-drop API — because Tauri's webview intercepts native drag events for OS-level file drops. The grip handle on each row captures pointerdown, document-level pointermove uses `elementFromPoint` to hit-test the row under the cursor, and pointerup splices the dragged route into the new position. Reorders are restricted to the same section so the section grouping defined in `routes.ts` stays intact. The committed order lives in `settings.sidebarOrder`; the Sidebar component sorts each section's routes by it on render.

## Tauri ↔ React contract

Frontend talks to Rust via `src/lib/tauri.ts`'s typed `api` object, with TanStack Query keys centralized in `src/lib/queries.ts`. The serde models in `src-tauri/src/models.rs` use `#[serde(rename_all = "camelCase")]` so the TS types in `src/types/api.ts` mirror them 1:1.

When running outside the Tauri runtime (e.g. `npm run dev` in a browser tab), `api.*` returns the fallbacks defined inline so the UI still mounts. New IPC commands must also be allowed in `src-tauri/capabilities/default.json` or they fail at runtime.

## Window placement

The main window reopens at its last size and position. `window_state_plugin()` passes `skip_initial_state("main")` so the plugin's automatic restore-on-create never runs — that pass applies the saved position and `show()`s the window before `setup`, which breaks the hidden autostart launch and races the app's own placement. The plugin still tracks moves and resizes and persists them.

`apply_saved_window_geometry` then places the window itself, after vibrancy and decoration changes have settled (dropping decorations on Windows/Linux shifts the frame). The decision is a pure function, `plan_window_frame`, so it is unit-tested: the saved frame is used when `title_bar_visible` finds it still overlapping some monitor work area, and otherwise the window is centred on the primary monitor with its size clamped to that work area — which is what happens when the saved spot is gone, e.g. an unplugged monitor.

State is also flushed on `CloseRequested` via `save_window_state(StateFlags::all())`, because the plugin only writes its cache on `RunEvent::Exit` and that is unreliable on macOS Cmd+Q with the transparent, overlay-titlebar setup.

## Tray + auto-update

The tray icon (defined in `src-tauri/src/tray.rs`) emits `tray://navigate` events that `App.tsx` routes into the sidebar. `Settings → System Tray → Headline window` chooses which usage number the title and tooltip show — the 5h session, the all-models weekly window, or Claude's Fable-scoped weekly cap; providers without a Fable limit fall back to their all-models weekly number, and the rendered label reflects that fallback rather than claiming the window asked for. The icon is always the LunoPeak owl (a monochrome template, not the coloured app icon): it used to swap in the Claude / Codex / Cursor logo of whichever provider led, which read as that tool's own menu-bar item when it was running too. `TrayTitleStyle` picks what sits beside it — `Off`, `Percent` (the default, "42%"), or `PercentWindow` ("42% 5h"). Because the icon no longer identifies the provider or limit, the tooltip names both. `UpdateBanner` and `UpdateAutoCheckPrompt` drive the in-app updater flow against the `latest.json` produced by the release pipeline.
