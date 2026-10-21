#!/bin/bash
set -euo pipefail

# ─── install-linux.sh ───────────────────────────────────────────────────────
# Install a freshly-built LunoPeak AppImage on the local machine, removing any
# previously-installed copy first.
#
# Why this exists: on systems with AppImageLauncher (common on Ubuntu/KDE),
# AppImages are "integrated" — copied into ~/Applications and given a .desktop
# launcher whose Exec= points at that specific copy. Dropping a new build next
# to it does nothing: the menu/launcher keeps starting the OLD integrated copy.
# Symptom: "I installed the new version but the old one persists." This script
# removes the stale integration (binary + .desktop + icons), then stages and
# launches the new build so AppImageLauncher re-integrates it cleanly.
#
# Usage:
#   scripts/install-linux.sh [path/to/LunoPeak_x.y.z_amd64.AppImage]
#
#   No argument → auto-pick the newest LunoPeak_*.AppImage under the build
#   output (src-tauri/target/*/release/bundle/appimage/).
#
# Flags:
#   --no-launch   Stage + integrate but don't launch the app afterward.
# ────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="LunoPeak"
# Reverse-DNS identifier == GTK/Wayland app-id (app.enableGTKAppId=true). The
# taskbar icon only resolves when the integrated .desktop has a matching
# StartupWMClass. Fall back to the known value if node/config is unavailable.
APP_ID="$(node -p "require('$PROJECT_DIR/src-tauri/tauri.conf.json').identifier" 2>/dev/null || echo com.lunopeak.app)"
APPS_DIR="$HOME/Applications"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_ROOT="$HOME/.local/share/icons"

LAUNCH=1
SRC_ARG=""
for arg in "$@"; do
  case "$arg" in
    --no-launch) LAUNCH=0 ;;
    -*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *) SRC_ARG="$arg" ;;
  esac
done

# ─── Locate the AppImage to install ─────────────────────────────────────────
if [ -n "$SRC_ARG" ]; then
  SRC="$SRC_ARG"
  if [ ! -f "$SRC" ]; then
    echo "❌ Not found: $SRC" >&2
    exit 1
  fi
else
  # Newest LunoPeak_*.AppImage anywhere under the build output. -printf sorts
  # by mtime so re-running after a rebuild always grabs the latest.
  BUNDLE_GLOB="$PROJECT_DIR/src-tauri/target"
  SRC="$(find "$BUNDLE_GLOB" -path '*/release/bundle/appimage/*.AppImage' \
           -name "${APP_NAME}_*.AppImage" -printf '%T@\t%p\n' 2>/dev/null \
         | sort -rn | head -1 | cut -f2-)"
  if [ -z "$SRC" ]; then
    echo "❌ No built ${APP_NAME} AppImage found under $BUNDLE_GLOB" >&2
    echo "   Build one first:  npm run tauri:build   (or scripts/build-linux.sh)" >&2
    exit 1
  fi
fi

echo "📦 Installing: $SRC"

# ─── Stop any running instance ──────────────────────────────────────────────
# The Tauri binary runs as "LunoPeak". Kill it so we don't overwrite a copy
# that's still mapped, and so the freshly-installed build is the one running.
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "🛑 Stopping running ${APP_NAME}"
  pkill -x "$APP_NAME" 2>/dev/null || true
  sleep 1
  pkill -9 -x "$APP_NAME" 2>/dev/null || true
fi

# ─── Remove any currently-installed copy ────────────────────────────────────
# AppImageLauncher ships a remove helper that trashes the binary and (usually)
# its integration. Path varies by arch; probe the common locations.
REMOVE_HELPER=""
for cand in \
  /usr/lib/x86_64-linux-gnu/appimagelauncher/remove \
  /usr/lib/aarch64-linux-gnu/appimagelauncher/remove \
  /usr/lib/appimagelauncher/remove; do
  if [ -x "$cand" ]; then REMOVE_HELPER="$cand"; break; fi
done

shopt -s nullglob
OLD_APPIMAGES=("$APPS_DIR/${APP_NAME}"*.AppImage)
if [ ${#OLD_APPIMAGES[@]} -gt 0 ]; then
  echo "🧹 Removing ${#OLD_APPIMAGES[@]} existing ${APP_NAME} copy/copies in $APPS_DIR"
  for old in "${OLD_APPIMAGES[@]}"; do
    if [ -n "$REMOVE_HELPER" ]; then
      # The helper's GUI dialog can't run headless, but it still trashes the
      # binary; we sweep the leftover .desktop + icons manually below.
      "$REMOVE_HELPER" "$old" >/dev/null 2>&1 || true
    fi
    rm -f "$old"
  done
fi

# Sweep leftover AppImageLauncher integration artifacts for LunoPeak. The
# remove helper frequently leaves these behind, and orphaned ones accumulate
# across versions — they're what keep a dead launcher in the app menu.
echo "🧹 Sweeping stale desktop entries and icons"
rm -f "$DESKTOP_DIR"/appimagekit_*"${APP_NAME}".desktop 2>/dev/null || true
# Match both naming variants AppImageLauncher has used: *-Name.desktop and
# *_Name.desktop / *_Name.png.
find "$DESKTOP_DIR" -maxdepth 1 -iname "*${APP_NAME}*.desktop" -delete 2>/dev/null || true
find "$ICON_ROOT" -iname "*${APP_NAME}*.png" -delete 2>/dev/null || true

# ─── Stage the new build ────────────────────────────────────────────────────
mkdir -p "$APPS_DIR"
DST="$APPS_DIR/$(basename "$SRC")"
cp -f "$SRC" "$DST"
chmod +x "$DST"
echo "✅ Staged: $DST"

# Refresh desktop + icon caches so the old launcher really disappears.
command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f "$ICON_ROOT/hicolor" >/dev/null 2>&1 || true

# ─── Launch (AppImageLauncher re-integrates on first run) ───────────────────
if [ "$LAUNCH" -eq 1 ]; then
  echo "🚀 Launching — if AppImageLauncher prompts, choose “Integrate and run”."
  setsid "$DST" >/dev/null 2>&1 < /dev/null &

  # Guarantee the taskbar/dock icon resolves on Wayland. GNOME matches a
  # window's app-id to a .desktop file and uses that file's Icon=; the app-id
  # is the GTK identifier ("$APP_ID"), so the integrated entry needs
  # StartupWMClass=$APP_ID or the compositor shows a generic icon. The build
  # bakes this into the AppImage's internal .desktop, but AppImageLauncher
  # generates the integrated entry asynchronously (after the user clicks its
  # dialog) and may carry over a stale/missing value — so poll briefly and fix.
  ( for _ in $(seq 1 20); do
      sleep 1
      entry=$(find "$DESKTOP_DIR" -maxdepth 1 -iname "*${APP_NAME}*.desktop" 2>/dev/null | head -1)
      [ -z "$entry" ] && continue
      if grep -q '^StartupWMClass=' "$entry"; then
        grep -q "^StartupWMClass=$APP_ID$" "$entry" \
          || sed -i "s/^StartupWMClass=.*/StartupWMClass=$APP_ID/" "$entry"
      else
        sed -i "/^\[Desktop Entry\]/a StartupWMClass=$APP_ID" "$entry"
      fi
      update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
      break
    done ) &
else
  echo "ℹ️  Skipped launch (--no-launch). Run it from your app menu, or:"
  echo "     $DST"
fi

echo "🎉 Done."
