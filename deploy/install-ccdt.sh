#!/bin/sh
# Installs ccdt, the terminal client of CC Desk Tunnel, for the current user on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install-ccdt.sh | sh
#
# It downloads the package of the newest release for this system, checks it against the release's SHA256SUMS and puts
# it in place with the install script the package carries. No root is needed. CCDT_VERSION=0.3.9 takes that release
# instead, the one of the service; CCDT_DOWNLOAD_ONLY=1 only unpacks the checked package into the current directory.
set -eu
# What it says is in the system's language, Chinese or else English, as ccdt's: the locale
# the terminal sets.
locale=
for tag in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
  case "$tag" in '' | C | C.* | POSIX | POSIX.*) ;; *) locale=$tag && break ;; esac
done
case "$locale" in zh* | ZH*) zh=1 ;; *) zh= ;; esac
say() { if [ -n "$zh" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
repository=sun168567/cc-desk-tunnel
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) system=mac-arm64 ;;
  Darwin-x86_64) system=mac-x64 ;;
  Linux-x86_64 | Linux-amd64) system=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) system=linux-arm64 ;;
  *)
    say "没有这个系统（$(uname -s) $(uname -m)）的 ccdt 包。Windows 上请在 PowerShell 里运行 install-ccdt.ps1。" \
      "There is no ccdt package for this system ($(uname -s) $(uname -m)). On Windows, run install-ccdt.ps1 in PowerShell." >&2
    exit 1
    ;;
esac
version=${CCDT_VERSION:-}
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -z "$version" ]; then
    say "读不到最新的版本号；可以用 CCDT_VERSION 指定版本，例如 CCDT_VERSION=0.3.9。" \
      "Couldn’t read the newest version; CCDT_VERSION chooses one, for example CCDT_VERSION=0.3.9." >&2
    exit 1
  fi
fi
version=${version#v}
name="ccdt-$version-$system.tar.gz"
base="https://github.com/$repository/releases/download/v$version"
folder=$(mktemp -d)
trap 'rm -rf "$folder"' EXIT
say "正在下载 ccdt $version ……" "Downloading ccdt $version…"
curl -fsSL -o "$folder/$name" "$base/$name"
curl -fsSL -o "$folder/SHA256SUMS" "$base/SHA256SUMS"
expected=$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1; exit }' "$folder/SHA256SUMS")
if [ -z "$expected" ]; then
  say "$version 的校验清单里没有 ${name}。" "${name} isn’t in the checksums of $version." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$folder/$name" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$folder/$name" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
  say "下载的 $name 校验不符，没有安装。" "The downloaded $name doesn’t match its checksum; nothing was installed." >&2
  exit 1
fi
if [ -n "${CCDT_DOWNLOAD_ONLY:-}" ]; then
  tar -xzf "$folder/$name" -C .
  say "已校验并解压到 $(pwd)/ccdt，没有安装。" "Checked and unpacked into $(pwd)/ccdt; not installed."
  exit 0
fi
tar -xzf "$folder/$name" -C "$folder"
sh "$folder/ccdt/install.sh"