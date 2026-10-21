#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Compile src-tauri/icons/LunoPeak.icon (Icon Composer) and inject it into a
# built LunoPeak.app so macOS 26+ renders the Liquid Glass app icon.
#
# Tauri's bundler only knows about flat rasters — it writes icon.icns and points
# CFBundleIconFile at it. A glass icon is not a raster: it's a layered vector
# document that the system re-renders per size, per appearance (light/dark/tint)
# and per specular pass. That lives in a compiled asset catalog, so the .app
# needs Assets.car plus CFBundleIconName naming the icon inside it.
#
# actool compiles a .icon standalone — no Xcode project required:
#
#   Assets.car    the layered icon; what macOS 26+ actually renders
#   LunoPeak.icns the flattened fallback (--standalone-icon-behavior all),
#                 which is what macOS 15 and earlier see. It overwrites Tauri's
#                 icon.icns so the bundle carries exactly one icns and
#                 CFBundleIconFile keeps resolving on old systems.
#
# Run this BEFORE embed-menubar-helper.sh: modifying Contents/ invalidates the
# app's signature, and the helper embed re-seals the outer bundle afterwards.
#
# Usage:
#   scripts/embed-glass-icon.sh <path-to-LunoPeak.app>
#   scripts/embed-glass-icon.sh --preview     # render only, no .app needed
#
# --preview compiles the icon and opens the rendered 512px frame, so the art can
# be iterated without sitting through a full signed release build.
# ─────────────────────────────────────────────────────────────────────────────

MODE="embed"
if [ "${1:-}" = "--preview" ]; then
  MODE="preview"
  APP_PATH=""
else
  APP_PATH="${1:?usage: embed-glass-icon.sh <LunoPeak.app> | --preview}"
  APP_PATH="${APP_PATH%/}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

ICON_NAME="LunoPeak"
ICON_SRC="$PROJECT_DIR/src-tauri/icons/$ICON_NAME.icon"
RESOURCES="$APP_PATH/Contents/Resources"
PLIST="$APP_PATH/Contents/Info.plist"
PLIST_BUDDY=/usr/libexec/PlistBuddy

# The deployment target actool compiles for. Glass rendering is a macOS 26
# feature; below it actool emits only the flattened icns. This is unrelated to
# the app's own LSMinimumSystemVersion (10.15) — the fallback icns covers those.
GLASS_TARGET="26.0"

if [ "$MODE" = "embed" ] && [ ! -d "$APP_PATH" ]; then
  echo "❌ Not a directory: $APP_PATH" >&2
  exit 1
fi

if [ ! -d "$ICON_SRC" ]; then
  echo "❌ Icon Composer bundle not found: $ICON_SRC" >&2
  exit 1
fi

if ! xcrun --find actool >/dev/null 2>&1; then
  echo "❌ actool not found. Install Xcode (not just the Command Line Tools)" >&2
  echo "   and select it: sudo xcode-select -s /Applications/Xcode.app" >&2
  exit 1
fi

if [ "$MODE" = "preview" ]; then
  echo "🎨 Compiling $ICON_NAME.icon (Liquid Glass) for preview"
else
  echo "🎨 Compiling $ICON_NAME.icon (Liquid Glass) into $(basename "$APP_PATH")"
fi

STAGE="$(mktemp -d -t lunopeak-glass-icon)"
trap 'rm -rf "$STAGE"' EXIT

# actool writes its compilation report to stdout as a plist. Let it through only
# on failure — on success it's 20 lines of noise in the middle of a release log.
if ! ACTOOL_LOG="$(xcrun actool "$ICON_SRC" \
      --compile "$STAGE" \
      --app-icon "$ICON_NAME" \
      --standalone-icon-behavior all \
      --output-partial-info-plist "$STAGE/partial.plist" \
      --platform macosx \
      --minimum-deployment-target "$GLASS_TARGET" \
      --enable-on-demand-resources NO 2>&1)"; then
  echo "❌ actool failed:" >&2
  echo "$ACTOOL_LOG" >&2
  exit 1
