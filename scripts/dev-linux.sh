#!/bin/bash
set -euo pipefail

# Launches `tauri dev` with a sanitized env that the Rust + GTK runtime needs:
#   - $HOME/.cargo/bin on PATH (cargo/rustup not always present in non-interactive shells)
#   - snap-injected env vars stripped (otherwise the built binary dies with
#     "symbol lookup error: /snap/core20/.../libpthread.so.0: undefined symbol:
#      __libc_pthread_init, version GLIBC_PRIVATE")
# Safe to run from any shell — idempotent if the dev env is already clean.
#
# Usage:
#   ./scripts/dev-linux.sh            # launch tauri dev
#   ./scripts/dev-linux.sh --check    # verify toolchain + libs, exit
#   ./scripts/dev-linux.sh -- <args>  # forward args to `tauri dev`

CHECK_ONLY=false
TAURI_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=true; shift ;;
    --) shift; TAURI_ARGS+=("$@"); break ;;
    *) TAURI_ARGS+=("$1"); shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 1. Put cargo/rustc on PATH.
if [ -d "$HOME/.cargo/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.cargo/bin:"*) ;;
    *) export PATH="$HOME/.cargo/bin:$PATH" ;;
  esac
fi

# 2. Strip snap-injected env when running from VS Code's snap-integrated terminal.
#    See build-linux.sh for the full diagnosis — short version: the snap's GTK
#    runtime expects a glibc that doesn't match the host, so any native binary
#    that loads GTK from these paths dies at startup.
if [[ "${GTK_PATH:-}" == /snap/* ]] || [[ "${LOCPATH:-}" == /snap/* ]]; then
  echo "[*] Stripping snap-injected env vars (LOCPATH, GTK_PATH, XDG_DATA_DIRS, ...)"
  unset LOCPATH GTK_PATH GTK_EXE_PREFIX GTK_IM_MODULE_FILE \
        GIO_MODULE_DIR GSETTINGS_SCHEMA_DIR XDG_DATA_HOME XDG_DATA_DIRS
fi

# 3. Sanity check the tools the Rust build needs.
for tool in rustc cargo node npm pkg-config cc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[X] required tool not on PATH: $tool"
    if [ "$tool" = "cc" ] || [ "$tool" = "pkg-config" ]; then
      echo "    Install with: sudo apt-get install -y build-essential pkg-config"
    fi
    exit 1
  fi
done

# 4. Sanity check the system libraries Tauri 2 needs at link time.
REQUIRED_PKGS=(
  libwebkit2gtk-4.1-dev
  libsoup-3.0-dev
  libssl-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
)
if command -v dpkg >/dev/null 2>&1; then
  MISSING_PKGS=()
  for pkg in "${REQUIRED_PKGS[@]}"; do
    if ! dpkg -s "$pkg" 2>/dev/null | grep -q "Status: install ok installed"; then
      MISSING_PKGS+=("$pkg")
    fi
  done
  if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    echo "[X] missing system packages:"
    for p in "${MISSING_PKGS[@]}"; do echo "      - $p"; done
    echo "    Install with:"
    echo "      sudo apt-get update && sudo apt-get install -y ${MISSING_PKGS[*]}"
    exit 1
  fi
fi

if $CHECK_ONLY; then
  echo "[OK] toolchain ready (rustc, cargo, node, npm, pkg-config, cc) + system libs"
  exit 0
fi

cd "$PROJECT_DIR"
exec npx tauri dev "${TAURI_ARGS[@]}"
