#!/bin/bash
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load credentials from .env
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
else
  echo "❌ .env file not found at $PROJECT_DIR/.env"
  echo "   Copy .env.example and fill in your Apple credentials."
  exit 1
fi

: "${APPLE_ID:?APPLE_ID is not set in .env}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is not set in .env}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is not set in .env}"

APP_NAME="LunoPeak"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Tim Murphy ($APPLE_TEAM_ID)}"

# Releases live on the public distribution repo, NOT on the private code repo.
RELEASE_REPO="idevtim/lunopeak"
RELEASE_TARGET="main"

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

# ─── Pre-flight: signing identity exists ────────────────────────────────────
if ! security find-identity -v -p codesigning | grep -qF "$SIGNING_IDENTITY"; then
  echo "❌ Signing identity not found in keychain:"
  echo "   $SIGNING_IDENTITY"
  echo "   Available identities:"
  security find-identity -v -p codesigning | sed 's/^/     /'
  exit 1
fi
echo "✓ Signing identity present: $SIGNING_IDENTITY"

# ─── Pre-flight: rust targets installed ─────────────────────────────────────
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  if ! rustup target list --installed | grep -q "^$target$"; then
    echo "🦀 Installing missing rust target: $target"
    rustup target add "$target"
  fi
done

# ─── Build (Tauri codesigns the .app; we notarize after embedding the helper) ─
# macOS ships as TWO bundles sharing one binary (see embed step below). The
# helper has to be injected into the .app *after* Tauri assembles + signs it,
# which invalidates any notarization — so we let Tauri SIGN but NOT notarize
# here (APPLE_ID/PASSWORD/TEAM are exported later, just before our own
# notarytool calls), then notarize the final app + DMG ourselves.
#   APPLE_SIGNING_IDENTITY → codesign identity name (read by the Tauri bundler)
export APPLE_SIGNING_IDENTITY="$SIGNING_IDENTITY"

echo "🔨 Building $APP_NAME v$VERSION (universal: arm64 + x86_64)..."
echo "   Tauri codesigns the .app; helper-embed + notarize/DMG happen below."
cd "$PROJECT_DIR"

BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/universal-apple-darwin/release/bundle"

# Wipe any prior bundle output. Tauri doesn't always overwrite cleanly when
# inputs haven't changed, so a stale DMG / .app.tar.gz from a previous version
# can otherwise be picked up by the asset-locating logic below.
if [ -d "$BUNDLE_DIR" ]; then
  echo "🧹 Clearing previous bundle output: $BUNDLE_DIR"
  rm -rf "$BUNDLE_DIR"
fi

npm run tauri:build -- --target universal-apple-darwin
APP_PATH="$BUNDLE_DIR/macos/$APP_NAME.app"
DMG_PATH="$BUNDLE_DIR/dmg/${APP_NAME}_${VERSION}_universal.dmg"
TARGZ_PATH="$BUNDLE_DIR/macos/$APP_NAME.app.tar.gz"
SIG_PATH="$TARGZ_PATH.sig"

if [ ! -d "$APP_PATH" ] || [ ! -f "$DMG_PATH" ]; then
  echo "❌ Build did not produce expected artifacts:"
  echo "   $APP_PATH"
  echo "   $DMG_PATH"
  exit 1
fi

if $SIGNING_ENABLED; then
  if [ ! -f "$TARGZ_PATH" ] || [ ! -f "$SIG_PATH" ]; then
    echo "❌ Signing was enabled but updater payload is missing:"
    echo "   $TARGZ_PATH"
    echo "   $SIG_PATH"
    exit 1
  fi
  echo "✓ Tauri updater payload present (will be regenerated post-embed)"
fi

# ─── Embed the Liquid Glass app icon ────────────────────────────────────────
# Tauri only ships the flat icon.icns. macOS 26+ renders the layered icon from
# Assets.car instead, so compile src-tauri/icons/LunoPeak.icon and inject it.
# This runs BEFORE the helper embed on purpose: both modify Contents/ and
# invalidate Tauri's signature, and the helper embed re-seals the outer bundle.
"$SCRIPT_DIR/embed-glass-icon.sh" "$APP_PATH"

# ─── Embed the menu-bar helper bundle + regenerate stale artifacts ──────────
# LunoPeak ships as two macOS bundles sharing one binary so it can have BOTH a
# dock-icon window app AND a menu-bar popover that overlays other apps'
# fullscreen Spaces (activation policy is per-process — see src/macos_agent.rs):
#   LunoPeak.app                                   (com.lunopeak.app, .regular)
#   └─ Contents/Library/LoginItems/
#      └─ LunoPeak Menu Bar.app   (com.lunopeak.app.menubar, LSUIElement, agent)
# Tauri built + signed the main app; inject + sign the nested helper now. That
# modifies the .app, so the updater payload and DMG Tauri produced are stale —
# regenerate both, and notarize the final app.
echo "🧩 Embedding menu-bar helper into $APP_NAME.app..."
"$SCRIPT_DIR/embed-menubar-helper.sh" "$APP_PATH" "$SIGNING_IDENTITY"

