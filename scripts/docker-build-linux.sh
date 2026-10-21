#!/bin/bash
set -euo pipefail

# Runs the Linux release build inside an amd64 Ubuntu container, so it can be
# driven from a machine that isn't Linux (in practice: an Apple Silicon Mac).
#
# This is a thin driver — the actual build/sign/release logic stays in
# scripts/build-linux.sh, which runs unmodified inside the container exactly as
# it would on a real Linux box.
#
# Usage:
#   ./scripts/docker-build-linux.sh                # build + draft GitHub release
#   ./scripts/docker-build-linux.sh --build-only   # build bundles, no tag/upload
#   ./scripts/docker-build-linux.sh --shell        # interactive shell in the env
#   ./scripts/docker-build-linux.sh --rebuild      # force image rebuild first

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE="lunopeak-linux-build"
DOCKERFILE="$PROJECT_DIR/docker/Dockerfile.linux-build"

# Named volumes keep Linux build state out of the bind-mounted source tree.
# This matters more than it looks: node_modules on the host holds macOS-native
# binaries (esbuild, rollup), and src-tauri/target holds Mach-O objects. If the
# container saw either through the bind mount, the build would fail in
# confusing ways or silently mix architectures.
VOL_NODE_MODULES="lunopeak-linux-node-modules"
VOL_CARGO_REGISTRY="lunopeak-linux-cargo-registry"
VOL_CARGO_GIT="lunopeak-linux-cargo-git"
VOL_TARGET="lunopeak-linux-target"
# Tauri downloads linuxdeploy + its AppImage plugin here on first bundle, and
# build-linux.sh caches appimagetool alongside them. Persisting the dir saves
# re-fetching all three on every run.
VOL_TAURI_CACHE="lunopeak-linux-tauri-cache"

MODE="release"
FORCE_REBUILD=false
while [ $# -gt 0 ]; do
  case "$1" in
    --build-only) MODE="build-only"; shift ;;
    --shell)      MODE="shell"; shift ;;
    --rebuild)    FORCE_REBUILD=true; shift ;;
    -h|--help)    sed -n '6,16p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ─── Pre-flight: docker ─────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker not on PATH. Install Docker Desktop and re-run."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker daemon not reachable. Start Docker Desktop and re-run:"
  echo "     open -a Docker"
  exit 1
fi

# LTO with codegen-units = 1 is memory-hungry; the linker can get OOM-killed
# on a small VM and Docker reports it as an opaque exit 137.
DOCKER_MEM_BYTES=$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
DOCKER_MEM_GB=$(( DOCKER_MEM_BYTES / 1024 / 1024 / 1024 ))
if [ "$DOCKER_MEM_GB" -gt 0 ] && [ "$DOCKER_MEM_GB" -lt 12 ]; then
  echo "⚠️  Docker VM has ${DOCKER_MEM_GB}GB RAM. The release profile uses"
  echo "    lto = true + codegen-units = 1; if the link step is OOM-killed"
  echo "    (exit 137), raise it to 12–16GB in Docker Desktop → Settings →"
  echo "    Resources."
fi

# ─── Pre-flight: signing key ────────────────────────────────────────────────
# Mounted read-only. build-linux.sh looks for it at $HOME/.tauri/lunopeak.key
# and, if absent, still "succeeds" while emitting unsigned bundles the updater
# will reject — so fail loudly here instead.
KEY_PATH="$HOME/.tauri/lunopeak.key"
if [ ! -f "$KEY_PATH" ] && [ "$MODE" != "shell" ]; then
  echo "❌ Updater signing key missing: $KEY_PATH"
  echo "   Without it the bundles are unsigned and existing installs won't update."
  exit 1
fi

# ─── Pre-flight: GitHub token ───────────────────────────────────────────────
# gh on the host stores its token in the macOS keychain, so there's no config
# file to mount — pull the token out and hand it over as an env var instead.
GH_TOKEN_VALUE=""
if [ "$MODE" = "release" ]; then
  if ! GH_TOKEN_VALUE=$(gh auth token 2>/dev/null) || [ -z "$GH_TOKEN_VALUE" ]; then
    echo "❌ Could not read a GitHub token from the host gh CLI."
    echo "   Run \`gh auth login\` (or unlock the keychain) and re-run."
    exit 1
  fi
