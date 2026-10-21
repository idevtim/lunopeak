#!/bin/bash
set -euo pipefail

# Linux release entry point — dispatches on the host OS.
#
# build-linux.sh must run on Linux: it checks dpkg for the GTK/webkit dev
# packages and links against the host's system libraries. Driving a Linux
# release from macOS goes through docker-build-linux.sh, which builds an
# amd64 Ubuntu 22.04 image and runs build-linux.sh inside it unmodified.
#
# Usage:
#   ./scripts/dist-linux.sh                 # build + tag + upload
#   ./scripts/dist-linux.sh --build-only    # bundles only, no tag/upload (macOS)
#   SKIP_RELEASE=1 ./scripts/dist-linux.sh  # same, on a Linux host

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin)
    exec bash "$SCRIPT_DIR/docker-build-linux.sh" "$@"
    ;;
  Linux)
    exec bash "$SCRIPT_DIR/build-linux.sh" "$@"
    ;;
  *)
    echo "❌ Unsupported host for a Linux release: $(uname -s)"
    echo "   Run this on Linux, or on macOS with Docker available."
    exit 1
    ;;
esac
