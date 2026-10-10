#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION=v24.21.0
CLAUDE_VERSION=2.1.293
RUNTIME="${CC_DESK_TUNNEL_RUNTIME:-$HOME/.local/share/cc-desk-tunnel/runtime}"
case "$(uname -m)" in
  x86_64) ARCH=x64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "Unsupported architecture" >&2; exit 1 ;;
esac
if [ "$(id -u)" -eq 0 ]; then
  echo "Run as the intended ordinary user, without sudo." >&2
  exit 1
fi
mkdir -p "$RUNTIME"
if [ -x "$RUNTIME/node/bin/node" ] && [ "$("$RUNTIME/node/bin/node" --version)" != "$NODE_VERSION" ]; then
  echo "Existing managed Node runtime is not $NODE_VERSION. Choose a new CC_DESK_TUNNEL_RUNTIME directory." >&2
  exit 1
fi
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
ARCHIVE="node-$NODE_VERSION-linux-$ARCH.tar.xz"
if [ ! -x "$RUNTIME/node/bin/node" ]; then
  curl --connect-timeout 20 --max-time 300 -fsSL "https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE" -o "$TEMP/$ARCHIVE"
  curl --connect-timeout 20 --max-time 60 -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TEMP/checksums"
  (cd "$TEMP" && grep "  $ARCHIVE$" checksums | sha256sum -c -)
  tar -xJf "$TEMP/$ARCHIVE" -C "$TEMP"
  mv -- "$TEMP/node-$NODE_VERSION-linux-$ARCH" "$RUNTIME/node"
fi
export PATH="$RUNTIME/node/bin:$PATH"
node --version
if [ ! -x "$RUNTIME/cli/bin/claude" ] || [ "$("$RUNTIME/cli/bin/claude" --version | cut -d ' ' -f 1)" != "$CLAUDE_VERSION" ]; then
  npm install --global --prefix "$RUNTIME/cli" "@anthropic-ai/claude-code@$CLAUDE_VERSION"
fi
"$RUNTIME/cli/bin/claude" --version
printf 'Runtime installed for user %s at %s\n' "$(id -un)" "$RUNTIME"
printf 'No account login or model call has been performed.\n'