fi

if [ ! -f "$STAGE/Assets.car" ]; then
  echo "❌ actool produced no Assets.car — the glass icon would be missing." >&2
  echo "$ACTOOL_LOG" >&2
  exit 1
fi

if [ ! -f "$STAGE/$ICON_NAME.icns" ]; then
  echo "❌ actool produced no $ICON_NAME.icns fallback." >&2
  echo "   Check --standalone-icon-behavior is still supported by this Xcode." >&2
  exit 1
fi

if [ "$MODE" = "preview" ]; then
  OUT_DIR="$PROJECT_DIR/src-tauri/icons/.preview"
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"

  # The icns is the flattened render of the same layer stack, so its frames are
  # a faithful look at the default appearance at every size macOS ships.
  iconutil -c iconset "$STAGE/$ICON_NAME.icns" -o "$OUT_DIR/$ICON_NAME.iconset"
  cp "$OUT_DIR/$ICON_NAME.iconset/icon_512x512@2x.png" "$OUT_DIR/01-Default-1024.png"

  # macOS renders the icon differently per appearance, and Dark is authored
  # rather than automatic (see the Moon layer's specializations in icon.json) —
  # so it needs looking at, not assuming. ictool renders one appearance at a
  # time; actool emits the whole stack with no way to view a single rendition.
  #
  # NOT `xcrun ictool`: two different binaries ship under that name, and the one
  # on the developer path is an actool sibling that has no --export-image. It
  # reports the unknown argument in a plist and still exits 0, so the file it
  # didn't write is the only reliable signal — hence the -s test below, not $?.
  ICTOOL="$(xcode-select -p)/../Applications/Icon Composer.app/Contents/Executables/ictool"

  if [ -x "$ICTOOL" ]; then
    rendered=0
    n=1
    for rendition in Dark ClearLight ClearDark TintedLight TintedDark; do
      n=$((n + 1))
      shot="$OUT_DIR/$(printf '%02d' $n)-$rendition.png"
      "$ICTOOL" "$ICON_SRC" --export-image --output-file "$shot" \
        --platform macOS --rendition "$rendition" \
        --width 512 --height 512 --scale 1 >/dev/null 2>&1 || true
      if [ -s "$shot" ]; then
        rendered=$((rendered + 1))
      else
        rm -f "$shot"
        echo "   (skipped $rendition — ictool produced nothing)"
      fi
    done
    echo "✅ Rendered the default appearance plus $rendered more into $OUT_DIR"
    echo "   Select all in Finder and hit space to flip through them."
  else
    echo "✅ Rendered $OUT_DIR/01-Default-1024.png (all sizes in $ICON_NAME.iconset/)"
    echo "   Icon Composer's ictool wasn't at $ICTOOL,"
    echo "   so only the default appearance was rendered."
  fi

  open "$OUT_DIR" 2>/dev/null || true
  exit 0
fi

mkdir -p "$RESOURCES"
cp "$STAGE/Assets.car" "$RESOURCES/Assets.car"

# Replace Tauri's flat icns in place so CFBundleIconFile ("icon") still points
# at real art on pre-26 macOS, and the bundle never carries two rival icons.
cp "$STAGE/$ICON_NAME.icns" "$RESOURCES/icon.icns"

# CFBundleIconName is what routes macOS 26+ to the catalog. Without it the
# system falls back to the flat icns and the glass treatment silently vanishes.
"$PLIST_BUDDY" -c "Delete :CFBundleIconName" "$PLIST" >/dev/null 2>&1 || true
"$PLIST_BUDDY" -c "Add :CFBundleIconName string $ICON_NAME" "$PLIST"

echo "   Assets.car   $(du -h "$RESOURCES/Assets.car" | cut -f1)"
echo "   icon.icns    $(du -h "$RESOURCES/icon.icns" | cut -f1) (flattened fallback)"
echo "   Info.plist   CFBundleIconName = $ICON_NAME"
echo "✅ Glass icon embedded. The app must be re-signed after this."
