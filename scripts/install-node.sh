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
# matches the latest release. Runs as whoever runs it (root included).
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

# Run it as the user whose agents should be shared. As root (usual on a
# Proxmox host or container) it installs a system service reading root's
# agent folders.
if [ "$(id -u)" = "0" ]; then
  echo "Installing for root: sessions of agents run as root on this machine will be shared."
fi
for tool in curl tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "This installer needs $tool. Install it first (on Debian or Proxmox: apt install $tool)." >&2
    exit 1
  fi
done

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
