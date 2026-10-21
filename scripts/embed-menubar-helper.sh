#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Embed the menu-bar helper bundle into a built LunoPeak.app.
#
# LunoPeak ships as TWO macOS bundles sharing one binary so it can have BOTH a
# dock-icon window app AND a menu-bar popover that overlays fullscreen Spaces:
#
#   LunoPeak.app                                  (com.lunopeak.app, .regular)
#   └─ Contents/Library/LoginItems/
#      └─ LunoPeak Menu Bar.app                   (com.lunopeak.app.menubar,
#                                                  LSUIElement, .accessory)
#
# Two distinct bundle IDs is what stops the duplicate dock icon: macOS treats
# them as separate apps. The window process spawns the helper with `--menubar`.
#
# This script creates the helper bundle (copying the main binary), writes its
# Info.plist (LSUIElement), then signs INNER-first (helper) and re-seals the
# OUTER app so the nested helper is covered.
#
# Usage:
#   scripts/embed-menubar-helper.sh <path-to-LunoPeak.app> [signing-identity]
#
#   signing-identity defaults to "-" (ad-hoc) for local testing. For a
#   distributable build pass the Developer ID, e.g.:
#   scripts/embed-menubar-helper.sh build/LunoPeak.app "Developer ID Application: …"
# ─────────────────────────────────────────────────────────────────────────────

APP_PATH="${1:?usage: embed-menubar-helper.sh <LunoPeak.app> [identity]}"
IDENTITY="${2:--}"   # "-" = ad-hoc (fine for running locally; NOT notarizable)

APP_PATH="${APP_PATH%/}"
if [ ! -d "$APP_PATH" ]; then
  echo "❌ Not a directory: $APP_PATH"
  exit 1
fi

APP_NAME="LunoPeak"
HELPER_NAME="LunoPeak Menu Bar"
HELPER_ID="com.lunopeak.app.menubar"
MAIN_BIN="$APP_PATH/Contents/MacOS/$APP_NAME"

if [ ! -f "$MAIN_BIN" ]; then
  echo "❌ Main executable not found: $MAIN_BIN"
  exit 1
fi

# Mirror the main app's version so the helper isn't flagged as mismatched.
PLIST_BUDDY=/usr/libexec/PlistBuddy
MAIN_PLIST="$APP_PATH/Contents/Info.plist"
SHORT_VER=$("$PLIST_BUDDY" -c "Print :CFBundleShortVersionString" "$MAIN_PLIST" 2>/dev/null || echo "1.0.0")
BUNDLE_VER=$("$PLIST_BUDDY" -c "Print :CFBundleVersion" "$MAIN_PLIST" 2>/dev/null || echo "$SHORT_VER")
MIN_OS=$("$PLIST_BUDDY" -c "Print :LSMinimumSystemVersion" "$MAIN_PLIST" 2>/dev/null || echo "10.15")

HELPER_APP="$APP_PATH/Contents/Library/LoginItems/$HELPER_NAME.app"
HELPER_MACOS="$HELPER_APP/Contents/MacOS"

echo "🧩 Embedding $HELPER_NAME.app into $APP_NAME.app"
rm -rf "$HELPER_APP"
mkdir -p "$HELPER_MACOS"

# Copy the universal binary — the helper runs the same code, told to be the
# agent by the `--menubar` flag the window process passes when it `open`s it.
cp "$MAIN_BIN" "$HELPER_MACOS/$APP_NAME"
chmod +x "$HELPER_MACOS/$APP_NAME"

# Helper Info.plist. LSUIElement=true → no dock icon, ever; distinct bundle id
# → its own LaunchServices identity (the whole point).
cat > "$HELPER_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$HELPER_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$HELPER_NAME</string>
  <key>CFBundleDisplayName</key><string>$HELPER_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$SHORT_VER</string>
  <key>CFBundleVersion</key><string>$BUNDLE_VER</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST

# ── Signing ──────────────────────────────────────────────────────────────────
# The helper runs a WebKit webview (the popover), so it needs the same JIT /
# unsigned-memory entitlements the main app has. Pull them straight off the
# already-signed main app so they always match; fall back to a minimal webview
# set if extraction fails (e.g. ad-hoc inputs).
ENT_FILE="$(mktemp -t lunopeak-helper-ent).plist"
trap 'rm -f "$ENT_FILE"' EXIT

if codesign -d --entitlements :- "$APP_PATH" > "$ENT_FILE" 2>/dev/null && [ -s "$ENT_FILE" ]; then
  echo "✓ Reusing entitlements from $APP_NAME.app"
else
  echo "⚠️  Could not read main app entitlements — using minimal webview set"
  cat > "$ENT_FILE" <<'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
ENT
fi

# Real identities need a SECURE TIMESTAMP and hardened runtime for
# notarization. Ad-hoc ("-") can't timestamp (no network identity) and is
# local-only, so disable it there for a fast build.
if [ "$IDENTITY" = "-" ]; then
  SIGN_OPTS=(--timestamp=none)
else
  SIGN_OPTS=(--timestamp --options runtime)
fi

echo "🔏 Signing helper (inner) with identity: $IDENTITY"
codesign --force "${SIGN_OPTS[@]}" \
  --entitlements "$ENT_FILE" --sign "$IDENTITY" "$HELPER_APP"

echo "🔏 Re-sealing $APP_NAME.app (outer) to cover the embedded helper"
codesign --force "${SIGN_OPTS[@]}" \
  --entitlements "$ENT_FILE" --sign "$IDENTITY" "$APP_PATH"

echo "🔍 Verifying signatures…"
codesign --verify --strict --verbose=2 "$HELPER_APP" 2>&1 | tail -3
codesign --verify --strict --verbose=2 "$APP_PATH" 2>&1 | tail -3

echo ""
echo "✅ Embedded + signed: $HELPER_APP"
echo "   Launch $APP_PATH and verify a SINGLE dock icon through open/close cycles."
