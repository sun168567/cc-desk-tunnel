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
if [ "$ARCH" != x64 ]; then
  echo "frps distribution is currently verified for Linux x64 only." >&2
  exit 1
fi
if [ ! -x "$RUNTIME/frp/frps" ] || [ "$("$RUNTIME/frp/frps" --version)" != 0.71.0 ]; then
  FRP_ARCHIVE=frp_0.71.0_linux_amd64.tar.gz
  curl --connect-timeout 20 --max-time 300 -fsSL "https://github.com/fatedier/frp/releases/download/v0.71.0/$FRP_ARCHIVE" -o "$TEMP/$FRP_ARCHIVE"
  printf '84f27e39f11169f7adcef8e8b70c9329de17747b1f14dad9fb95eef5682ea716  %s\n' "$TEMP/$FRP_ARCHIVE" | sha256sum -c -
  tar -xzf "$TEMP/$FRP_ARCHIVE" -C "$TEMP"
  mkdir -p "$RUNTIME/frp"
  install -m 755 "$TEMP/frp_0.71.0_linux_amd64/frps" "$RUNTIME/frp/frps"
  install -m 644 "$TEMP/frp_0.71.0_linux_amd64/LICENSE" "$RUNTIME/frp/LICENSE"
fi
"$RUNTIME/frp/frps" --version
printf 'Runtime installed for user %s at %s\n' "$(id -un)" "$RUNTIME"
printf 'No account login or model call has been performed.\n'
