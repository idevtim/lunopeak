<p align="center">
  <img src="logo.png" alt="LunoPeak Logo" width="160" />
</p>

# LunoPeak

![LunoPeak](https://img.shields.io/badge/version-1.14.0-blue.svg)
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

## What's New in 1.14.0

Your plan limits tell you how much of the week you've used. This release adds the other number you've been checking by hand: how full each running conversation's context window is. Every Claude, Codex, and Cursor session you have open now shows its context fill in the Live view, the menu bar, and on the dashboard — and you can put it in your terminals themselves.

- **Each running session shows how full its context is.** For Claude Code, LunoPeak finds each running `claude` process by its PID, finds the conversation it belongs to, and reads how big the most recent prompt was — the same figure Claude Code uses when it warns you it's about to compact. You see it as a percentage of the model's window, so "14% · 141K / 1M" tells you a session is still fresh, and you know which of your five terminals is about to compact before it happens. Codex sessions get the same treatment from the token counts it records after every turn. Cursor only saves a percentage per chat, so Cursor rows show the percentage without token counts.
- **The Live view shows context for every process.** Each process card has a Context row with a bar, a percentage, tokens used out of the window, and the model, and a new Peak context card at the top shows the fullest session you have running. The bar turns amber at 70% and red at 85%. Claude processes are also matched to their own conversation exactly now — before, two Claude sessions in the same folder were told apart by folder alone, and a card could show the other session's last action.
- **The menu bar panel has a "Running now" list.** Under the provider bars, a compact row per live session shows its name, folder, a thin bar, and its context percentage, with a pulsing dot on the Claude sessions working right now. Open a provider tab and the list narrows to that provider's sessions, below its 5-hour, weekly, and Fable bars. These rows are deliberately smaller than the plan bars: those are limits on your whole account, these are one conversation each.
- **The dashboard has a "Running now · context" section,** just below Rate limits, listing each live session's context fill, model, and token count, plus how many sessions are running and how many are busy. Drag it wherever you like with Edit layout.
- **Context and limits in your Claude Code terminal.** Turn it on in Settings → Terminal and every Claude Code session gets a line under the prompt: a bar for this session's context fill, your 5-hour and weekly limits, your Fable weekly limit, and what the session and your day have cost so far. It updates on every message and never goes to the network, so it doesn't slow Claude Code down. If you already use a status line — ccstatusline, ccusage, your own script — LunoPeak keeps it and adds its line underneath, and turning the toggle off puts your old one back.
- **You choose what the terminal line shows.** Settings → Terminal → Customize the line lists every piece: context, 5-hour, weekly, model limits like Fable, session cost, today's cost, and — off to start with — the model, the folder, and the git branch. Switch each on or off, move them up or down, turn off the context bar, the token count, or colors, choose when a limit shows its reset time, pick the separator, and set your own yellow and red thresholds. A preview shows the exact line as you go, and open sessions pick up changes without a restart.
- **The context % gets exact once the status line is on.** Claude Code tells the status line the real size of each session's context window, and LunoPeak keeps that and uses it everywhere instead of working the window out from the model name.
- **Codex terminals too, as far as Codex allows.** Codex can't run another program in its status line, so LunoPeak switches on Codex's built-in items instead: model, context used, 5-hour and weekly limits, and git branch. If you'd already picked your own items, turning this off puts them back.
- **The menu bar stops showing out-of-date usage after an update.** The menu bar helper can keep running for weeks after the app updates, and it could keep showing usage saved before the update — missing the Fable weekly bar. It now notices that and fetches fresh numbers.

> **Worth knowing:** Claude's transcripts don't record the size of the context window. With the Claude Code status line on, LunoPeak gets the real size from Claude Code; without it, it works the size out from the model — Fable, Mythos, Opus 5 and 5.5, Sonnet 5, and Opus 4.6–4.8 count as 1M, older models as 200K, and any session already past 200K counts as 1M whatever the model. Run a 1M model on a 200K window and its percentage reads lower than it really is; the token count next to it is always exact. Codex doesn't record which process is working on which conversation, so with two Codex sessions in one folder, which percentage goes with which process is a best guess. The status line points at wherever LunoPeak is installed — move the app and Settings → Terminal offers a Repair button — and Claude Code only runs status lines in folders you've trusted, the same rule it uses for hooks.

## Features

### Overview
- **Dashboard** — every active repo, session, and agent at a glance
- **Assistant** — built-in chat with full awareness of your environment, across Anthropic, OpenAI, Gemini, xAI, and local Ollama models
- **Tray** — provider brand marks, live usage windows (including Claude's Fable-scoped weekly cap), reset countdown, headline-window toggle
- **Terminal** — context fill, plan limits, and cost in your Claude Code status line; built-in items for Codex
- **Persistent State** — window size, position, and last-viewed route remembered

### Activity & Sessions
- **Live View** — Claude Code, Codex, and Cursor sessions in real time, each process matched to its own transcript, with per-session context fill
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
- **OS Keychain** — Anthropic, OpenAI, Gemini, and xAI keys stored in macOS Keychain / Windows Credential Manager / Linux Secret Service
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
