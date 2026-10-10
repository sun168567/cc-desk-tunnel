#!/usr/bin/env bash
# Installs or upgrades the CC Desk Tunnel service on this machine. It can be run on its own,
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/main/deploy/install.sh)"
# in which case it fetches the newest release from GitHub, or from an unpacked server archive, which it then uses.
# It checks for what it needs and says how to install what is missing; it installs nothing on the host itself
# and leaves the firewall, nginx and SSH alone.
set -euo pipefail

REPO="${CC_DESK_TUNNEL_REPO:-sun168567/cc-desk-tunnel}"
TARGET="${CC_DESK_TUNNEL_DIR:-/opt/cc-desk-tunnel}"
TEMP=''
trap '[[ -z "$TEMP" ]] || rm -rf -- "$TEMP"' EXIT
fail() { echo "错误：$*" >&2; exit 1; }
confirm() {
  local answer
  read -r -p "$1 [Y/n]: " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
version_of() { sed -n 's/^ *"version": "\([0-9.]*\)",\{0,1\}$/\1/p' "$1/apps/desktop/package.json" 2>/dev/null | head -n 1; }

main() {
  # Without arguments the installer asks its questions, builds, starts and prints a summary.
  (($#)) || set -- setup
  [[ "$1" = init || "$1" = setup ]] || fail "参数只接受 setup（默认）或 init …；其余操作请用 deploy/manage.sh。"
  [[ "$(id -u)" = 0 ]] || fail "需要 root 权限，请在命令前加 sudo。"
  [[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]] || fail "目前只支持 x86_64（amd64）的 Linux。"
  # Piped from curl, the script itself is on standard input; the questions need the terminal.
  if [[ ! -t 0 ]]; then
    [[ -r /dev/tty ]] || fail "需要交互终端。请改用：sudo bash -c \"\$(curl -fsSL …/deploy/install.sh)\""
    exec < /dev/tty
  fi
  local id=''
  [[ ! -r /etc/os-release ]] || id="$(. /etc/os-release && echo "${ID:-}")"
  [[ "$id" = ubuntu ]] || echo "提示：只在 Ubuntu 上验证过；其他发行版可以继续，遇到问题请参考部署手册。"

  # What is missing is reported together with how to install it; nothing is installed from here.
  local missing=() packages=() tool
  for tool in curl tar openssl sha256sum; do
    command -v "$tool" >/dev/null || { missing+=("$tool"); packages+=("$([[ "$tool" = sha256sum ]] && echo coreutils || echo "$tool")"); }
  done
  command -v docker >/dev/null || { missing+=("Docker Engine"); packages+=(docker.io); }
  docker compose version >/dev/null 2>&1 || { missing+=("Docker Compose v2"); packages+=(docker-compose-v2); }
  if ((${#missing[@]})); then
    echo "缺少以下组件：${missing[*]}" >&2
    if [[ "$id" = ubuntu ]]; then
      echo "请先执行下面的命令安装，然后重新运行本脚本：" >&2
      echo "  sudo apt-get update && sudo apt-get install -y ${packages[*]}" >&2
    else
      echo "请按发行版的方式安装后重新运行本脚本。Docker 的官方安装说明：https://docs.docker.com/engine/install/" >&2
    fi
    exit 1
  fi
  docker info >/dev/null 2>&1 || {
    echo "Docker 已安装但没有运行。请先执行下面的命令，然后重新运行本脚本：" >&2
    echo "  sudo systemctl enable --now docker" >&2
    exit 1
  }

  # Run from an unpacked server archive or a checkout, that copy is used as it is.
  local self="${BASH_SOURCE[0]:-}" root=''
  if [[ -n "$self" && -f "$(dirname -- "$self")/manage.sh" ]]; then
    root="$(cd -- "$(dirname -- "$self")/.." && pwd)"
  else
    local temp name installed latest
    temp="$(mktemp -d)"
    TEMP="$temp"
    echo "查询最新版本（github.com/$REPO）…"
    curl -fsSL --connect-timeout 20 --max-time 60 -o "$temp/SHA256SUMS" \
      "https://github.com/$REPO/releases/latest/download/SHA256SUMS" \
      || fail "无法读取发布页。请检查这台机器能否访问 github.com。"
    name="$(awk '$2 ~ /^cc-desk-tunnel-server-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/ { print $2 }' "$temp/SHA256SUMS" | head -n 1)"
    [[ -n "$name" ]] || fail "发布页的校验清单里没有服务端程序包。"
    latest="${name#cc-desk-tunnel-server-}"; latest="${latest%.tar.gz}"

    if [[ -f "$TARGET/deploy/manage.sh" && -f "${PROXY_DEPLOY_CONFIG:-$TARGET/.local/docker.env}" ]]; then
      installed="$(version_of "$TARGET")"
      echo "检测到已有部署：$TARGET（程序包版本 ${installed:-未知}），最新版本 $latest。"
      confirm "用 $latest 重建镜像并替换容器？数据、账号和配置保留" || exit 0
      set -- upgrade
    elif [[ -e "$TARGET" && ! -f "$TARGET/deploy/manage.sh" && -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
      fail "$TARGET 已存在且不是 CC Desk Tunnel 的程序目录。请换一个目录：CC_DESK_TUNNEL_DIR=/其他路径"
    else
      cat <<NOTICE

即将安装 CC Desk Tunnel $latest 到 $TARGET。继续之前请确认：
  · 这台服务器由你自己控制且可信：连接期间它能以你的 Windows 用户身份执行任意命令。
  · 安装结束时显示的“服务凭据”等同于这台服务器和你 Windows 的控制权，不要外传或截图分享。
  · 防火墙只需要放行安装结束时列出的那个 TCP 端口，其余端口不需要为本项目开放。
  · 本项目主要由 AI 编写，未经专业安全审计；完整说明见 https://github.com/$REPO#安全须知

NOTICE
      confirm "继续安装？" || exit 0
    fi

    echo "下载 $name …"
    curl -fL --connect-timeout 20 --max-time 600 --progress-bar -o "$temp/$name" \
      "https://github.com/$REPO/releases/latest/download/$name" || fail "下载失败。"
    (cd "$temp" && grep "  $name\$" SHA256SUMS | sha256sum -c - >/dev/null) || fail "程序包校验失败，已放弃。"
    if [[ "$1" = upgrade ]]; then
      bash "$TARGET/deploy/manage.sh" upgrade --from "$temp/$name"
      exit
    fi
    if tar -tzf "$temp/$name" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then fail "程序包内含不安全的路径。"; fi
    mkdir -p "$TARGET"
    tar -xzf "$temp/$name" -C "$TARGET" --no-same-owner
    root="$TARGET"
  fi

  bash "$root/deploy/manage.sh" "$@"
  if [[ "$1" = setup ]]; then
    echo "Windows 客户端安装包：https://github.com/$REPO/releases/latest"
    echo "日常运维：sudo bash $root/deploy/manage.sh help"
  else
    echo "下一步：按需编辑 provider 配置，然后执行 sudo bash $root/deploy/manage.sh build 和 up。"
  fi
  echo "本脚本没有修改防火墙、nginx 或 SSH 配置，也没有安装系统软件。"
}
main "$@"
