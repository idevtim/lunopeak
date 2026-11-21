# Release runbook

Step-by-step for shipping a new version of LunoPeak. Releases are built **locally** on your machine — no CI, no GitHub Actions. Your job is to bump versions, run a signed build, and upload the resulting bundles + a `latest.json` manifest to wherever your update endpoint points.

macOS and Windows builds run natively on their own hardware. Linux builds run in a Docker container on whichever machine you're at — see [Building Linux from macOS](#building-linux-from-macos).

## One-time setup

### 1. Generate the updater signing key pair

The Tauri updater uses asymmetric signing so installed clients can verify the bundles they download. Run:

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/lunopeak.key
```

This writes two files:

- `~/.tauri/lunopeak.key` — the private key (keep secret, never commit)
- `~/.tauri/lunopeak.key.pub` — the matching public key

Print the public key and paste it into `src-tauri/tauri.conf.json`:

```bash
cat ~/.tauri/lunopeak.key.pub
```

Replace the `REPLACE_ME_WITH_TAURI_SIGNER_PUBKEY` placeholder under `plugins.updater.pubkey`. The committed config currently looks like this — only the `pubkey` value needs swapping (and the endpoint, if you point it elsewhere):

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/idevtim/lunopeak/releases/latest/download/latest.json"
      ],
      "pubkey": "PASTE_THE_PUBLIC_KEY_HERE",
      "windows": { "installMode": "passive" }
    }
  }
}
```

**Back up the private key** to a password manager (1Password, Bitwarden, etc.). If you lose it, every existing install is orphaned — you can't ship signed updates they'll accept and you'd need to ship a new pubkey via a fresh, manually-installed build.

### 2. Set the signing env vars in your shell

`tauri build` reads two environment variables when signing. Add to `~/.zshrc` (or whichever shell rc you use):

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/lunopeak.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-passphrase-here"
```

Use `""` for the password if you skipped the passphrase prompt during `signer generate`. Then `source ~/.zshrc`.

If you'd rather not leave the key exported permanently, prefix each build instead:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/lunopeak.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-passphrase-here" \
npm run tauri:build
```

### 3. (Optional) macOS code signing

Without an Apple Developer account, the macOS DMG still builds but Gatekeeper warns users on first launch. To sign + notarize locally:

1. Apple Developer Program subscription ($99/yr).
2. Create a "Developer ID Application" certificate in Xcode → Settings → Accounts → Manage Certificates. Install it into your login keychain (the default).
3. Generate an app-specific password at https://appleid.apple.com/.

