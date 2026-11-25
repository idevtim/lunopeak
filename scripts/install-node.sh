#!/bin/sh
# Install lunopeak-node on this Mac or Linux machine, keep it running in the
# background, and show a code to pair it with LunoPeak on another computer.
#
#   curl -fsSL https://github.com/idevtim/lunopeak/releases/latest/download/install-node.sh | sh
#
# Options go to `lunopeak-node install` after `sh -s --`, e.g.:
#   curl -fsSL .../install-node.sh | sh -s -- --name "Build box"
#   curl -fsSL .../install-node.sh | sh -s -- --bind 100.64.0.5   (Tailscale only)
#
# Shipped as a release asset next to the binaries it downloads, so it always
# matches the latest release. Runs as you, never root.
set -eu

REPO="idevtim/lunopeak"

case "$(uname -s)" in
  Darwin) asset="lunopeak-node-macos-universal.tar.gz" ;;
  Linux)
    case "$(uname -m)" in
      x86_64 | amd64) asset="lunopeak-node-linux-x86_64.tar.gz" ;;
      aarch64 | arm64) asset="lunopeak-node-linux-aarch64.tar.gz" ;;
      *) echo "lunopeak-node isn't built for $(uname -m) yet." >&2; exit 1 ;;
    esac
    ;;
  *) echo "Use install-node.ps1 on Windows." >&2; exit 1 ;;
esac

if [ "$(id -u)" = "0" ]; then
  echo "Run this as the user whose coding sessions should be shared, not as root." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
url="https://github.com/$REPO/releases/latest/download/$asset"
echo "Downloading $url"
curl -fsSL "$url" -o "$tmp/node.tar.gz"
tar -xzf "$tmp/node.tar.gz" -C "$tmp"

"$tmp/lunopeak-node" install "$@"

# First install (nothing paired yet): show a code right away.
if "$tmp/lunopeak-node" hubs | grep -q "Not shared"; then
  echo
  "$tmp/lunopeak-node" pair </dev/null || true
fi
