# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.0.x   | :white_check_mark: |
| < 2.0   | :x:                |

Only the latest release receives security updates.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, use GitHub's [private vulnerability reporting](https://github.com/idevtim/lunopeak/security/advisories/new), or email **security@idevtim.com** with:

- A description of the vulnerability
- Steps to reproduce
- Your LunoPeak version and operating system

You can expect an initial response within 48 hours. If the vulnerability is confirmed, a fix will be prioritized and released as soon as possible. You'll be credited in the release notes unless you prefer to remain anonymous.

## Scope

LunoPeak reads sensitive local files on purpose — that is what it is for. Issues in the following areas are especially relevant:

- **The update channel.** Updates are verified against the minisign public key in `src-tauri/tauri.conf.json`; the private key is held offline and never enters this repository. Anything that would let an unsigned or substituted build install is in scope.
- **Stored secrets.** Assistant API keys live in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Any path that writes one to disk, a log, or the diagnostics export is in scope.
- **Credentials LunoPeak reads but does not own.** Claude Code's OAuth token, Codex's `~/.codex/auth.json`, and Cursor's browser session cookie are read to show plan limits. Anything that sends them anywhere other than their own provider, or leaks them into logs or exports, is in scope.
- **Shell-outs.** Opening a folder in an editor or terminal, git operations, and one-click Hygiene fixes (which can delete branches and worktrees). Argument injection through a path, branch name, or repo name is in scope.
- **Config edits.** Installing the terminal status line edits `~/.claude/settings.json` and `~/.codex/config.toml`. Anything that could make that write something the user didn't choose is in scope.
- **The Assistant.** Tool calls the model can make into the app, and anything that lets a prompt or a scanned file escalate what those tools can do.
- **Network requests.** Plan-limit lookups, public status pages, the update check, and Assistant provider calls. Anything that adds a destination, or sends more than these need, is in scope.

## Not in scope

- **LunoPeak reading local agent data at all.** Transcripts, configs and usage logs under `~/.claude`, `~/.codex` and Cursor's storage are the product.
- **Anything requiring an attacker who already has code execution as the logged-in user.**
- **Third-party providers' own APIs and apps.**

## What LunoPeak does not do

There is no account, no telemetry, no analytics, and no crash reporting service. There is no LunoPeak server. The diagnostics export is written to a file on your machine and only goes anywhere if you send it yourself.