Add these to `~/.zshrc` alongside the signing key vars:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # the app-specific password
export APPLE_TEAM_ID="ABCDE12345"
```

`tauri build` picks them up automatically and notarizes the DMG.

### 4. (Optional) Windows code signing

Buy an EV code-signing certificate (DigiCert, Sectigo, etc.). Tauri reads the cert's path / password from `WINDOWS_CERTIFICATE_THUMBPRINT` (or `WINDOWS_CERTIFICATE` + `WINDOWS_CERTIFICATE_PASSWORD` if you have the `.pfx` exported). Set those env vars on the Windows machine you build from.

### 5. App icons

The committed icon set builds as-is; regenerate only if you change the artwork.

**Windows / Linux / legacy macOS** — drop a 1024×1024 PNG at `src-tauri/icons/source.png`, then:

```bash
npm run icons
```

Use the npm script rather than `npx @tauri-apps/cli icon` directly: the CLI's `.ico` omits the 128px frame that Windows 11 picks for several shell surfaces, so `build-icons.sh` rebuilds it with ImageMagick (`brew install imagemagick`). Commit the regenerated set.

**macOS 26+ Liquid Glass** — the layered icon lives in `src-tauri/icons/LunoPeak.icon/`, an Icon Composer bundle (Icon Composer ships inside Xcode, at `/Applications/Xcode.app/Contents/Applications/`). `build-dmg.sh` compiles it with `xcrun actool` and injects `Assets.car` into the `.app`, so **a signed macOS release needs full Xcode installed**, not just the Command Line Tools:

```bash
sudo xcode-select -s /Applications/Xcode.app
npm run icons:mac     # compile + preview the glass render, no release build
```

Editing the layers by hand works too — they're plain SVG. Keep them flat, shadowless and full-bleed 1024×1024; macOS supplies the squircle, shadow and specular highlight itself, and baked-in versions of those fight it. Systems older than macOS 26 fall back to the flattened `.icns` that the same `actool` run emits.

### 6. Decide where to host updates

The default config points at a `latest.json` artifact attached to the latest GitHub release:

```
https://github.com/idevtim/lunopeak/releases/latest/download/latest.json
```

That works without any server — you upload the manifest as a release asset by hand. If you'd rather host elsewhere (your own static site, an S3 bucket, a Cloudflare R2 bucket), edit `endpoints` in `tauri.conf.json` to point there. The format is the same.

`latest.json` shape (see [Tauri's manifest schema](https://tauri.app/v2/develop/distribute/updater/#serving-updates)):

```json
{
  "version": "0.2.0",
  "notes": "Bug fixes and a faster repo scan.",
  "pub_date": "2026-05-02T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of LunoPeak.app.tar.gz.sig>",
      "url": "https://github.com/idevtim/lunopeak/releases/download/v0.2.0/LunoPeak_0.2.0_aarch64.app.tar.gz"
    },
    "darwin-x86_64":  { "signature": "...", "url": "..." },
    "linux-x86_64":   { "signature": "...", "url": "..." },
    "windows-x86_64": { "signature": "...", "url": "..." }
  }
}
```

The `.sig` files are written next to each bundle by `tauri build` — `cat` them and paste the contents into the `signature` fields. Only include the platforms you actually ship.

## Cutting a release

### The short path

Bump the version in all three manifests, write `release-notes/vX.Y.Z.md`, then
run the `dist:*` script for the platform you're on:

```bash
npm run dist:mac   # notarized universal DMG                (scripts/build-dmg.sh)
npm run dist:win   # signed NSIS installers, x64 + arm64     (scripts/build-windows.ps1)
npm run dist:nix   # deb + rpm + AppImage                    (scripts/dist-linux.sh)
```

Each script runs end to end: it refuses to start unless `package.json`,
`tauri.conf.json` and `Cargo.toml` agree on the version and
`release-notes/vX.Y.Z.md` exists, then builds, signs, generates the `.sig`
siblings, merges `latest.json`, and drafts (or updates) the GitHub release on
`idevtim/lunopeak`. Tauri can't cross-compile between macOS, Windows and Linux,
so run each on its own host — except Linux, which `dist:nix` will drive from
macOS through Docker (see [Building Linux from macOS](#building-linux-from-macos)).

`build:mac` / `build:win` / `build:linux` are aliases for the same three.

### The manual path

Only needed if a `dist:*` script is broken or you're bringing up a new platform.

1. **Bump versions** — they must match across all three files:
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
   - `src-tauri/Cargo.toml` → `[package].version`

2. **Update CHANGELOG.md** with what changed.

3. **Verify locally**:

   ```bash
   npm run typecheck
   npm run build
   cd src-tauri && cargo check && cd ..
   ```

4. **Build the signed bundles**. Repeat on each platform you support (Tauri can't cross-compile macOS/Windows/Linux from a single host):

   ```bash
   npm run tauri:build
   ```

   Output lands in `src-tauri/target/release/bundle/`:

   - macOS: `macos/LunoPeak.app.tar.gz` + `LunoPeak.app.tar.gz.sig` (updater payload), `dmg/LunoPeak_<version>_<arch>.dmg` (first-install download)
   - Linux: `appimage/LunoPeak_<version>_amd64.AppImage` + `.AppImage.sig`
   - Windows: `nsis/LunoPeak_<version>_x64-setup.exe` + `.exe.sig`

5. **Assemble `latest.json`** locally using the shape in step 6 above. Paste the contents of each `.sig` file into the matching `signature` field.

6. **Tag + upload to GitHub Releases**:

   ```bash
   git add -A
   git commit -m "Release v0.2.0"
   git tag v0.2.0
   git push origin main --tags
   ```

   On https://github.com/idevtim/lunopeak/releases, draft a new release for the tag and drag-and-drop:

   - The first-install bundles users download (`.dmg`, `.AppImage`, `.exe`)
   - The updater payloads (`.app.tar.gz`, `.AppImage`, `.exe` — same files in some cases) **and their `.sig` siblings**
   - `latest.json`

   Publish the release. Existing installs will pick up the new version on their next launch.

## Building Linux from macOS

`scripts/build-linux.sh` expects to run on a Linux host — it checks `dpkg` for
the GTK/webkit dev packages and builds for whatever `uname -m` reports. A
Parallels VM on Apple Silicon can't stand in for that: Parallels virtualizes
rather than emulates, so an Apple Silicon host only gives you an **arm64**
guest, and every Linux artifact we ship is **amd64**.

`scripts/docker-build-linux.sh` bridges the gap. It builds an amd64 Ubuntu
22.04 image and runs `build-linux.sh` inside it, unmodified.

`npm run dist:nix` picks the right one for you — `build-linux.sh` directly on a
Linux host, `docker-build-linux.sh` on macOS — and passes flags through:

```bash
# Verify the build first — no tag, no upload
npm run dist:nix -- --build-only

