#!/bin/bash
# Prune src-tauri/target before a release build.
#
# Cargo never garbage-collects: every version bump, dependency update, and
# toolchain upgrade leaves the previous hashed artifacts in deps/, build/, and
# incremental/ alongside the new ones, so target/ only ever grows (100+ GB is
# normal after a few months of `tauri:dev` + releases).
#
# Runs once per version: the first release build after a bump wipes every
# build cache EXCEPT the universal bundle dir the build script clears itself,
# then records the version in target/.last-dist-version. Re-running the same
# version (e.g. retrying after a notarization hiccup) skips the prune so the
# retry stays incremental.
#
# Wiped: debug/ and every <triple>/debug (the `tauri:dev` / test cache —
# the next dev run recompiles once), release/ (plain `tauri:build`, unused by
# the universal DMG), and <triple>/release (rebuilt clean for the release).
#
# Usage: prune-target.sh <version>
#   LUNOPEAK_PRUNE=force  prune even if the version hasn't changed
#   LUNOPEAK_PRUNE=skip   never prune
set -euo pipefail

VERSION="${1:?usage: prune-target.sh <version>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${CARGO_TARGET_DIR:-$(dirname "$SCRIPT_DIR")/src-tauri/target}"
STAMP="$TARGET_DIR/.last-dist-version"

case "${LUNOPEAK_PRUNE:-auto}" in
  skip) echo "ℹ️  LUNOPEAK_PRUNE=skip — leaving $TARGET_DIR as-is"; exit 0 ;;
  force) ;;
  *)
    if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$VERSION" ]; then
      echo "✓ target/ already pruned for v$VERSION (LUNOPEAK_PRUNE=force to redo)"
      exit 0
    fi
    ;;
esac

[ -d "$TARGET_DIR" ] || { mkdir -p "$TARGET_DIR"; echo "$VERSION" > "$STAMP"; exit 0; }

BEFORE=$(du -sk "$TARGET_DIR" | cut -f1)
echo "🧹 Pruning stale build caches in $TARGET_DIR (v$VERSION)..."

shopt -s nullglob
for dir in "$TARGET_DIR"/debug "$TARGET_DIR"/release "$TARGET_DIR"/*/debug "$TARGET_DIR"/*/release; do
  # The universal dir only holds the lipo'd binary + bundle output, which
  # build-dmg.sh manages itself.
  case "$dir" in */universal-apple-darwin/*) continue ;; esac
  [ -d "$dir" ] || continue
  echo "   rm $(basename "$(dirname "$dir")")/$(basename "$dir") ($(du -sh "$dir" | cut -f1))"
  rm -rf "$dir"
done

echo "$VERSION" > "$STAMP"
AFTER=$(du -sk "$TARGET_DIR" | cut -f1)
echo "✓ Freed $(( (BEFORE - AFTER) / 1024 / 1024 )) GB (target/ now $(du -sh "$TARGET_DIR" | cut -f1))"
