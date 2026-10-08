<p align="center">
  <img src="logo.png" alt="LunoPeak Logo" width="160" />
</p>

# LunoPeak

![LunoPeak](https://img.shields.io/badge/version-1.15.0-blue.svg)
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

## What's New in 1.15.0

Anthropic released Claude Haiku 5.5, so LunoPeak now prices it, labels it, and lets you pick it in the Assistant. While adding it, we checked every Claude model's price against Anthropic's current pricing page — four models were being billed wrong. If you use Sonnet 5, your Costs page will drop.

- **Haiku 5.5 is supported.** Its cost is worked out correctly in Costs, Sessions, the menu bar, and the terminal status line, and Sessions labels it "Haiku 5.5". It's the first Claude model whose price depends on how long the prompt is: up to 100K tokens it's $0.10 per million input and $0.50 per million output, and a prompt over 100K costs five times that for the whole turn — $0.50 and $2.50. As with Claude Code itself, "the prompt" means everything sent: new input, cache reads, and cache writes. Its context meter counts against a 1M window.
- **Sonnet 5.5 is supported too.** Sessions labels it "Sonnet 5.5", and both new models are in the Assistant's model picker. The old "Haiku" entry is renamed "Haiku 4.5" so you can tell the two apart.

### Price fixes

- **Sonnet 5 stays at $2 / $10.** Anthropic launched Sonnet 5 with "introductory" pricing due to rise to $3 / $15 on September 1, then cancelled the increase. LunoPeak still applied it, so every Sonnet 5 turn since September 1 showed 50% more than you actually paid. Those turns now show the right amount, as do turns where LunoPeak couldn't tell the date.
- **Mythos 5.1 gets Fable 5.1's cheap cache reads.** When Mythos 5.1 came out, Anthropic hadn't said whether it shared Fable 5.1's $0.25-per-million cache-read rate, so LunoPeak charged the full $1.00 rather than show a bill lower than the real one. Anthropic has now confirmed $0.25, so Mythos cache reads cost a quarter of what was showing. Mythos 5.1 also appears in the Costs page's "saved" note now, next to Fable 5.1 and Opus 5.5.
- **No more long-prompt surcharge on Opus 4.6, 4.7, and 4.8.** Anthropic now charges the normal rate across the whole 1M context window for these models, and LunoPeak was still doubling the price of any prompt over 200K tokens. Opus sessions with long prompts now cost what they actually did.
- **Sonnet 4.6 context fills against 1M.** Its context meter assumed a 200K window until the session passed 200K; it now uses 1M from the start, like the other current models. With the Claude Code status line on, this was already exact.

### Fixes

- **The window opens where you left it.** LunoPeak used to re-centre its window on every open, and sometimes the centring went wrong and the window landed toward the bottom-right of the screen. It now reopens at the size and position it had when you closed it, on macOS, Windows, and Linux. If that spot is no longer on screen — you unplugged a monitor, say — it opens centred on your main display instead.

> **Worth knowing:** Anthropic's pricing page disagrees with itself about Sonnet 5.5 cache reads — the price table and models overview say $0.20 per million, the prompt-caching section says $0.10. Until they agree, LunoPeak uses $0.20, so if the real rate turns out to be $0.10 your Sonnet 5.5 cache reads will look a little more expensive than they were, never cheaper. Costs are worked out again from your session files each time LunoPeak starts, so once you update, the fixed prices apply to all your past sessions as well as new ones. These are list prices: LunoPeak doesn't account for fast mode, the Batch API discount, US-only inference, or a negotiated enterprise rate — fast mode costs more than LunoPeak shows, the others cost less or the same.

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
| Linux | Ubuntu 20.04+ / RHEL 8+ (x86_64) |

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
