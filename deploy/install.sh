#!/usr/bin/env bash
# Installs or upgrades the CC Desk Tunnel service on this machine. It can be run on its own,
#   sudo bash -c "$(curl -fsSL https://github.com/sun168567/cc-desk-tunnel/releases/latest/download/install.sh)"
# in which case it fetches the newest release from GitHub (CC_DESK_TUNNEL_VERSION=X.Y.Z picks another), or from an
# unpacked server archive, which it then uses. The service runs the prebuilt image of that version where there is
# one, and builds it here where there is not (see manage.sh).
# It checks for what it needs and says how to install what is missing; it installs no system software and leaves
# the firewall, nginx and SSH alone. Its one addition to the host is the command `cc-desk-tunnel`.
set -euo pipefail

REPO="${CC_DESK_TUNNEL_REPO:-sun168567/cc-desk-tunnel}"
TARGET="${CC_DESK_TUNNEL_DIR:-/opt/cc-desk-tunnel}"
TEMP=''
trap '[[ -z "$TEMP" ]] || rm -rf -- "$TEMP"' EXIT
# What it says is in Chinese, or in English where CC_DESK_TUNNEL_LANG=en asks for it, as with manage.sh: also in the
# language an installation here was set up in.
script_lang="${CC_DESK_TUNNEL_LANG:-$(sed -n "s/^SCRIPT_LANG='\(.*\)'$/\1/p" "${PROXY_DEPLOY_CONFIG:-$TARGET/.local/docker.env}" 2>/dev/null || true)}"
case "$script_lang" in en* | EN*) english=1 ;; *) english='' ;; esac
# say CHINESE ENGLISH: the line in the language chosen.
say() { if [[ -n "$english" ]]; then printf '%s\n' "$2"; else printf '%s\n' "$1"; fi; }
fail() { say "错误：$1" "Error: $2" >&2; exit 1; }
confirm() {
  local answer
  read -r -p "$(say "$1" "$2" | tr -d '\n') [Y/n]: " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
version_of() { sed -n 's/^ *"version": "\([0-9.]*\)",\{0,1\}$/\1/p' "$1/apps/desktop/package.json" 2>/dev/null | head -n 1; }

main() {
  # Without arguments the installer asks its questions, gets the image, starts and prints a summary.
  (($#)) || set -- setup
  [[ "$1" = init || "$1" = setup ]] || fail "参数只接受 setup（默认）或 init …；其余操作请用 deploy/manage.sh。" \
    "Only setup (the default) or init … is taken; use deploy/manage.sh for everything else."
  [[ "$(id -u)" = 0 ]] || fail "需要 root 权限，请在命令前加 sudo。" "Needs root: put sudo before the command."
  [[ "$(uname -s)" = Linux && "$(uname -m)" =~ ^(x86_64|aarch64)$ ]] \
    || fail "目前只支持 x86_64（amd64）和 aarch64（arm64）的 Linux。" "Only Linux on x86_64 (amd64) or aarch64 (arm64) is supported for now."
  # Piped from curl, the script itself is on standard input; the questions need the terminal. Without one (a
  # script answering for itself), standard input stays as it is.
  if [[ ! -t 0 ]] && (exec < /dev/tty) 2>/dev/null; then exec < /dev/tty; fi
  local id=''
  [[ ! -r /etc/os-release ]] || id="$(. /etc/os-release && echo "${ID:-}")"
  [[ "$id" = ubuntu ]] || say "提示：只在 Ubuntu 上验证过；其他发行版可以继续，遇到问题请参考部署手册。" \
    "Note: tested on Ubuntu only. Other distributions can go on; if something goes wrong, see the deployment manual."

  # What is missing is reported together with how to install it; nothing is installed from here.
  local missing=() packages=() tool
  for tool in curl tar openssl sha256sum; do
    command -v "$tool" >/dev/null || { missing+=("$tool"); packages+=("$([[ "$tool" = sha256sum ]] && echo coreutils || echo "$tool")"); }
  done
  command -v docker >/dev/null || { missing+=("Docker Engine"); packages+=(docker.io); }
  docker compose version >/dev/null 2>&1 || { missing+=("Docker Compose v2"); packages+=(docker-compose-v2); }
  if ((${#missing[@]})); then
    say "缺少以下组件：${missing[*]}" "Missing: ${missing[*]}" >&2
    if [[ "$id" = ubuntu ]]; then
      say "请先执行下面的命令安装，然后重新运行本脚本：" "Install them with the command below, then run this script again:" >&2
      echo "  sudo apt-get update && sudo apt-get install -y ${packages[*]}" >&2
    else
      say "请按发行版的方式安装后重新运行本脚本。Docker 的官方安装说明：https://docs.docker.com/engine/install/" \
        "Install them as your distribution does, then run this script again. Docker’s installation guide: https://docs.docker.com/engine/install/" >&2
    fi
    exit 1
  fi
  docker info >/dev/null 2>&1 || {
    say "Docker 已安装但没有运行。请先执行下面的命令，然后重新运行本脚本：" \
      "Docker is installed but not running. Run the command below, then run this script again:" >&2
    echo "  sudo systemctl enable --now docker" >&2
    exit 1
  }

  # Run from an unpacked server archive or a checkout, that copy is used as it is.
  local self="${BASH_SOURCE[0]:-}" root=''
  if [[ -n "$self" && -f "$(dirname -- "$self")/manage.sh" ]]; then
    root="$(cd -- "$(dirname -- "$self")/.." && pwd)"
  else
    local temp name installed latest releases="https://github.com/$REPO/releases/latest/download"
    temp="$(mktemp -d)"
    TEMP="$temp"
    if [[ -n "${CC_DESK_TUNNEL_VERSION:-}" ]]; then
      [[ "$CC_DESK_TUNNEL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
        || fail "CC_DESK_TUNNEL_VERSION 应写成 X.Y.Z。" "CC_DESK_TUNNEL_VERSION must be X.Y.Z."
      releases="https://github.com/$REPO/releases/download/v$CC_DESK_TUNNEL_VERSION"
    fi
    say "查询版本（github.com/${REPO}）…" "Looking up the version (github.com/${REPO})…"
    curl -fsSL --connect-timeout 20 --max-time 60 -o "$temp/SHA256SUMS" "$releases/SHA256SUMS" \
      || fail "无法读取发布页。请检查这台机器能否访问 github.com，以及版本号是否存在。" \
        "Cannot read the releases. Check that this machine can reach github.com, and that the version exists."
    name="$(awk '$2 ~ /^cc-desk-tunnel-server-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/ { print $2 }' "$temp/SHA256SUMS" | head -n 1)"
    [[ -n "$name" ]] || fail "发布页的校验清单里没有服务端程序包。" "The release’s SHA256SUMS lists no server archive."
    latest="${name#cc-desk-tunnel-server-}"; latest="${latest%.tar.gz}"

    if [[ -f "$TARGET/deploy/manage.sh" && -f "${PROXY_DEPLOY_CONFIG:-$TARGET/.local/docker.env}" ]]; then
      installed="$(version_of "$TARGET")"
      say "检测到已有部署：${TARGET}（程序包版本 ${installed:-未知}），最新版本 ${latest}。" \
        "Found a deployment in ${TARGET} (program version ${installed:-unknown}); the newest version is ${latest}."
      confirm "升级到 $latest 并替换容器？数据、账号和配置保留" \
        "Upgrade to $latest and replace the container? Data, accounts and configuration stay" || exit 0
      set -- upgrade
    elif [[ -e "$TARGET" && ! -f "$TARGET/deploy/manage.sh" && -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
      fail "$TARGET 已存在且不是 CC Desk Tunnel 的程序目录。请换一个目录：CC_DESK_TUNNEL_DIR=/其他路径" \
        "$TARGET exists and is not a CC Desk Tunnel program folder. Choose another: CC_DESK_TUNNEL_DIR=/other/path"
    elif [[ -n "$english" ]]; then
      cat <<NOTICE

About to install CC Desk Tunnel $latest in ${TARGET}. Before you go on, make sure that:
  · You control and trust this server: while connected, it can run any command as your Windows user.
  · The “Service token” shown at the end is as good as control of this server and of your Windows: don’t share it or a screenshot of it.
  · The firewall needs only the one TCP port listed at the end; no other port is to be opened for this project.
  · This project is written mostly by AI and has had no professional security audit; see https://github.com/$REPO/blob/main/README.en.md#security

NOTICE
      confirm "继续安装？" "Go on with the install?" || exit 0
    else
      cat <<NOTICE

即将安装 CC Desk Tunnel $latest 到 ${TARGET}。继续之前请确认：
  · 这台服务器由你自己控制且可信：连接期间它能以你的 Windows 用户身份执行任意命令。
  · 安装结束时显示的“服务凭据”等同于这台服务器和你 Windows 的控制权，不要外传或截图分享。
  · 防火墙只需要放行安装结束时列出的那个 TCP 端口，其余端口不需要为本项目开放。
  · 本项目主要由 AI 编写，未经专业安全审计；完整说明见 https://github.com/$REPO#安全须知

NOTICE
      confirm "继续安装？" "Go on with the install?" || exit 0
    fi

    say "下载 $name …" "Downloading ${name}…"
    curl -fL --connect-timeout 20 --max-time 600 --progress-bar -o "$temp/$name" \
      "https://github.com/$REPO/releases/download/v$latest/$name" || fail "下载失败。" "Download failed."
    (cd "$temp" && grep "  $name\$" SHA256SUMS | sha256sum -c - >/dev/null) \
      || fail "程序包校验失败，已放弃。" "The archive does not match SHA256SUMS; stopped."
    if [[ "$1" = upgrade ]]; then
      # A manage.sh older than this archive unpacks it and hands over to the new one, which need not fetch it again.
      CC_DESK_TUNNEL_UNPACKED=1 bash "$TARGET/deploy/manage.sh" upgrade --from "$temp/$name"
      exit
    fi
    if tar -tzf "$temp/$name" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
      fail "程序包内含不安全的路径。" "The archive has unsafe paths."
    fi
    mkdir -p "$TARGET"
    tar -xzf "$temp/$name" -C "$TARGET" --no-same-owner
    root="$TARGET"
  fi

  bash "$root/deploy/manage.sh" "$@"
  if [[ "$1" = setup ]]; then
    say "Windows 客户端安装包：https://github.com/$REPO/releases/latest" "Windows client installer: https://github.com/$REPO/releases/latest"
  else
    say "下一步：按需编辑 provider 配置，然后执行 sudo cc-desk-tunnel up。" \
      "Next: edit the provider configuration if needed, then run sudo cc-desk-tunnel up."
    say "日常管理：sudo cc-desk-tunnel status | logs | upgrade | help" "Everyday commands: sudo cc-desk-tunnel status | logs | upgrade | help"
  fi
  say "本脚本没有修改防火墙、nginx 或 SSH 配置，也没有安装系统软件。" \
    "This script changed no firewall, nginx or SSH configuration and installed no system software."
}
main "$@"
