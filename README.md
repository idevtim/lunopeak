# LunoPeak

![LunoPeak](https://img.shields.io/badge/version-1.0.0-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg)

LunoPeak is a local-first, cross-platform desktop dashboard that gives you a real-time, unified view of your AI-assisted development environment. One window for every repo, session, agent, and config — no account, no cloud sync, no telemetry.

## Download

[**Download Latest Release**](https://github.com/idevtim/lunopeak/releases/latest)

- **macOS** - Apple Silicon & Intel (fully automatic updates)
- **Windows** - x64 & ARM64 (fully automatic updates)
- **Linux**:
  - **AppImage** - Fully automatic updates (recommended)
  - **DEB Package** - Semi-automatic updates (requires password)
  - **RPM Package** - Manual updates via GitHub

## Auto-Updates

LunoPeak includes built-in update notifications with varying levels of automation by platform:

- **macOS & Windows** - Fully automatic: downloads and installs updates seamlessly in the background
- **Linux AppImage** - Fully automatic: installs updates without requiring passwords or system permissions
- **Linux DEB** - Semi-automatic: downloads updates automatically, but requires your password to install (via system authentication)
- **Linux RPM** - Manual: notifies you of new versions and directs you to download from GitHub releases

All versions include in-app release notes and update notifications to keep you informed of new features and improvements.

## Features

### Overview
- **Dashboard** - At-a-glance summary of every active repo, session, and agent
- **Assistant** - Built-in chat assistant with full awareness of your environment
- **Tray Integration** - Native tray icon with quick navigation to any view
- **Multiple Workspaces** - Independent windows for parallel workflows

### Activity & Sessions
- **Live View** - Real-time monitoring of running Claude Code sessions and tools
- **Sessions History** - Browse every past session with timing, repo context, and outcomes
- **Session Replay** - Step through any past session turn-by-turn with full message context
- **Transcripts** - Full-text searchable transcript archive across every project
- **Tools** - See which tools each session used and how often
- **Costs** - Token spend tracked per session, per repo, and per provider with budget alerts

### Code Intelligence
- **Repos** - Unified list of every project on your machine with health, activity, and AI usage signals
- **Repo Detail** - Per-repo deep dive: recent sessions, diffs, costs, hygiene
- **Work Graph** - Visualize relationships between repos, branches, and active work
- **Timeline** - Cross-repo timeline of commits, sessions, and key events
- **Diffs** - Browse uncommitted and recent diffs across every repo from one place
- **Repo Pulse** - Activity heatmaps and rolling-window summaries for each project

### Configuration
- **Setup** - Centralized view of your Claude Code configuration across global and project scopes
- **Skills** - Browse and manage installed skills with usage stats
- **Agents** - Inventory of every subagent definition with last-used info
- **Memory** - Inspect and edit Claude Code memory files (CLAUDE.md, MEMORY.md) per project
- **Hooks** - Audit configured hooks and see when they fire

### Health & Hygiene
- **Hygiene** - Project hygiene checks: stale branches, large files, missing configs
- **Lint** - Aggregate lint status across every project
- **Deps** - Outdated dependency overview across all repos
- **Env** - Spot-check `.env` exposure, missing keys, and leaked secrets
- **Ports** - See which local ports are bound and by which process

### Backups
- **Snapshots** - Local snapshots of project state for quick rollback
- **Worktrees** - Manage Git worktrees from a single panel

### Privacy & Security
- **Fully Local** - All data stays on your machine; no account, no cloud sync
- **No Telemetry** - LunoPeak does not phone home or collect usage data
- **Native Performance** - Built on Tauri 2 (Rust) for a small footprint and fast startup
- **Encrypted Storage** - Sensitive settings stored using OS keychain APIs

## Screenshots

### Dashboard
![Dashboard](screenshots/dashboard.png)

### Sessions
![Sessions](screenshots/sessions.png)

### Repo Pulse
![Repo Pulse](screenshots/repo-pulse.png)

### Assistant
![Assistant](screenshots/assistant.png)

## System Requirements

| Platform | Minimum Version |
|----------|----------------|
| macOS | 10.15 (Catalina) or later |
| Windows | Windows 10 or later |
| Linux | Ubuntu 20.04+ / RHEL 8+ |

## Pricing

LunoPeak is **free to use** with no time restrictions for personal and commercial use.

## Documentation & Support

- **Bug Reports** - [GitHub Issues](https://github.com/idevtim/lunopeak/issues)
- **Feature Requests** - [GitHub Discussions](https://github.com/idevtim/lunopeak/discussions)

## Contact

**Email:** support@lunopeak.com
**Website:** https://lunopeak.com

---

**© 2025-2026 LunoPeak** • Made with ❤️ for developers