# notarytool credentials (deferred from the build step above).
export APPLE_ID
export APPLE_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"
export APPLE_TEAM_ID

echo "📤 Notarizing $APP_NAME.app with embedded helper (1–5 min)..."
APP_ZIP="$BUNDLE_DIR/macos/${APP_NAME}-notarize.zip"
ditto -c -k --keepParent "$APP_PATH" "$APP_ZIP"
xcrun notarytool submit "$APP_ZIP" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "$APP_PATH"
rm -f "$APP_ZIP"

if $SIGNING_ENABLED; then
  echo "📦 Regenerating updater payload from the stapled .app..."
  rm -f "$TARGZ_PATH" "$SIG_PATH"
  # `--no-mac-metadata --no-xattrs` (plus COPYFILE_DISABLE for good measure) are
  # NOT optional. macOS bsdtar otherwise emits an AppleDouble `._name` sidecar
  # entry for every path carrying an xattr — and notarizing/stapling leaves
  # xattrs on nearly everything. Those sidecars are invisible to `tar -tzf` on
  # macOS (bsdtar folds them back into xattrs when reading) but Tauri's updater
  # uses the Rust `tar` crate, which sees them. It strips the leading path
  # component of every entry (`entry.path()?.iter().skip(1)`) assuming each is
  # under `LunoPeak.app/`; the top-level `._LunoPeak.app` sidecar has only ONE
  # component, so it collapses to an empty path and the updater tries to unpack
  # a regular file onto its own temp dir — "failed to unpack `._LunoPeak.app`".
  # Every update from a bundle built without these flags fails at install time.
  COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs \
    -czf "$TARGZ_PATH" -C "$BUNDLE_DIR/macos" "$APP_NAME.app"
  # Guard: assert no AppleDouble entries survived. bsdtar hides them even under
  # `--no-mac-metadata -tzf`, so the archive has to be read by something that
  # doesn't consolidate them — python3 (Xcode CLT) is the one always on hand.
  if ! command -v python3 >/dev/null 2>&1; then
    echo "❌ python3 not found — cannot verify the updater payload is AppleDouble-free."
    exit 1
  fi
  AD_ENTRIES=$(python3 -c "
import tarfile
print('\n'.join(n for n in tarfile.open('$TARGZ_PATH').getnames()
                if n.split('/')[-1].startswith('._')))
")
  if [ -n "$AD_ENTRIES" ]; then
    echo "❌ Updater payload contains AppleDouble (._*) entries — updates would fail:"
    echo "$AD_ENTRIES" | sed 's/^/     /'
    exit 1
  fi
  echo "✓ Updater payload is free of AppleDouble entries"
  # Sign the tarball with the updater (minisign) key — same key Tauri's bundler
  # used; writes "$TARGZ_PATH.sig". `--private-key` (string) is mutually
  # exclusive with the TAURI_SIGNING_PRIVATE_KEY_PATH env var (read as
  # --private-key-path), so drop that env for this one call.
  env -u TAURI_SIGNING_PRIVATE_KEY_PATH npx @tauri-apps/cli signer sign \
    --private-key "$TAURI_SIGNING_PRIVATE_KEY" \
    --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" \
    "$TARGZ_PATH"
  if [ ! -f "$SIG_PATH" ]; then
    echo "❌ Updater signature missing after re-sign: $SIG_PATH"
    exit 1
  fi
  echo "✓ Updater payload regenerated + signed"
fi

echo "💿 Rebuilding DMG with the embedded helper..."
# We have to rebuild by hand because the helper-embed step (above) modifies the
# .app *after* Tauri produced its DMG, leaving Tauri's styled DMG stale. A bare
# `hdiutil create` yields a plain Finder window (no background, unpositioned
# icons), so reproduce Tauri's default styled layout with create-dmg instead:
# fixed window size, app icon left, Applications drop-link right.
rm -f "$DMG_PATH"
mkdir -p "$(dirname "$DMG_PATH")"
DMG_STAGE="$(mktemp -d)"
cp -R "$APP_PATH" "$DMG_STAGE/$APP_NAME.app"
# create-dmg adds the /Applications drop-link itself (--app-drop-link), so the
# stage holds only the .app. It can exit non-zero on a benign detach hiccup
# while still writing a valid DMG, so guard it and verify the file afterward.
create-dmg \
  --volname "$APP_NAME" \
  --volicon "$PROJECT_DIR/src-tauri/icons/icon.icns" \
  --window-pos 200 120 \
  --window-size 660 400 \
  --icon-size 100 \
  --icon "$APP_NAME.app" 180 170 \
  --app-drop-link 480 170 \
  --hide-extension "$APP_NAME.app" \
  "$DMG_PATH" \
  "$DMG_STAGE" || true
rm -rf "$DMG_STAGE"
if [ ! -f "$DMG_PATH" ]; then
  echo "❌ create-dmg did not produce a DMG at $DMG_PATH"
  exit 1
fi
codesign --force --timestamp --sign "$SIGNING_IDENTITY" "$DMG_PATH"

# ─── Notarize + staple the DMG ──────────────────────────────────────────────
# The .app inside is already notarized + stapled above; notarize the DMG
# wrapper too so Gatekeeper doesn't have to fetch the ticket online on first
# launch.
echo "📤 Submitting DMG to notarytool (this can take 1–5 min)..."
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "📎 Stapling notarization ticket to DMG..."
xcrun stapler staple "$DMG_PATH"

# ─── Verify ─────────────────────────────────────────────────────────────────
echo "🔍 Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | tail -5

echo "🔍 Verifying notarization ticket on DMG..."
if ! xcrun stapler validate "$DMG_PATH" 2>&1 | tail -5; then
  echo "❌ Stapler validation failed — DMG is not notarized."
  exit 1
fi

echo "🔍 Final Gatekeeper check on .app..."
spctl --assess --type execute --verbose "$APP_PATH" 2>&1 | tail -5 || {
  echo "⚠️  spctl assessment failed; the app may still work but Gatekeeper will warn."
}

echo ""
echo "✅ Build complete: $DMG_PATH (v$VERSION)"

# ─── GitHub Release ─────────────────────────────────────────────────────────
if gh auth status >/dev/null 2>&1; then
  echo "🚀 Drafting GitHub release v$VERSION on $RELEASE_REPO..."
  # Source tag on origin (lunopeak-app) for code traceability.
  git tag "v$VERSION" 2>/dev/null || echo "   Tag v$VERSION already exists on origin"
  git push origin "v$VERSION" 2>&1 || echo "   (tag push skipped or already pushed)"

  # Build the asset list. DMG is always uploaded (first-install download).
  # Updater payload (.app.tar.gz + .sig) and latest.json only when signing.
  ASSETS=("$DMG_PATH")

  if $SIGNING_ENABLED; then
    ASSETS+=("$TARGZ_PATH" "$SIG_PATH")

    # Generate/merge latest.json. If a Windows build already uploaded one,
    # download it and merge in our darwin entries without clobbering theirs.
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
    TAR_URL="https://github.com/$RELEASE_REPO/releases/download/v$VERSION/$(basename "$TARGZ_PATH")"
    LATEST_JSON_PATH="$TEMP_DIR/latest.json"

    # `darwin-aarch64` and `darwin-x86_64` both point at the universal tarball
    # — Tauri's updater picks the entry matching the running arch and either
    # works.
    if [ -n "$EXISTING_MANIFEST" ]; then
      echo "$EXISTING_MANIFEST" | jq --arg ver "$VERSION" --arg notes "$NOTES" --arg date "$PUB_DATE" \
        --arg sig "$SIG_CONTENT" --arg url "$TAR_URL" '
        .version = $ver |
        .notes = $notes |
        .pub_date = $date |
        (.platforms //= {}) |
        .platforms["darwin-aarch64"] = {signature: $sig, url: $url} |
        .platforms["darwin-x86_64"] = {signature: $sig, url: $url}
      ' > "$LATEST_JSON_PATH"
    else
      jq -n --arg ver "$VERSION" --arg notes "$NOTES" --arg date "$PUB_DATE" \
        --arg sig "$SIG_CONTENT" --arg url "$TAR_URL" '
        {
          version: $ver,
          notes: $notes,
          pub_date: $date,
          platforms: {
            "darwin-aarch64": {signature: $sig, url: $url},
            "darwin-x86_64": {signature: $sig, url: $url}
          }
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
else
  echo "ℹ️  Skipping GitHub release — run \`gh auth login\` to enable."
  echo "    Manual: gh release create v$VERSION \"$DMG_PATH\" --repo $RELEASE_REPO --target $RELEASE_TARGET --title v$VERSION --notes-file \"$RELEASE_NOTES\" --draft"
fi
