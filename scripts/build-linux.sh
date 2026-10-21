#!/bin/bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

APP_NAME="LunoPeak"

# Releases live on the public distribution repo, NOT on the private code repo.
RELEASE_REPO="idevtim/lunopeak"
RELEASE_TARGET="main"

# rustup/cargo are installed under $HOME/.cargo by default but that bin dir
# isn't always on PATH in non-interactive shells.
if [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# Strip snap-injected env when running from VS Code's snap-integrated terminal.
# Symptom if not stripped: the built binary dies at startup with
#   "symbol lookup error: /snap/core20/.../libpthread.so.0: undefined symbol:
#    __libc_pthread_init, version GLIBC_PRIVATE"
# because GTK loads from the snap's older core20 runtime against the host glibc.
if [[ "${GTK_PATH:-}" == /snap/* ]] || [[ "${LOCPATH:-}" == /snap/* ]]; then
  echo "ℹ️  Stripping snap-injected env vars (LOCPATH, GTK_PATH, XDG_DATA_DIRS, ...)"
  unset LOCPATH GTK_PATH GTK_EXE_PREFIX GTK_IM_MODULE_FILE \
        GIO_MODULE_DIR GSETTINGS_SCHEMA_DIR XDG_DATA_HOME XDG_DATA_DIRS
fi

# Optional .env (mac flow uses this for Apple creds; here we may pull
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD). GitHub auth comes from `gh auth login`.
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# Detect host arch and map to the names Tauri uses in bundle filenames and
# updater manifest platform keys.
HOST_MACHINE="$(uname -m)"
case "$HOST_MACHINE" in
  x86_64)
    RUST_TARGET="x86_64-unknown-linux-gnu"
    RUST_ARCH="x86_64"
    DEB_ARCH="amd64"
    ;;
  aarch64|arm64)
    RUST_TARGET="aarch64-unknown-linux-gnu"
    RUST_ARCH="aarch64"
    DEB_ARCH="arm64"
    ;;
  *)
    echo "❌ Unsupported host architecture: $HOST_MACHINE"
    echo "   This script targets the host arch only — cross-compiling Linux bundles needs a sysroot."
    exit 1
    ;;
esac
PLATFORM_KEY="linux-$RUST_ARCH"

# Updater signing key. Tauri reads TAURI_SIGNING_PRIVATE_KEY (raw key bytes)
# and TAURI_SIGNING_PRIVATE_KEY_PASSWORD; without BOTH set it silently skips
# signing and no .sig sibling is emitted (the build still "succeeds").
KEY_PATH="$HOME/.tauri/lunopeak.key"
if [ -f "$KEY_PATH" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$KEY_PATH"
  # Tauri requires _PASSWORD to be set even for passwordless keys.
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  SIGNING_ENABLED=true
  echo "✓ Updater key: $KEY_PATH"
else
  SIGNING_ENABLED=false
  echo "⚠️  Updater key missing at $KEY_PATH — bundles will be UNSIGNED"
  echo "    Generate with: npx @tauri-apps/cli signer generate -w $KEY_PATH --ci"
fi

# ─── Pre-flight: version + release notes ────────────────────────────────────
VERSION=$(node -p "require('$PROJECT_DIR/package.json').version")
TAURI_VERSION=$(node -p "require('$PROJECT_DIR/src-tauri/tauri.conf.json').version")
# Reverse-DNS identifier. With app.enableGTKAppId=true this is also the GTK
# application id and therefore the Wayland app-id, which is what the taskbar
# StartupWMClass must match for the icon to resolve (see post-process below).
APP_ID=$(node -p "require('$PROJECT_DIR/src-tauri/tauri.conf.json').identifier")
CARGO_VERSION=$(grep -m1 '^version' "$PROJECT_DIR/src-tauri/Cargo.toml" | sed -E 's/version = "(.*)"/\1/')

if [ "$VERSION" != "$TAURI_VERSION" ] || [ "$VERSION" != "$CARGO_VERSION" ]; then
  echo "❌ Version mismatch:"
  echo "   package.json:    $VERSION"
  echo "   tauri.conf.json: $TAURI_VERSION"
  echo "   Cargo.toml:      $CARGO_VERSION"
  exit 1
fi

RELEASE_NOTES="$PROJECT_DIR/release-notes/v$VERSION.md"
if [ ! -f "$RELEASE_NOTES" ]; then
  echo "❌ Missing release notes: release-notes/v$VERSION.md"
  echo "   Create this file before releasing."
  exit 1
fi
echo "✓ Found release notes for v$VERSION"

# ─── Pre-flight: toolchain ──────────────────────────────────────────────────
for tool in rustc cargo node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "❌ Required tool not on PATH: $tool"
    exit 1
  fi
done
echo "✓ Toolchain present (rustc, cargo, node, npm)"

# ─── Pre-flight: rust target installed ──────────────────────────────────────
if ! rustup target list --installed | grep -q "^$RUST_TARGET$"; then
  echo "🦀 Installing missing rust target: $RUST_TARGET"
  rustup target add "$RUST_TARGET"
fi

# ─── Pre-flight: system libraries ───────────────────────────────────────────
# Tauri 2 on Linux needs webkit2gtk-4.1, libsoup-3, gtk-3, ayatana app indicator,
# and rsvg2. AppImage bundling additionally needs libfuse2 + patchelf.
REQUIRED_PKGS=(
  libwebkit2gtk-4.1-dev
  libsoup-3.0-dev
  libssl-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  "libfuse2|libfuse2t64"
  patchelf
)
MISSING_PKGS=()
if command -v dpkg >/dev/null 2>&1; then
  for pkg in "${REQUIRED_PKGS[@]}"; do
    found=0
    IFS='|' read -ra alts <<< "$pkg"
    for alt in "${alts[@]}"; do
      if dpkg -s "$alt" 2>/dev/null | grep -q "Status: install ok installed"; then
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      MISSING_PKGS+=("${alts[0]}")
    fi
  done
  if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    echo "❌ Missing system packages:"
    for p in "${MISSING_PKGS[@]}"; do echo "     - $p"; done
    echo "   Install with:"
    echo "     sudo apt-get update && sudo apt-get install -y ${MISSING_PKGS[*]}"
    exit 1
  fi
  echo "✓ System libraries present"
else
  echo "⚠️  dpkg not found — skipping system library check (non-Debian distro)"
  echo "   Ensure equivalents of: ${REQUIRED_PKGS[*]}"
fi

# ─── Pre-flight: gh CLI auth ────────────────────────────────────────────────
# Validate before the (multi-minute) Rust build so a missing/stale auth
# doesn't waste the build. Capture stderr and surface it on failure — masking
# with `>/dev/null 2>&1` previously turned real errors (keyring locked, network,
# etc.) into a silent "skipping release" message and the upload never happened.
#
# SKIP_RELEASE=1 stops after the bundles are on disk: no gh auth requirement,
# no tag, no upload. Useful for verifying a build (especially the slow
# containerized one) before it starts mutating the release repo.
if [ "${SKIP_RELEASE:-0}" = "1" ]; then
  echo "ℹ️  SKIP_RELEASE=1 — building bundles only (no tag, no upload)"
else
  if ! command -v gh >/dev/null 2>&1; then
    echo "❌ gh CLI not found on PATH. Install it and run \`gh auth login\`."
    exit 1
  fi
  if ! GH_AUTH_OUTPUT=$(gh auth status 2>&1); then
    echo "❌ gh CLI auth check failed:"
    echo "$GH_AUTH_OUTPUT" | sed 's/^/   /'
    echo "   Run \`gh auth login\` (or unlock the keyring) and re-run."
    exit 1
  fi
  echo "✓ gh CLI authenticated"
fi

# ─── Build ──────────────────────────────────────────────────────────────────
echo "🔨 Building $APP_NAME v$VERSION for $RUST_TARGET..."
cd "$PROJECT_DIR"

BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/$RUST_TARGET/release/bundle"

# Wipe any prior bundle output. The glob below filters by $VERSION to avoid
# alphabetical-ordering bugs, but a fresh tree also prevents stale .sig files
# and updater .tar.gz wrappers from a prior build sneaking into the release.
if [ -d "$BUNDLE_DIR" ]; then
  echo "🧹 Clearing previous bundle output: $BUNDLE_DIR"
  rm -rf "$BUNDLE_DIR"
fi

npm run tauri:build -- --target "$RUST_TARGET"
DEB_DIR="$BUNDLE_DIR/deb"
RPM_DIR="$BUNDLE_DIR/rpm"
APPIMAGE_DIR="$BUNDLE_DIR/appimage"

# Bundle file naming differs per format. Glob for the expected single artifact
# in each directory rather than hard-coding (Tauri tweaks naming between versions).
# Filter by $VERSION so stale bundles from prior builds in the same directory
# don't shadow the freshly-built ones (alphabetical ordering would pick 1.0.0
# over 1.1.0).
shopt -s nullglob
DEB_FILES=("$DEB_DIR"/*"$VERSION"*.deb)
RPM_FILES=("$RPM_DIR"/*"$VERSION"*.rpm)
APPIMAGE_FILES=("$APPIMAGE_DIR"/*"$VERSION"*.AppImage)
shopt -u nullglob

if [ ${#DEB_FILES[@]} -eq 0 ] && [ ${#RPM_FILES[@]} -eq 0 ] && [ ${#APPIMAGE_FILES[@]} -eq 0 ]; then
  echo "❌ Build did not produce any Linux bundles under $BUNDLE_DIR"
  exit 1
fi

DEB_PATH="${DEB_FILES[0]:-}"
RPM_PATH="${RPM_FILES[0]:-}"
APPIMAGE_PATH="${APPIMAGE_FILES[0]:-}"

# ─── AppImage post-process: strip NVIDIA-incompatible libs ──────────────────
# Tauri's AppImage bundles libwayland-egl / libEGL / libgbm pulled from the
# build host. On NVIDIA proprietary the bundled mesa copies shadow the host's
# NVIDIA libs at runtime and abort with
#   Could not create GBM EGL display: EGL_SUCCESS. Aborting...
# before any flags are parsed (so the WEBKIT_DISABLE_DMABUF_RENDERER=1 we set
# in the .desktop entry never gets a chance to help). The .deb / .rpm bundles
# don't ship these libs at all and work fine, so strip them from the AppImage
# and let it fall through to the host's copies.
if [ -n "$APPIMAGE_PATH" ]; then
  echo "🩹 Post-processing AppImage for NVIDIA proprietary..."

  # Capture the updater format BEFORE the repack so we know whether to
  # regenerate the .tar.gz wrapper or just re-sign the bare AppImage.
  STALE_TARGZ=""
  if $SIGNING_ENABLED; then
    shopt -s nullglob
    TARGZ_CANDIDATES=("$APPIMAGE_DIR"/*.AppImage.tar.gz)
    shopt -u nullglob
    if [ ${#TARGZ_CANDIDATES[@]} -gt 0 ]; then
      STALE_TARGZ="${TARGZ_CANDIDATES[0]}"
    fi
  fi

  POST_DIR=$(mktemp -d)
  chmod +x "$APPIMAGE_PATH"
  # Only present in the Docker build image, so this is a no-op on a real Linux
  # host. There it clears the AppImage marker bytes that stop binfmt_misc from
  # routing an x86_64 binary to the emulator on an arm64 machine. Safe to do to
  # this file: appimagetool regenerates it below with the marker restored.
  if command -v appimage-unmagic >/dev/null 2>&1; then
    appimage-unmagic "$APPIMAGE_PATH"
  fi
  ( cd "$POST_DIR" && "$APPIMAGE_PATH" --appimage-extract >/dev/null )

  STRIP_LIBS=(
    libwayland-egl.so
    libEGL.so
    libGL.so
    libGLX.so
    libGLdispatch.so
    libgbm.so
  )
  for lib in "${STRIP_LIBS[@]}"; do
    find "$POST_DIR/squashfs-root/usr/lib" -maxdepth 1 -name "${lib}*" -delete 2>/dev/null || true
  done

  # Inject StartupWMClass so the taskbar/dock icon resolves on Wayland. GNOME
  # (and other Wayland compositors) ignore a window's embedded icon and instead
  # match the window's app-id to a .desktop file, then use that file's Icon=.
  # With app.enableGTKAppId=true the app-id is the reverse-DNS identifier
  # ("$APP_ID"), so the .desktop needs StartupWMClass=$APP_ID or the window
  # can't be linked to any entry and the compositor shows a generic icon.
  # AppImageLauncher carries this key into the integrated entry it generates,
  # so setting it here fixes the icon for AppImage installs. Patch every
  # bundled .desktop (the AppImage root one plus usr/share/applications).
  while IFS= read -r -d '' desktop; do
    if grep -q '^StartupWMClass=' "$desktop"; then
      sed -i "s/^StartupWMClass=.*/StartupWMClass=$APP_ID/" "$desktop"
    else
      sed -i "/^\[Desktop Entry\]/a StartupWMClass=$APP_ID" "$desktop"
    fi
  done < <(find "$POST_DIR/squashfs-root" -maxdepth 4 -name '*.desktop' -print0)
  echo "   Set StartupWMClass=$APP_ID on bundled .desktop entries"

  # Locate appimagetool. Tauri 2 no longer drops it next to the bundle (it
  # uses linuxdeploy + the appimage plugin under ~/.cache/tauri/ instead, and
  # that plugin isn't CLI-compatible with appimagetool). Order of preference:
  #   1. our own cached copy under ~/.cache/tauri/ (from a previous run)
  #   2. legacy Tauri locations (older Tauri versions that did extract it)
  #   3. system $PATH
  #   4. download the AppImageKit continuous release into ~/.cache/tauri/
  TAURI_CACHE_DIR="$HOME/.cache/tauri"
  APPIMAGETOOL=""
  for cand in \
    "$TAURI_CACHE_DIR/appimagetool-${RUST_ARCH}.AppImage" \
    "$BUNDLE_DIR/appimage_deb/appimagetool-${RUST_ARCH}.AppImage" \
    "$BUNDLE_DIR/appimage_deb/appimagetool" \
    "$(command -v appimagetool 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then
      APPIMAGETOOL="$cand"
      break
    fi
  done
  if [ -z "$APPIMAGETOOL" ]; then
    mkdir -p "$TAURI_CACHE_DIR"
    APPIMAGETOOL="$TAURI_CACHE_DIR/appimagetool-${RUST_ARCH}.AppImage"
    APPIMAGETOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-${RUST_ARCH}.AppImage"
    echo "   appimagetool not cached — downloading from AppImageKit continuous"
    echo "   $APPIMAGETOOL_URL"
    if ! curl -fsSL --retry 3 -o "$APPIMAGETOOL" "$APPIMAGETOOL_URL"; then
      rm -f "$APPIMAGETOOL"
      echo "❌ Failed to download appimagetool from $APPIMAGETOOL_URL"
      echo "   Manually place it at $APPIMAGETOOL and re-run."
      exit 1
    fi
    chmod +x "$APPIMAGETOOL"
  fi
  # Same emulation workaround as above — no-op outside the Docker build image.
  if command -v appimage-unmagic >/dev/null 2>&1; then
    appimage-unmagic "$APPIMAGETOOL"
  fi

  # Repack. appimagetool refuses to overwrite an existing file, so unlink first.
  rm -f "$APPIMAGE_PATH"
  ARCH="$RUST_ARCH" "$APPIMAGETOOL" --no-appstream "$POST_DIR/squashfs-root" "$APPIMAGE_PATH" >/dev/null
  chmod +x "$APPIMAGE_PATH"
  rm -rf "$POST_DIR"
  echo "   Stripped: ${STRIP_LIBS[*]}"
  echo "   Repacked: $(basename "$APPIMAGE_PATH")"

  # Re-sign. The .sig tauri:build produced is now stale because the AppImage
  # bytes changed; regenerate against the post-processed bundle so the
  # updater accepts it. Handles both the bare-AppImage and .tar.gz wrapper
  # payload formats.
  if $SIGNING_ENABLED; then
    # `signer sign --private-key <X>` expects raw key bytes (not a path) in
    # newer Tauri CLI builds — passing $KEY_PATH directly fails base64 decode.
    # Pass the file contents inline. We also need to scrub
    # TAURI_SIGNING_PRIVATE_KEY_PATH from the env: it maps to a mutually-
    # exclusive --private-key-path flag, and having both set fails with
    # "the argument '--private-key' cannot be used with '--private-key-path'".
    rm -f "$APPIMAGE_PATH.sig"
    if [ -n "$STALE_TARGZ" ]; then
      rm -f "$STALE_TARGZ" "$STALE_TARGZ.sig"
      tar -C "$APPIMAGE_DIR" -czf "$STALE_TARGZ" "$(basename "$APPIMAGE_PATH")"
      env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH \
        npx --yes @tauri-apps/cli signer sign \
        --private-key "$(cat "$KEY_PATH")" \
        --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
        "$STALE_TARGZ" >/dev/null
    else
      env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH \
        npx --yes @tauri-apps/cli signer sign \
        --private-key "$(cat "$KEY_PATH")" \
        --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
        "$APPIMAGE_PATH" >/dev/null
    fi
    echo "   Re-signed updater payload"
  fi
fi

# ─── Locate updater payload ─────────────────────────────────────────────────
# Tauri 2 emits the updater payload alongside the AppImage. Depending on
# version it's either <name>.AppImage.tar.gz (older) or <name>.AppImage.sig
# directly on the AppImage (newer). Glob and pick whichever exists.
UPDATER_PATH=""
SIG_PATH=""
if $SIGNING_ENABLED && [ -n "$APPIMAGE_PATH" ]; then
  shopt -s nullglob
  TARGZ_CANDIDATES=("$APPIMAGE_DIR"/*.AppImage.tar.gz)
  shopt -u nullglob
  if [ ${#TARGZ_CANDIDATES[@]} -gt 0 ] && [ -f "${TARGZ_CANDIDATES[0]}.sig" ]; then
    UPDATER_PATH="${TARGZ_CANDIDATES[0]}"
    SIG_PATH="$UPDATER_PATH.sig"
  elif [ -f "$APPIMAGE_PATH.sig" ]; then
    UPDATER_PATH="$APPIMAGE_PATH"
    SIG_PATH="$APPIMAGE_PATH.sig"
  else
    echo "❌ Signing was enabled but no .sig was produced next to the AppImage."
    echo "   Looked under: $APPIMAGE_DIR"
    exit 1
  fi
  echo "✓ Updater payload: $UPDATER_PATH (+ .sig)"
fi

echo ""
echo "✅ Build complete (v$VERSION):"
[ -n "$DEB_PATH" ]      && echo "   deb:      $DEB_PATH"
[ -n "$RPM_PATH" ]      && echo "   rpm:      $RPM_PATH"
[ -n "$APPIMAGE_PATH" ] && echo "   AppImage: $APPIMAGE_PATH"

# Early out before anything mutates git or the release repo. Deliberately
# placed after the bundle summary so a --build-only run still reports where
# the artifacts landed.
if [ "${SKIP_RELEASE:-0}" = "1" ]; then
  echo ""
  echo "ℹ️  SKIP_RELEASE=1 — stopping before tag + GitHub release."
  exit 0
fi

# ─── GitHub Release ─────────────────────────────────────────────────────────
# gh auth was validated as a pre-flight check, so failures here are real
# failures — let `set -e` bubble them up rather than swallowing them.
echo "🚀 Drafting GitHub release v$VERSION on $RELEASE_REPO..."
# Source tag on origin (lunopeak-app) for code traceability.
git tag "v$VERSION" 2>/dev/null || echo "   Tag v$VERSION already exists on origin"
git push origin "v$VERSION" 2>&1 || echo "   (tag push skipped or already pushed)"

# Build the asset list. All install bundles ship; updater payload + latest.json
# only when signing.
ASSETS=()
[ -n "$DEB_PATH" ]      && ASSETS+=("$DEB_PATH")
[ -n "$RPM_PATH" ]      && ASSETS+=("$RPM_PATH")
[ -n "$APPIMAGE_PATH" ] && ASSETS+=("$APPIMAGE_PATH")

if $SIGNING_ENABLED && [ -n "$UPDATER_PATH" ]; then
  # If updater payload is the AppImage itself, it's already in $ASSETS.
  if [ "$UPDATER_PATH" != "$APPIMAGE_PATH" ]; then
    ASSETS+=("$UPDATER_PATH")
  fi
  ASSETS+=("$SIG_PATH")

  # Generate/merge latest.json. If a mac/windows build already uploaded one,
  # download it and merge in our linux entry without clobbering theirs.
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT

  EXISTING_MANIFEST=""
  if gh release view "v$VERSION" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
    if gh release download "v$VERSION" --repo "$RELEASE_REPO" --pattern 'latest.json' --dir "$TEMP_DIR" 2>/dev/null \
       && [ -f "$TEMP_DIR/latest.json" ]; then
      EXISTING_MANIFEST=$(cat "$TEMP_DIR/latest.json")
      echo "   Merging into existing latest.json from release"
    fi
  fi

  PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  NOTES=$(cat "$RELEASE_NOTES")
  SIG_CONTENT=$(cat "$SIG_PATH")
  UPDATER_URL="https://github.com/$RELEASE_REPO/releases/download/v$VERSION/$(basename "$UPDATER_PATH")"
  LATEST_JSON_PATH="$TEMP_DIR/latest.json"

  if [ -n "$EXISTING_MANIFEST" ]; then
    echo "$EXISTING_MANIFEST" | jq --arg ver "$VERSION" --arg notes "$NOTES" --arg date "$PUB_DATE" \
      --arg sig "$SIG_CONTENT" --arg url "$UPDATER_URL" --arg key "$PLATFORM_KEY" '
      .version = $ver |
      .notes = $notes |
      .pub_date = $date |
      (.platforms //= {}) |
      .platforms[$key] = {signature: $sig, url: $url}
    ' > "$LATEST_JSON_PATH"
  else
    jq -n --arg ver "$VERSION" --arg notes "$NOTES" --arg date "$PUB_DATE" \
      --arg sig "$SIG_CONTENT" --arg url "$UPDATER_URL" --arg key "$PLATFORM_KEY" '
      {
        version: $ver,
        notes: $notes,
        pub_date: $date,
        platforms: ({} | .[$key] = {signature: $sig, url: $url})
      }
    ' > "$LATEST_JSON_PATH"
  fi

  ASSETS+=("$LATEST_JSON_PATH")
fi

if gh release view "v$VERSION" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
  echo "   Release exists — uploading ${#ASSETS[@]} asset(s)"
  for asset in "${ASSETS[@]}"; do
    echo "   uploading $(basename "$asset")"
    gh release upload "v$VERSION" "$asset" --repo "$RELEASE_REPO" --clobber
  done
else
  echo "   Creating draft release with ${#ASSETS[@]} asset(s)"
  gh release create "v$VERSION" "${ASSETS[@]}" \
    --repo "$RELEASE_REPO" \
    --target "$RELEASE_TARGET" \
    --title "v$VERSION" \
    --notes-file "$RELEASE_NOTES" \
    --draft
fi

# Verify every asset landed.
PRESENT=$(gh release view "v$VERSION" --repo "$RELEASE_REPO" --json assets --jq '.assets[].name')
for asset in "${ASSETS[@]}"; do
  name=$(basename "$asset")
  if ! echo "$PRESENT" | grep -qFx "$name"; then
    echo "❌ Upload reported success but $name is missing from the release."
    echo "   Present: $PRESENT"
    exit 1
  fi
done

echo "✅ Drafted v$VERSION on $RELEASE_REPO — review and publish from the Releases page."
echo "    https://github.com/$RELEASE_REPO/releases/tag/v$VERSION"
