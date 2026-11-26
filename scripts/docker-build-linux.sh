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
# The image is labelled with its Dockerfile's hash, so editing the Dockerfile
# (say, a new apt package) rebuilds it on the next run without --rebuild.
DF_HASH=$(shasum -a 256 "$DOCKERFILE" | cut -c1-16)
IMAGE_HASH=$(docker image inspect -f '{{index .Config.Labels "lunopeak.dockerfile"}}' "$IMAGE" 2>/dev/null || true)
if $FORCE_REBUILD || [ "$IMAGE_HASH" != "$DF_HASH" ]; then
  echo "🐳 Building image $IMAGE (amd64)..."
  docker build --platform linux/amd64 --label "lunopeak.dockerfile=$DF_HASH" \
    -t "$IMAGE" -f "$DOCKERFILE" "$PROJECT_DIR/docker"
else
  echo "✓ Image $IMAGE up to date with its Dockerfile (--rebuild to refresh anyway)"
fi

for vol in "$VOL_NODE_MODULES" "$VOL_CARGO_REGISTRY" "$VOL_CARGO_GIT" "$VOL_TARGET" "$VOL_TAURI_CACHE"; do
  docker volume create "$vol" >/dev/null
done

# ─── lunopeak-node for aarch64 ──────────────────────────────────────────────
# The main image is amd64, so build-linux.sh only builds the x86_64 node.
# install-node.sh also sends ARM Linux to lunopeak-node-linux-aarch64.tar.gz,
# so build that here in a native arm64 container (no emulation on Apple
# Silicon) and hand it to build-linux.sh, which ships it with the rest and
# refuses to release if any node install-node.sh names is missing.
# Own target volume: the amd64 one holds x86_64 build-script binaries.
NODE_IMAGE="lunopeak-node-build"
NODE_DOCKERFILE="$PROJECT_DIR/docker/Dockerfile.node-build"
VOL_NODE_ARM64_TARGET="lunopeak-node-arm64-target"
EXTRA_NODES_DIR="${TMPDIR:-/tmp}/lunopeak-extra-nodes"

if [ "$MODE" != "shell" ]; then
  NODE_DF_HASH=$(shasum -a 256 "$NODE_DOCKERFILE" | cut -c1-16)
  NODE_IMAGE_HASH=$(docker image inspect -f '{{index .Config.Labels "lunopeak.dockerfile"}}' "$NODE_IMAGE" 2>/dev/null || true)
  if $FORCE_REBUILD || [ "$NODE_IMAGE_HASH" != "$NODE_DF_HASH" ]; then
    echo "🐳 Building image $NODE_IMAGE (arm64)..."
    docker build --platform linux/arm64 --label "lunopeak.dockerfile=$NODE_DF_HASH" \
      -t "$NODE_IMAGE" -f "$NODE_DOCKERFILE" "$PROJECT_DIR/docker"
  fi
  docker volume create "$VOL_NODE_ARM64_TARGET" >/dev/null
  docker volume create "$VOL_CARGO_REGISTRY" >/dev/null
  rm -rf "$EXTRA_NODES_DIR"
  mkdir -p "$EXTRA_NODES_DIR"
  NODE_VERSION=$(grep -m1 '^version' "$PROJECT_DIR/src-tauri/Cargo.toml" | sed -E 's/version = "(.*)"/\1/')
  echo "🔨 Building lunopeak-node for aarch64-unknown-linux-musl (static, native arm64)..."
  docker run --platform linux/arm64 --rm \
    -v "$PROJECT_DIR:/app:ro" \
    -v "$VOL_CARGO_REGISTRY:/root/.cargo/registry" \
    -v "$VOL_NODE_ARM64_TARGET:/target" \
    -v "$EXTRA_NODES_DIR:/out" \
    -e CARGO_TARGET_DIR=/target \
    -e NODE_VERSION="$NODE_VERSION" \
    "$NODE_IMAGE" bash -c '
set -euo pipefail
cargo build --locked --release -p lunopeak-node --target aarch64-unknown-linux-musl \
  --manifest-path /app/src-tauri/Cargo.toml
BIN=/target/aarch64-unknown-linux-musl/release/lunopeak-node
if ! file "$BIN" | grep -q "statically linked"; then
  echo "❌ aarch64 lunopeak-node is not statically linked: $(file "$BIN")"
  exit 1
fi
if [ "$("$BIN" --version)" != "lunopeak-node $NODE_VERSION" ]; then
  echo "❌ aarch64 lunopeak-node reports $("$BIN" --version), expected $NODE_VERSION"
  exit 1
fi
STAGE=$(mktemp -d)
cp "$BIN" "$STAGE/"
tar -czf /out/lunopeak-node-linux-aarch64.tar.gz -C "$STAGE" lunopeak-node
'
  echo "✓ $EXTRA_NODES_DIR/lunopeak-node-linux-aarch64.tar.gz"
fi

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
else
  RUN_ARGS+=(-v "$EXTRA_NODES_DIR:/extra-nodes:ro" -e "LUNOPEAK_EXTRA_NODES=/extra-nodes")
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
