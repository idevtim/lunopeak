#!/usr/bin/env bash
# Regenerate all Tauri icon assets from src-tauri/icons/source.png.
#
# Tauri CLI's `icon` command emits a Windows .ico that omits the 128px frame,
# which Windows 11 picks for several shell surfaces. We let the CLI build the
# full set, then overwrite icon.ico with an ImageMagick build that includes
# 16/24/32/48/64/128/256 frames.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONS_DIR="$REPO_ROOT/src-tauri/icons"
SOURCE="$ICONS_DIR/source.png"

if [[ ! -f "$SOURCE" ]]; then
  echo "error: $SOURCE not found — drop a 1024×1024 PNG there first." >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick (magick) not on PATH. Install with: brew install imagemagick" >&2
  exit 1
fi

echo "→ Generating Tauri icon set from $SOURCE"
npx @tauri-apps/cli icon "$SOURCE" --output "$ICONS_DIR"

# Windows shell surfaces render the icon edge-to-edge, so the macOS-style safe
# area in source.png leaves it looking small. Trim transparent padding and
# rescale to 1024 before building the .ico so the icon fills 100% of each
# frame.
echo "→ Rebuilding icon.ico (trimmed, full-bleed) with 16,24,32,48,64,128,256 frames"
TRIMMED_SOURCE="$(mktemp -t lunopeak-ico-source).png"
trap 'rm -f "$TRIMMED_SOURCE"' EXIT
magick "$SOURCE" -trim +repage -resize 1024x1024 -background none -gravity center -extent 1024x1024 "$TRIMMED_SOURCE"
magick "$TRIMMED_SOURCE" -define icon:auto-resize=16,24,32,48,64,128,256 "$ICONS_DIR/icon.ico"

echo "✅ Done. Frames in icon.ico:"
magick identify "$ICONS_DIR/icon.ico" | awk '{print "   " $3}'