# Real thing: build, sign, draft the release on idevtim/lunopeak
npm run dist:nix

# Poke around the environment by hand (macOS/Docker only)
./scripts/docker-build-linux.sh --shell
```

`npm run dist:nix:docker` forces the container path, which is how you'd build
amd64 bundles from an arm64 Linux host.

### Why 22.04 and not something newer

A binary links against the glibc of the machine that built it and won't start
on anything older. The v1.9.2 Linux binary requires `GLIBC_2.39`, which means
it was built on Ubuntu 24.04 — and therefore refused to launch for anyone on
Ubuntu 22.04, Debian 12 or Mint 21. Ubuntu 22.04 provides glibc 2.35 and still
carries `libwebkit2gtk-4.1`, so building on the older base widens
compatibility at no cost. Don't "upgrade" the base image without a reason.

### Notes

- **Enable Rosetta.** Docker Desktop → Settings → General → *Use Rosetta for
  x86_64/amd64 emulation*. The release profile (`lto = true`,
  `codegen-units = 1`) is a heavy compile and plain QEMU is several times
  slower.
- **Give the VM headroom.** 12–16GB under Docker Desktop → Settings →
  Resources. An OOM-killed linker surfaces as a bare exit 137.
- **First run is slow.** Rust compiles the full dependency graph from scratch.
  The cargo registry and `target/` live in named Docker volumes, so subsequent
  runs are incremental.
- **`node_modules` and `src-tauri/target` are volumes, not bind mounts.** The
  host copies contain macOS-native binaries; letting the container see them
  would mix architectures.
- Signing uses `~/.tauri/lunopeak.key`, mounted read-only. The GitHub token is
  read from the host's `gh` CLI and passed in as `GH_TOKEN` — the host keeps
  its token in the macOS keychain, so there's no config file to mount.

## Rollback

If a release ships with a critical bug:

1. Delete the draft release on GitHub if it's still draft.
2. If already published: bump to the next patch version with the fix and re-release. Don't yank — existing users are already on it.
3. The updater will pick up the next version on their next launch.

## Update behavior in the app

Once the pubkey + endpoint are wired in, the in-app updater works like this:

- **First launch after install** — the user sees a one-time modal:
  > Check for updates automatically? You can always check for updates manually from Settings.

  With a checkbox for *Automatically download and install updates* and two buttons:

  | Button | Effect |
  | --- | --- |
  | **Don't Check** | `general.checkUpdates = false`. The banner and background check stay quiet. |
  | **Check Automatically** | `general.checkUpdates = true`, plus `general.autoInstallUpdates` if the checkbox was ticked. |

  Either choice flips `general.updatePromptSeen`, so the modal never re-appears.

- **Background check** — when `checkUpdates` is on, `UpdateBanner` calls `check()` ~4 s after boot.
  - If `autoInstallUpdates` is off, an update surfaces as a sticky banner with an Install button.
  - If `autoInstallUpdates` is on, the install runs silently and the banner only appears in its "restart to apply" state.

- **Manual check** — Settings → General → "Check for Updates" calls the same `check()` API on demand and reports the result inline.

- **Failure mode** — if the updater isn't configured (placeholder pubkey, missing endpoint, no network), the banner is silent and `check()` errors are swallowed. The first-run prompt still shows because it doesn't depend on the network.

The relevant code:

- `src-tauri/src/lib.rs` — registers `tauri_plugin_updater`
- `src-tauri/src/models.rs` — `GeneralPrefs.{check_updates, auto_install_updates, update_prompt_seen}`
- `src/components/UpdateAutoCheckPrompt.tsx` — first-run modal
- `src/components/UpdateBanner.tsx` — background check + banner + auto-install path
- `src/views/settings/SettingsView.tsx` (`GeneralCard`) — both toggles

## Notes on platforms we haven't fully covered

- **Mac App Store**: requires sandboxing, which conflicts with reading `~/.claude/projects` and arbitrary scan dirs without permissions plumbing. Out of scope for v1; revisit only if the direct-download channel shows clear demand for App Store distribution.
- **Microsoft Store**: same shape as direct download, just packaged as `.msix`. Tauri supports it; build manually when ready.
- **Snap / Flatpak / Homebrew tap**: nice-to-haves; AppImage from `tauri build` is enough for v1.
