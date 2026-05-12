<p align="center">
  <img src="logo.png" alt="LunoPeak Logo" width="160" />
</p>

# LunoPeak

![LunoPeak](https://img.shields.io/badge/version-1.5.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)
[![Sponsor](https://img.shields.io/badge/sponsor-%E2%9D%A4-ff69b4.svg)](https://github.com/sponsors/idevtim)
[![Buy Me a Coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-%E2%98%95-ffdd00.svg)](https://buymeacoffee.com/idevtim)

A local-first desktop dashboard for your AI dev environment. One window for every repo, session, agent, and config across **Claude Code, Codex, and Cursor**. No account. No cloud. No telemetry.

## Download

[**Download Latest Release**](https://github.com/idevtim/lunopeak/releases/latest)

- **macOS** — Apple Silicon & Intel
- **Windows** — x64 & ARM64
- **Linux** — AppImage (recommended), DEB, or RPM

All builds auto-update except Linux RPM (manual).

## What's New in 1.5.0

- **Redesigned tray popover.** Frameless, themed panel anchored under the tray icon with frosted-glass chrome that matches the rest of the app. Auto-hides on blur, honors *Reduce motion*, and theme changes from Settings apply live.
- **Insight strip.** Surfaces the single most-pressing usage window across your providers, color-coded green/amber/rose with the reset time underneath. Dismiss to surface the next one.
- **Tabs + per-provider detail.** Overview tab plus one per enabled provider. Overview is a clickable grid; per-provider view shows Session (5h) and Weekly bars in the provider's color. Cursor shows "Active context" instead.
- **Cost rollup + sparkline.** Today and last-30-day spend at the bottom of the panel, with a 7-day spend sparkline.
- **Adapts to your installed agents.** Claude Code, Codex, and Cursor are detected at launch, and copy, empty states, and buttons tune to whichever combination you actually have. The Repo Detail "Open in agent" button opens whichever agent you actually use.
- **First-launch notification onboarding.** Asks for OS notification permission once and sends a welcome banner so you can confirm it works. Denials are remembered.
- **Smarter Usage Limits card.** Provider rate-limit and auth errors surface inline ("Retry in 6m") instead of letting the bar freeze on stale data. The refresh button disables itself until the soonest backoff expires.
- **Claude usage limits checked far less often.** Extended cache, deduplicated concurrent calls, and skipped checks when nothing's changed locally — should clear up false "Rate-limited" notices for users running Claude Code alongside LunoPeak.

## Features

### Overview
- **Dashboard** — every active repo, session, and agent at a glance
- **Assistant** — built-in chat with full awareness of your environment
- **Tray** — provider brand marks, live usage windows, reset countdown, headline-window toggle
- **Persistent State** — window size, position, and last-viewed route remembered

### Activity & Sessions
- **Live View** — Claude Code, Codex, and Cursor sessions in real time, each process matched to its own transcript
- **Sessions History** — every past session with timing, repo, and outcomes
- **Session Replay** — step through any session turn-by-turn
- **Transcripts** — full-text searchable archive across every project
- **Tools** — which tools each session used, how often
- **Costs** — token spend per session, repo, and provider with budget alerts

### Code Intelligence
- **Repos** — every project on your machine with health and AI-usage signals
- **Repo Detail** — CLAUDE.md preview, skills, quick actions (open in Claude / VS Code / terminal, git pull)
- **Work Graph** — relationships between repos, branches, and active work
- **Timeline** — cross-repo commits, sessions, and key events
- **Diffs** — uncommitted and recent diffs across every repo
- **Repo Pulse** — activity heatmaps and rolling-window summaries

### Configuration
- **Setup** — Claude Code, Codex, and Cursor inventory: MCP servers, plugins, per-repo completeness
- **Skills** — every Claude skill, global + repo, with previews
- **Agents** — every agent definition with model, tools, and body
- **Memory** — every CLAUDE.md with topics and line counts
- **Hooks** — every configured hook, scoped per repo

### Health & Hygiene
- **Hygiene** — one-click fixes for stale branches, missing CLAUDE.md, ungitignored `.env`, uncommitted changes, and more
- **Lint** — eslint, prettier, ruff, stylelint, editorconfig across every repo
- **Deps** — manifests across npm, cargo, pip, poetry, go, bundler
- **Env** — `.env` files with key inventory, gitignore status, `.env.example` presence
- **Ports** — bound ports, owning process, working directory

### Backups
- **Snapshots** — local rollback points for project state
- **Worktrees** — manage Git worktrees from one panel

### Privacy & Security
- **Fully Local** — no account, no cloud sync, no telemetry
- **OS Keychain** — Anthropic, OpenAI, Gemini keys stored in macOS Keychain / Windows Credential Manager / Linux Secret Service
- **Auth Resilience** — Claude OAuth tokens auto-refresh across launches
- **Hardened Shell-outs** — folder paths passed as argv with per-platform quoting
- **Native Performance** — Tauri 2 (Rust). ~150 MB on disk, ~120 MB resident
- **Outbound Only When You Ask** — provider APIs only during Assistant use, plus the update endpoint

## Screenshots

### Dashboard
![Dashboard](screenshots/dashboard.png)

### Sessions
![Sessions](screenshots/sessions.png)

### Costs
![Costs](screenshots/costs.png)

### Hygiene
![Hygiene](screenshots/hygiene.png)

## System Requirements

| Platform | Minimum Version |
|----------|----------------|
| macOS | 10.15+ (Apple Silicon & Intel) |
| Windows | 10+ (x64 & ARM64) |
| Linux | Ubuntu 20.04+ / RHEL 8+ (x86_64 & aarch64) |

## Pricing

**Free** — personal and commercial. No paywalls, no pro tier.

## Support the Project

LunoPeak is free and will stay free. If it earns its place on your dock:

- ❤️ [**GitHub Sponsors**](https://github.com/sponsors/idevtim) — monthly support
- ☕ [**Buy Me a Coffee**](https://buymeacoffee.com/idevtim) — one-shot tip

## Links

- **Bugs** — [GitHub Issues](https://github.com/idevtim/lunopeak/issues)
- **Ideas** — [GitHub Discussions](https://github.com/idevtim/lunopeak/discussions)
- **Email** — support@lunopeak.com
- **Web** — https://lunopeak.com

---

**© 2026 LunoPeak** • Made with ❤️ for developers
