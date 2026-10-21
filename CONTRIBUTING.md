# Contributing to LunoPeak

Thanks for wanting to help. LunoPeak is a local-first desktop dashboard for AI coding agents — Claude Code, Codex, and Cursor — built on Tauri 2 (Rust) and React 19. The bar it is held to: **everything stays on the user's machine, and every number it shows is one the user can trust.**

## Setup

```sh
git clone https://github.com/idevtim/lunopeak.git
cd lunopeak
npm install
npm run tauri:dev
```

**Requirements:** Rust (stable), Node 20+, and the [Tauri platform prerequisites](https://tauri.app/start/prerequisites/) for your OS. The first Rust compile takes a few minutes; later runs are fast.

For frontend-only work, `npm run dev` mounts the UI in a browser tab with no Rust runtime — `api.*` calls return the fallbacks in `src/lib/tauri.ts`. `npm run demo` does the same with sample data filled in.

## Before you open a PR

All three must pass:

```sh
npm run typecheck
npm run build
cd src-tauri && cargo test
```

And run the app (`npm run tauri:dev`) to see the change working. Say in the PR which OS you tested on — LunoPeak ships on macOS, Windows and Linux, and the tray, window chrome and process scanning all differ between them.

## Read before you touch

[`CLAUDE.md`](CLAUDE.md) is the map: commands, architecture, conventions and gotchas, kept short enough to read in one sitting. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) goes deeper on each subsystem. The rules that catch people most often:

- **Routes live in `src/routes.ts`.** The sidebar, the hash router and view registration all derive from it.
- **The IPC boundary is typed on both sides.** Rust models in `src-tauri/src/models.rs` use `#[serde(rename_all = "camelCase")]` and are mirrored 1:1 in `src/types/api.ts`. Change one, change the other.
- **New Tauri commands must be allowed** in `src-tauri/capabilities/default.json`, or they fail at runtime, not at build time.
- **The frontend must keep working without Tauri.** Every new `api.*` call needs a sensible fallback in `src/lib/tauri.ts`.
- **Async views ship a skeleton.** Export a `<ViewNameSkeleton />` shaped like the real content and gate it with `useDelayedLoading`.
- **State:** TanStack Query for anything backed by `api.*`, Zustand for ephemeral UI state. No React Context for shared state.
- **Reach for `src/components/ui/` first** before adding a new primitive.
- **Icons are committed.** Regenerate them with `npm run icons`, never `npx @tauri-apps/cli icon` directly.

## Privacy is a feature, not a setting

LunoPeak reads some of the most sensitive files on a developer's machine: agent transcripts, OAuth tokens, browser cookies, `.env` files. That is only acceptable because none of it leaves the machine. A PR will not be merged if it:

- adds telemetry, analytics, crash reporting, or any request to a server LunoPeak or its maintainer runs
- sends file contents, transcript text, paths, or keys anywhere the user didn't explicitly direct them
- writes an API key or token to `settings.json` or a log instead of the OS keychain
- refreshes or rotates another tool's credentials (doing so signs the user out of that tool)

New outbound network requests need to be named in the PR and switchable by the user.

## Making changes

1. Fork and branch from `main`
2. Make the change, reading the relevant section of `CLAUDE.md` first
3. Run the checks above
4. Update `CLAUDE.md` or `docs/ARCHITECTURE.md` in the same PR if the change alters something they describe
5. Open a PR

Small commits, [conventional commit](https://www.conventionalcommits.org/) messages (`feat:`, `fix:`, `docs:` …).

## Releases

Releases are cut by the maintainer: they are signed and notarized with the maintainer's certificates, and the auto-updater only accepts builds signed with the updater key. You never need any of that to develop. [`RELEASE.md`](RELEASE.md) documents the pipeline if you want to produce signed builds of your own fork.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md), and taking part means agreeing to it.

## Licensing of contributions

LunoPeak is released under the [MIT License](LICENSE). By opening a pull request you agree that your contribution is licensed under those same terms. There is no CLA to sign.

Don't paste in code you didn't write unless its licence permits it and you say where it came from. A new dependency should be named in the PR with a reason, and its licence has to be MIT-compatible.

## Questions?

Open an [issue](https://github.com/idevtim/lunopeak/issues) or a [discussion](https://github.com/idevtim/lunopeak/discussions) — happy to help.