fi

# ─── Build the image ────────────────────────────────────────────────────────
if $FORCE_REBUILD || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "🐳 Building image $IMAGE (amd64)..."
  docker build --platform linux/amd64 -t "$IMAGE" -f "$DOCKERFILE" "$PROJECT_DIR/docker"
else
  echo "✓ Image $IMAGE present (--rebuild to refresh)"
fi

for vol in "$VOL_NODE_MODULES" "$VOL_CARGO_REGISTRY" "$VOL_CARGO_GIT" "$VOL_TARGET" "$VOL_TAURI_CACHE"; do
  docker volume create "$vol" >/dev/null
done

# ─── Assemble docker run args ───────────────────────────────────────────────
RUN_ARGS=(
  --platform linux/amd64
  --rm
  -v "$PROJECT_DIR:/app"
  -v "$VOL_NODE_MODULES:/app/node_modules"
  -v "$VOL_CARGO_REGISTRY:/root/.cargo/registry"
  -v "$VOL_CARGO_GIT:/root/.cargo/git"
  -v "$VOL_TARGET:/app/src-tauri/target"
  -v "$VOL_TAURI_CACHE:/root/.cache/tauri"
  -w /app
)

if [ -f "$KEY_PATH" ]; then
  RUN_ARGS+=(-v "$HOME/.tauri:/root/.tauri:ro")
fi
if [ -n "$GH_TOKEN_VALUE" ]; then
  RUN_ARGS+=(-e "GH_TOKEN=$GH_TOKEN_VALUE")
fi
if [ "$MODE" = "shell" ]; then
  RUN_ARGS+=(-it)
fi

# Guest-side prelude, shared by every mode.
#
# npm ci is gated on a lockfile hash: it wipes and reinstalls unconditionally,
# which is slow enough under emulation to be worth skipping when nothing moved.
read -r -d '' PRELUDE <<'GUEST' || true
set -euo pipefail

# Let build-linux.sh push the version tag without an interactive credential
# prompt. Reads GH_TOKEN at call time, so it's inert when unset.
git config --global credential.helper \
  '!f() { echo username=x-access-token; echo "password=${GH_TOKEN:-}"; }; f'

# Seed the linuxdeploy toolchain from the image into the cache volume, then
# clear AppImage markers on anything already there. `cp -n` leaves existing
# files alone, so a cache populated by Tauri itself wins and only gets patched.
mkdir -p /root/.cache/tauri
cp -rn /opt/tauri-cache/. /root/.cache/tauri/ 2>/dev/null || true
shopt -s nullglob
appimage_files=(/root/.cache/tauri/*.AppImage)
[ ${#appimage_files[@]} -gt 0 ] && appimage-unmagic "${appimage_files[@]}"
shopt -u nullglob

# tsconfig.tsbuildinfo is bind-mounted and records absolute paths, so the
# host's copy points at /Users/... while ours points at /app. Mixing the two
# is exactly the stale-state problem CLAUDE.md warns about, and it's only a
# cache — drop it and let `tsc -b` do a clean pass on each side.
rm -f /app/tsconfig.tsbuildinfo

STAMP=/app/node_modules/.lockfile-hash
WANT=$(sha256sum /app/package-lock.json | cut -d" " -f1)
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$WANT" ]; then
  echo "📦 Installing npm dependencies (Linux)..."
  npm ci
  echo "$WANT" > "$STAMP"
else
  echo "✓ npm dependencies up to date"
fi
GUEST

case "$MODE" in
  shell)
    echo "🐚 Interactive shell — run ./scripts/build-linux.sh when ready."
    exec docker run "${RUN_ARGS[@]}" "$IMAGE" bash -c "$PRELUDE"$'\n''exec bash'
    ;;
  build-only)
    echo "🔨 Building Linux bundles (no tag, no upload)..."
    exec docker run "${RUN_ARGS[@]}" "$IMAGE" bash -c \
      "$PRELUDE"$'\n''SKIP_RELEASE=1 ./scripts/build-linux.sh'
    ;;
  release)
    echo "🚀 Building Linux bundles and drafting the GitHub release..."
    exec docker run "${RUN_ARGS[@]}" "$IMAGE" bash -c \
      "$PRELUDE"$'\n''./scripts/build-linux.sh'
    ;;
esac
