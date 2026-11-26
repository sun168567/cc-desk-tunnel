#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${PROXY_DEPLOY_CONFIG:-$ROOT/.local/docker.env}"
COMPOSE="${PROXY_COMPOSE_FILE:-$ROOT/deploy/compose.yml}"
# What it says is in Chinese, or in English where CC_DESK_TUNNEL_LANG=en asks for it. The server's own locale says
# nothing of the administrator's (cloud images set English, and ssh from Windows passes none), so it is not asked.
# The language asked for is kept in the configuration for the commands after it (load).
script_lang="${CC_DESK_TUNNEL_LANG:-$(sed -n "s/^SCRIPT_LANG='\(.*\)'$/\1/p" "$CONFIG" 2>/dev/null || true)}"
case "$script_lang" in en* | EN*) english=1 ;; *) english='' ;; esac
# t CHINESE ENGLISH: the text in the language chosen; say ends it with a newline.
t() { if [[ -n "$english" ]]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
say() { t "$1" "$2"; echo; }

usage() {
  if [[ -z "$english" ]]; then
    cat <<'HELP'
用法：
  manage.sh setup                      首次安装（交互）：逐项询问，获取镜像，启动，显示汇总
  manage.sh init --host HOST [--mode fingerprint|certificate|nginx]
    [--data ABSOLUTE_PATH] [--control-port 8787]
    [--cert FULLCHAIN --key PRIVATE_KEY] [--url wss://DOMAIN/ws] [--token SECRET]
  manage.sh pull|build|up|status|logs|stop|restart|uninstall|connection|summary
  manage.sh upgrade [--from SERVER_ARCHIVE]   安装最新版本（或给出的程序包）并替换容器
  manage.sh client INSTALLER_EXE              向连接的客户端提供一个 Windows 安装包
  manage.sh token [SECRET]                    更换服务凭据（省略时随机生成）并重启
  manage.sh release-token [FILE]              保存跟随发布用的只读 GitHub 令牌（省略：删除）
  manage.sh backup [FILE|DIRECTORY]            把全部数据存成一个 .tar.gz（默认：当前目录下带日期的文件）
  manage.sh restore BACKUP [--yes]            用备份替换这套部署的数据，替换前先另存
  manage.sh certificate FULLCHAIN PRIVATE_KEY
  manage.sh renew

需要 Docker Engine 与 Compose v2 以上、Bash、OpenSSL、curl、tar。
当前用户无权使用 Docker 时加 sudo。配置默认在 .local/docker.env；
设置 PROXY_DEPLOY_CONFIG 可管理另一套独立的部署。
管理只用镜像的独立 compose.yml 时设置 PROXY_COMPOSE_FILE。
镜像用本程序同版本的预构建镜像（ghcr.io/sun168567/cc-desk-tunnel:X.Y.Z），拉取不到时在本机构建。
CC_DESK_TUNNEL_BUILD=1 总在本机构建，CC_DESK_TUNNEL_BUILD=0 从不在本机构建。
upgrade 获取最新版本；CC_DESK_TUNNEL_VERSION=X.Y.Z 指定其他版本。
用 sudo 安装后，在任何目录都可用 `sudo cc-desk-tunnel 命令` 运行本脚本。
uninstall 保留全部数据；backup 和 restore 期间服务暂停。迁移到另一台服务器：在这里备份，
在那里安装，把备份文件拷过去，在那里还原。
CC_DESK_TUNNEL_LANG=en 改为英文，=zh 改回中文；指定一次，之后的命令沿用。
HELP
    return
  fi
  cat <<'HELP'
Usage:
  manage.sh setup                      interactive first install: asks, gets the image, starts, prints a summary
  manage.sh init --host HOST [--mode fingerprint|certificate|nginx]
    [--data ABSOLUTE_PATH] [--control-port 8787]
    [--cert FULLCHAIN --key PRIVATE_KEY] [--url wss://DOMAIN/ws] [--token SECRET]
  manage.sh pull|build|up|status|logs|stop|restart|uninstall|connection|summary
  manage.sh upgrade [--from SERVER_ARCHIVE]   install the newest release (or the archive) and replace the container
  manage.sh client INSTALLER_EXE              offer a Windows installer to connected clients
  manage.sh token [SECRET]                    replace the service token (random when omitted) and restart
  manage.sh release-token [FILE]              save a read-only GitHub token for following releases (none: remove)
  manage.sh backup [FILE|DIRECTORY]            save all data in one .tar.gz (default: a dated file here)
  manage.sh restore BACKUP [--yes]            replace this deployment's data with a backup, saving it first
  manage.sh certificate FULLCHAIN PRIVATE_KEY
  manage.sh renew

Requires Docker Engine + Compose v2+, Bash, OpenSSL, curl, tar.
Use sudo if your user cannot access Docker. Config defaults to .local/docker.env;
set PROXY_DEPLOY_CONFIG to manage a different isolated installation.
Set PROXY_COMPOSE_FILE when managing an image-only standalone compose.yml.
The image is the prebuilt one of this program's version (ghcr.io/sun168567/cc-desk-tunnel:X.Y.Z), built here
when it cannot be pulled. CC_DESK_TUNNEL_BUILD=1 always builds here, CC_DESK_TUNNEL_BUILD=0 never does.
upgrade fetches the newest release; CC_DESK_TUNNEL_VERSION=X.Y.Z picks another.
After an install with sudo, `sudo cc-desk-tunnel COMMAND` runs this script from anywhere.
Uninstall keeps all data; backup/restore pause the service. To move to another server, back up here, install
there, copy the file over and restore it there.
CC_DESK_TUNNEL_LANG=en switches to English, =zh back to Chinese; given once, the commands after it keep it.
HELP
}
fail() { say "$@" >&2; exit 1; }
# An IPv4 address or a DNS name. Underscores are allowed: some hosts and internal zones have them, and the client
# and OpenSSL take them. An internationalized name is written in its xn-- form.
valid_host() {
  [[ ${#1} -le 253 && "$1" =~ ^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$ ]]
}
# The host as people paste it: with a scheme, a port or a path, a trailing dot, capitals.
host_of() {
  local host="${1//[[:space:]]/}"
  host="${host#*://}"; host="${host%%/*}"; host="${host%:[0-9]*}"; host="${host%.}"
  printf '%s' "${host,,}"
}
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535)); }
safe_value() { [[ "$1" != *"'"* && "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" != *'$'* && "$1" != *'`'* ]]; }
write_var() { safe_value "$2" || fail "$1 含有不支持的字符" "Unsupported characters in $1"; printf "%s='%s'\n" "$1" "$2"; }
# Replaces one setting in the configuration, written aside and renamed.
save_var() {
  local temp
  temp="$(mktemp "$CONFIG.XXXXXX")"
  { grep -v "^$1=" "$CONFIG" || true; write_var "$1" "$2"; } > "$temp"
  mv -- "$temp" "$CONFIG"
}
dc() { docker compose --env-file "$CONFIG" -p "$PROJECT_NAME" -f "$COMPOSE" "$@"; }
load() {
  [[ -f "$CONFIG" ]] || fail "没有部署配置，请先执行 init。" "Run init first."
  # This file is a private, locally generated deployment configuration.
  source "$CONFIG"
  [[ "$DATA_DIR" = /* && -f "$DATA_DIR/.cc-desk-tunnel-data" ]] || fail "数据目录无效：不是本项目管理的目录。" "Invalid managed data directory."
  DATA_DIR="$(realpath -- "$DATA_DIR")"
  [[ -z "${CC_DESK_TUNNEL_LANG:-}" || "${SCRIPT_LANG:-}" = "$(t zh en)" ]] || save_var SCRIPT_LANG "$(t zh en)"
}
cert_pair() {
  [[ -f "$1" && -f "$2" ]] || fail "找不到证书或私钥文件。" "Certificate or key file not found."
  openssl x509 -in "$1" -noout -checkend 86400 >/dev/null || fail "证书一天之内就会过期。" "Certificate expires within one day."
  local public private
  public="$(openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)"
  private="$(openssl pkey -in "$2" -pubout -outform DER | sha256sum)"
  [[ "$public" = "$private" ]] || fail "证书和私钥不匹配。" "Certificate and private key do not match."
}
cert_name() {
  local output
  if [[ "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    output="$(openssl x509 -in "$1" -noout -checkip "$2")"
  else
    output="$(openssl x509 -in "$1" -noout -checkhost "$2")"
  fi
  [[ "$output" != *"NOT"* ]] || fail "证书与 $2 不符。" "Certificate does not match $2."
}
make_cert() {
  local name="$1" prefix="$2" days="$3" ca="$4"
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days "$days" \
    -subj "/CN=$name" -addext "subjectAltName=DNS:$name" \
    -addext "basicConstraints=critical,CA:$ca" \
    -keyout "$prefix.key" -out "$prefix.crt" >/dev/null 2>&1
}
wait_healthy() {
  local id state
  id="$(dc ps -q proxy)"
  [[ -n "$id" ]] || fail "容器没有启动。" "Container did not start."
  for _ in {1..60}; do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$id")"
    [[ "$state" = healthy ]] && return
    [[ "$(docker inspect --format '{{.State.Running}}' "$id")" = true ]] || break
    sleep 2
  done
  fail "服务没有正常运行。请执行 sudo $(self) logs 查看日志；凭据不会自动显示。" \
    "Service is not healthy. Run sudo $(self) logs; credentials are not printed automatically."
}
# A release archive brings the Web client built, and the image uses it over any sources beside it: an archive
# unpacked into a git checkout leaves the checkout's older client sources in place. A checkout that has moved
# on since drops the unpacked client and the help made with it, so that the image builds both from the sources again.
build_image() {
  local web="$ROOT/apps/server/web/index.html" commit
  if [[ -f "$web" && -d "$ROOT/.git" ]] && command -v git >/dev/null; then
    commit="$(git -c safe.directory="$ROOT" -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)"
    if ((commit > $(stat -c %Y "$web"))); then rm -rf -- "$ROOT/apps/server/web" "$ROOT/apps/server/help"; fi
  fi
  PROXY_IMAGE=cc-desk-tunnel:local docker compose --env-file "$CONFIG" -p "$PROJECT_NAME" \
    -f "$ROOT/deploy/docker/compose.yaml" build --pull
  save_image cc-desk-tunnel:local
}
version_of() { sed -n 's/^ *"version": "\([0-9.]*\)",\{0,1\}$/\1/p' "$ROOT/apps/desktop/package.json" 2>/dev/null | head -n 1; }
save_image() {
  save_var PROXY_IMAGE "$1"
  PROXY_IMAGE="$1"
}
# The image of this program's version, as the release workflow published it for amd64 and arm64.
pull_image() {
  local version image
  version="$(version_of)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || fail "$ROOT/apps/desktop/package.json 里没有程序版本。" "No program version in $ROOT/apps/desktop/package.json."
  image="${CC_DESK_TUNNEL_IMAGE:-ghcr.io/sun168567/cc-desk-tunnel}:$version"
  say "拉取镜像 $image …" "Pulling image ${image}…"
  docker pull "$image" || return
  # Only a pulled image is configured: a failed pull leaves the deployment as it was.
  save_image "$image"
}
# Where the image cannot be pulled (a version released before there were images, a registry this machine cannot
# reach, a checkout with changes of its own), it is built here from the program beside this script.
prepare_image() {
  case "${CC_DESK_TUNNEL_BUILD:-}" in
    1) build_image ;;
    0) pull_image || fail "拉取不到镜像。" "Cannot pull the image." ;;
    *)
      pull_image && return
      say "没有拉取到预构建镜像，改为在本机构建（需要几分钟，期间联网下载系统包和依赖）…" \
        "No prebuilt image could be pulled; building it here instead (a few minutes, downloading system packages and dependencies)…"
      build_image ;;
  esac
}
# The newest release's server archive (or CC_DESK_TUNNEL_VERSION's), checked against its SHA256SUMS.
fetch_release() {
  local releases=https://github.com/sun168567/cc-desk-tunnel/releases name version current
  local listed="$releases/latest/download"
  if [[ -n "${CC_DESK_TUNNEL_VERSION:-}" ]]; then
    [[ "$CC_DESK_TUNNEL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || fail "CC_DESK_TUNNEL_VERSION 应写成 X.Y.Z。" "CC_DESK_TUNNEL_VERSION must be X.Y.Z."
    listed="$releases/download/v$CC_DESK_TUNNEL_VERSION"
  fi
  FETCHED="$(mktemp -d)"
  trap 'rm -rf -- "$FETCHED"' EXIT
  if ! curl -fsSL --connect-timeout 20 --max-time 60 -o "$FETCHED/SHA256SUMS" "$listed/SHA256SUMS"; then
    [[ -z "${CC_DESK_TUNNEL_VERSION:-}" ]] \
      || fail "读不到 $CC_DESK_TUNNEL_VERSION 版的发布页，请确认这个版本存在。" "Cannot read release $CC_DESK_TUNNEL_VERSION; check that it exists."
    say "读不到发布页（检查这台机器能否访问 github.com），不下载新版本，用当前的 $(version_of) 继续。" \
      "Cannot read the releases (check that this machine can reach github.com); going on with the current $(version_of)."
    return
  fi
  name="$(awk '$2 ~ /^cc-desk-tunnel-server-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/ { print $2 }' "$FETCHED/SHA256SUMS" | head -n 1)"
  [[ -n "$name" ]] || fail "发布页的校验清单里没有服务端程序包。" "The release has no server archive."
  version="${name#cc-desk-tunnel-server-}"; version="${version%.tar.gz}"
  # Nothing newer, or the version asked for is here already. This is also how a manage.sh from before the images hands
  # over: it unpacks the archive it was given and runs this one without saying so.
  current="$(version_of)"
  if [[ "$version" = "$current" || ( -z "${CC_DESK_TUNNEL_VERSION:-}" && -n "$current" \
    && "$(printf '%s\n' "$version" "$current" | sort -V | tail -n 1)" = "$current" ) ]]; then
    say "已是最新版本 ${current}。" "Already the newest version, ${current}."
    return
  fi
  # The version found is fetched by its own address, even if the newest release changes meanwhile.
  say "下载 $name …" "Downloading ${name}…"
  curl -fL --connect-timeout 20 --max-time 600 --progress-bar -o "$FETCHED/$name" \
    "$releases/download/v$version/$name" || fail "下载失败。" "Download failed."
  (cd "$FETCHED" && grep "  $name\$" SHA256SUMS | sha256sum -c - >/dev/null) \
    || fail "程序包校验失败，已放弃。" "The archive does not match SHA256SUMS."
  ARCHIVE="$FETCHED/$name"
}
# `sudo cc-desk-tunnel COMMAND` from anywhere, for the installation managed with the default configuration.
COMMAND_LINK="${CC_DESK_TUNNEL_COMMAND:-/usr/local/bin/cc-desk-tunnel}"
# How the administrator runs this script: the command, where it is this installation's.
self() {
  if grep -qF "'$ROOT/deploy/manage.sh'" "$COMMAND_LINK" 2>/dev/null; then echo cc-desk-tunnel; else echo "bash $ROOT/deploy/manage.sh"; fi
}
link_command() {
  [[ "$(id -u)" = 0 && -z "${PROXY_DEPLOY_CONFIG:-}" ]] && safe_value "$ROOT" || return 0
  { printf '#!/usr/bin/env bash\n# CC Desk Tunnel management; written by the deploy/manage.sh it runs.\n'
    printf "exec bash '%s/deploy/manage.sh' \"\$@\"\n" "$ROOT"; } > "$COMMAND_LINK.new" \
    && chmod 755 "$COMMAND_LINK.new" && mv -- "$COMMAND_LINK.new" "$COMMAND_LINK" \
    || say "无法写入 ${COMMAND_LINK}，请改用 $ROOT/deploy/manage.sh。" "Could not write $COMMAND_LINK; run $ROOT/deploy/manage.sh instead." >&2
}
running() { [[ -n "$(dc ps --status running -q proxy)" ]]; }
ask() {
  local prompt="$1" default="${2:-}" answer
  read -r -p "$prompt${default:+ [$default]}: " answer
  printf '%s' "${answer:-$default}"
}
# Everything the Windows client and the administrator need after an install or upgrade.
summary() {
  local id fingerprint port state
  fingerprint="$(t "留空（按 CA 与域名校验）" "leave empty (checked against the CA and the domain)")"
  [[ "$MODE" != fingerprint ]] \
    || fingerprint="$(openssl x509 -in "$DATA_DIR/tls/control.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
  port="$CONTROL_PORT/TCP"
  [[ "$MODE" != nginx ]] || port="$(t "nginx 的 443/TCP" "nginx’s 443/TCP")"
  id="$(dc ps -q proxy 2>/dev/null || true)"
  state="$([[ -n "$id" ]] && docker inspect --format '{{.State.Health.Status}}' "$id" || t 未启动 "not started")"
  echo
  say "================ CC Desk Tunnel 部署汇总 ================" \
    "============ CC Desk Tunnel deployment summary ============"
  say "客户端填写" "For the client"
  say "  服务地址   $CONNECTION_URL" "  Service address                  $CONNECTION_URL"
  say "  证书指纹   $fingerprint" "  Service certificate fingerprint  $fingerprint"
  say "  服务凭据   $(sed -n "s/^PROXY_TOKEN='\(.*\)'$/\1/p" "$DATA_DIR/config/service.env")" \
    "  Service token                    $(sed -n "s/^PROXY_TOKEN='\(.*\)'$/\1/p" "$DATA_DIR/config/service.env")"
  say "服务器" "Server"
  say "  入口模式   $MODE" "  Entry mode                       $MODE"
  say "  需放行端口 $port" "  Port to open                     $port"
  say "  数据目录   $DATA_DIR" "  Data directory                   $DATA_DIR"
  say "  部署配置   $CONFIG" "  Deployment configuration         $CONFIG"
  say "  容器状态   $state" "  Container status                 $state"
  say "下一步" "Next"
  say "  1. 云防火墙只放行上面“需放行端口”一项；本项目不需要其他入站端口。" \
    "  1. Open only the “Port to open” above in the cloud firewall; this project needs no other inbound port."
  say "  2. Windows 客户端填入服务地址、指纹和凭据并连接。" \
    "  2. Enter the service address, fingerprint and token in the Windows client and connect."
  say "  3. 在客户端账号页登录 Claude 账号。" "  3. Sign in to Claude on the client’s Account page."
  say "  使用第三方 API 时编辑 $DATA_DIR/config/provider.json 后执行 sudo $(self) restart。" \
    "  For a third-party API, edit $DATA_DIR/config/provider.json, then run sudo $(self) restart."
  say "  日常管理：sudo $(self) status | logs | upgrade | help" "  Everyday commands: sudo $(self) status | logs | upgrade | help"
  say "以上凭据等同于服务器登录权限，请勿外传。" "The token above is as good as a login to this server; keep it to yourself."
  say "=======================================================" \
    "==========================================================="
}
# A backup is the whole data directory: the Claude login and settings in the native home, the sessions and their
# working folders, this service's token, certificates and settings. Left out: SSH credentials of the moment, caches,
# and the copies earlier migrations kept of the session database. A note ahead of the data says where and when.
NOTE=cc-desk-tunnel-backup.txt
backup_name() {
  local host
  host="$(hostname 2>/dev/null || true)"; host="${host%%.*}"; host="${host//[^A-Za-z0-9_-]/-}"
  printf 'cc-desk-tunnel-backup-%s-%s%s.tar.gz' "${host:-server}" "$(date +%Y%m%d-%H%M%S)" "${1:-}"
}
# With the service stopped, for SQLite and the native files to agree. Written aside and renamed when complete.
make_backup() {
  local note
  note="$(mktemp -d)"
  printf 'CC Desk Tunnel 服务端备份\nversion=%s\ncreated=%s\nhost=%s\nmode=%s\nurl=%s\n' "$(version_of)" \
    "$(date '+%Y-%m-%d %H:%M:%S %z')" "$(hostname 2>/dev/null || true)" "$MODE" "$CONNECTION_URL" > "$note/$NOTE"
  if ! tar --exclude=./state/connections --exclude=./state/devices --exclude=./state/backups --exclude=./home/.cache \
    --exclude=./.restore --exclude=./.replaced -czf "$1.partial" -C "$note" "$NOTE" -C "$DATA_DIR" .; then
    rm -rf -- "$note" "$1.partial"
    return 1
  fi
  rm -rf -- "$note"
  chmod 600 "$1.partial"
  mv -- "$1.partial" "$1"
}
command="${1:-help}"
shift || true
case "$command" in
  help|--help|-h) usage; exit ;;
  setup)
    if [[ -f "$CONFIG" ]]; then
      say "已有部署配置（${CONFIG}），跳过问答，准备镜像并启动。" \
        "Found the deployment configuration (${CONFIG}); skipping the questions, getting the image and starting."
    else
      [[ -t 0 ]] || fail "setup 需要交互式终端；脚本里请用带参数的 init。" "setup needs an interactive terminal; use init with options in scripts."
      say "CC Desk Tunnel 首次安装。直接回车使用方括号内的默认值。" "First install of CC Desk Tunnel. Press Enter to take the default in brackets."
      detected="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
      [[ "$detected" =~ ^[0-9.]+$ ]] || detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
      # Each answer is checked as it is given and asked again, not after all the questions.
      while :; do
        host="$(host_of "$(ask "$(t "Windows 能访问到的公网 IP 或域名" "Public IP or domain name that Windows can reach")" "$detected")")"
        valid_host "$host" && break
        say "“${host}”不是 IPv4 地址或域名：只填地址本身，不带 https://、端口和路径；中文域名填 xn-- 开头的形式；暂不支持 IPv6。" \
          "“${host}” is not an IPv4 address or a domain name: enter the address alone, without https://, a port or a path; an internationalized domain in its xn-- form. IPv6 is not supported yet." >&2
      done
      say "入口方式：1) 自签证书 + 指纹（无域名时用）  2) 已有域名证书  3) 已有 nginx 反代" \
        "Entry mode: 1) self-signed certificate + fingerprint (without a domain)  2) a certificate for your domain  3) your nginx as reverse proxy"
      while :; do
        case "$(ask "$(t "选择 1 / 2 / 3" "Choose 1 / 2 / 3")" 1)" in
          1) mode=fingerprint ;; 2) mode=certificate ;; 3) mode=nginx ;; *) say "请输入 1、2 或 3。" "Enter 1, 2 or 3." >&2; continue ;;
        esac
        break
      done
      options=(--host "$host" --mode "$mode")
      if [[ "$mode" = certificate ]]; then
        while :; do
          cert="$(ask "$(t "证书链文件 fullchain.pem 的路径" "Path of the certificate chain, fullchain.pem")")"
          key="$(ask "$(t "私钥文件 privkey.pem 的路径" "Path of the private key, privkey.pem")")"
          (cert_pair "$cert" "$key" && cert_name "$cert" "$host") && break
          say "请重新填写证书和私钥。" "Enter the certificate and the key again." >&2
        done
        options+=(--cert "$cert" --key "$key")
      fi
      if [[ "$mode" = nginx ]]; then
        while :; do
          url="$(ask "$(t "客户端使用的 WSS 地址" "WSS address for the client")" "wss://$host/ws")"
          [[ "$url" =~ ^wss://[^/@?#]+/ws$ ]] && break
          say "WSS 地址应写成 wss://域名/ws。" "Write the WSS address as wss://DOMAIN/ws." >&2
        done
        options+=(--url "$url")
      fi
      while :; do
        port="$(ask "$(t "控制端口" "Control port")" 8787)"
        valid_port "$port" && break
        say "端口应在 1024 到 65535 之间。" "The port must be between 1024 and 65535." >&2
      done
      options+=(--control-port "$port")
      default_data="${HOME}/.local/share/cc-desk-tunnel-container"
      [[ "$(id -u)" != 0 ]] || default_data=/srv/cc-desk-tunnel
      while :; do
        data="$(ask "$(t "数据目录（新建，存放账号、会话与证书）" "Data directory (new; holds the account, sessions and certificates)")" "$default_data")"
        [[ "$data" = /* && "$data" != / && "$(realpath -m -- "$data")" != "$(realpath -- "$HOME")" ]] && safe_value "$data" \
          || { say "请填写一个专用的绝对路径，例如 ${default_data}。" "Enter a dedicated absolute path, such as ${default_data}." >&2; continue; }
        [[ ! -e "$data" ]] && break
        say "$data 已存在。数据目录必须是新的，以免覆盖已有内容；换一个路径。" \
          "$data already exists. The data directory must be new, so that nothing is overwritten; choose another path." >&2
      done
      options+=(--data "$data")
      while :; do
        token="$(ask "$(t "服务凭据（至少 24 位；留空自动生成）" "Service token (24 characters or more; empty to generate one)")")"
        [[ -z "$token" || "$token" =~ ^[A-Za-z0-9._~+/=-]{24,512}$ ]] && break
        say "凭据需要 24 到 512 位，只用字母、数字和 . _ ~ + / = -。" \
          "The token needs 24 to 512 characters, only letters, digits and . _ ~ + / = -" >&2
      done
      [[ -z "$token" ]] || options+=(--token "$token")
      bash "${BASH_SOURCE[0]}" init "${options[@]}"
    fi
    load
    link_command
    prepare_image
    dc up -d --no-build
    wait_healthy
    summary
    exit ;;
  init)
    HOST='' MODE=fingerprint DATA_DIR="${HOME}/.local/share/cc-desk-tunnel-container"
    [[ "$(id -u)" != 0 ]] || DATA_DIR=/srv/cc-desk-tunnel
    CONTROL_PORT=8787 CERT='' KEY='' URL='' TOKEN=''
    while (($#)); do
      [[ $# -ge 2 ]] || fail "$1 缺少值。" "Missing value for $1"
      case "$1" in
        --host) HOST="$2" ;; --mode) MODE="$2" ;; --data) DATA_DIR="$2" ;;
        --control-port) CONTROL_PORT="$2" ;;
        # Given by scripts written for 0.2.9 and earlier, when the execution channel had a port of its own.
        --frps-port) ;;
        --cert) CERT="$2" ;; --key) KEY="$2" ;; --url) URL="$2" ;; --token) TOKEN="$2" ;;
        *) fail "未知选项：$1" "Unknown option: $1" ;;
      esac
      shift 2
    done
    valid_host "$HOST" || fail "--host 需要 Windows 能访问到的 IPv4 地址或域名（暂不支持 IPv6）。" \
      "--host needs an IPv4 address or DNS name reachable by Windows (no IPv6 yet)."
    [[ "$MODE" =~ ^(fingerprint|certificate|nginx)$ ]] || fail "--mode 只能是 fingerprint、certificate 或 nginx。" "Invalid mode."
    valid_port "$CONTROL_PORT" || fail "端口应在 1024 到 65535 之间。" "The port must be 1024..65535."
    [[ "$DATA_DIR" = /* && "$DATA_DIR" != / && "$DATA_DIR" != "$HOME" ]] \
      || fail "数据目录请用一个专用的绝对路径。" "Choose an absolute dedicated data directory."
    DATA_DIR="$(realpath -m -- "$DATA_DIR")"
    [[ "$DATA_DIR" != / && "$DATA_DIR" != "$(realpath -- "$HOME")" ]] || fail "数据目录请用一个专用的目录。" "Choose a dedicated data directory."
    [[ ! -e "$CONFIG" ]] || fail "部署配置已存在；请用 upgrade，或用另一个 PROXY_DEPLOY_CONFIG。" \
      "Configuration already exists; use upgrade or a separate PROXY_DEPLOY_CONFIG."
    safe_value "$DATA_DIR" || fail "数据路径含有不支持的字符。" "Unsupported data path."
    [[ "$(id -u)" = 0 || "$(id -u)" = 1000 ]] || fail "请用 sudo 执行 init：容器的数据需要属于 uid 1000。" \
      "Run init with sudo; container data needs uid 1000 ownership."
    [[ ! -e "$DATA_DIR" ]] || fail "数据目录已存在，不会覆盖它。" "Data directory already exists; do not overwrite it."
    command -v docker >/dev/null && docker compose version >/dev/null \
      || fail "请先安装 Docker Engine 和 Compose。" "Install Docker Engine and Compose first."
    command -v openssl >/dev/null || fail "请先安装 OpenSSL。" "Install OpenSSL first."
    if [[ "$MODE" = certificate ]]; then
      [[ -n "$CERT" && -n "$KEY" ]] || fail "需要 --cert 和 --key。" "--cert and --key required."
      cert_pair "$CERT" "$KEY"
      cert_name "$CERT" "$HOST"
    fi
    CONTROL_BIND=0.0.0.0
    [[ "$MODE" != nginx ]] || CONTROL_BIND=127.0.0.1
    URL="${URL:-wss://$HOST:$CONTROL_PORT/ws}"
    if [[ "$MODE" = nginx && "$URL" = "wss://$HOST:$CONTROL_PORT/ws" ]]; then URL="wss://$HOST/ws"; fi
    [[ "$URL" =~ ^wss://[^/@?#]+/ws$ ]] || fail "--url 应为 wss://…/ws 形式的地址。" "--url must be a WSS /ws address."
    mkdir -p "$DATA_DIR"/{config,tls,home,state,workspace} "$(dirname -- "$CONFIG")"
    touch "$DATA_DIR/.cc-desk-tunnel-data"
    CERT_NAME=cc-desk-tunnel.local
    if [[ "$MODE" = fingerprint ]]; then
      make_cert "$CERT_NAME" "$DATA_DIR/tls/control" 365 FALSE
    elif [[ "$MODE" = certificate ]]; then
      cp -- "$CERT" "$DATA_DIR/tls/control.crt"
      cp -- "$KEY" "$DATA_DIR/tls/control.key"
      CERT_NAME="$HOST"
    fi
    [[ -n "$TOKEN" ]] || TOKEN="$(openssl rand -hex 32)"
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{24,512}$ ]] || fail "--token 需要 24 到 512 位，只用 A-Z a-z 0-9 . _ ~ + / = -" \
      "--token needs 24..512 characters from A-Z a-z 0-9 . _ ~ + / = -"
    {
      write_var PROXY_ADAPTER claude-code
      write_var PROXY_TOKEN "$TOKEN"
      write_var PROXY_HOST 0.0.0.0
      write_var PROXY_PORT 8787
      write_var PROXY_TLS_MODE "$([[ "$MODE" = nginx ]] && echo reverse-proxy || echo direct)"
      write_var PROXY_TLS_CERT /data/tls/control.crt
      write_var PROXY_TLS_KEY /data/tls/control.key
      write_var PROXY_CERT_NAME "$CERT_NAME"
      write_var PROXY_DATA_DIR /data/state
      write_var CLAUDE_CONTEXT_RETENTION_DAYS 3650
      write_var CLAUDE_SETTINGS_PATH /data/config/provider.json
    } > "$DATA_DIR/config/service.env"
    printf '{}\n' > "$DATA_DIR/config/provider.json"
    PROJECT_NAME="cc-desk-tunnel-$(openssl rand -hex 4)"
    {
      write_var PROJECT_NAME "$PROJECT_NAME"
      write_var DATA_DIR "$DATA_DIR"
      write_var CONTROL_BIND "$CONTROL_BIND"
      write_var CONTROL_PORT "$CONTROL_PORT"
      write_var MODE "$MODE"
      write_var CONNECTION_URL "$URL"
      write_var PROXY_IMAGE cc-desk-tunnel:local
      [[ -z "${CC_DESK_TUNNEL_LANG:-}" ]] || write_var SCRIPT_LANG "$(t zh en)"
    } > "$CONFIG"
    if [[ "$(id -u)" = 0 ]]; then
      chown -R 1000:1000 "$DATA_DIR"
    fi
    link_command
    say "已初始化。需要 API 设置时编辑 $DATA_DIR/config/provider.json，然后执行 up。" \
      "Initialized. Edit $DATA_DIR/config/provider.json for API settings, then up."
    say "客户端连接信息（私密）：manage.sh connection" "Private client connection information: manage.sh connection"
    exit ;;
esac
load
case "$command" in
  build) build_image ;;
  pull) pull_image ;;
  up)
    docker image inspect "$PROXY_IMAGE" >/dev/null 2>&1 || prepare_image
    dc up -d --no-build; wait_healthy ;;
  status) dc ps ;;
  logs) dc logs --tail=100 -f ;;
  stop) dc stop ;;
  restart) dc restart; wait_healthy ;;
  upgrade)
    # Data, account and configuration live outside the image; only the program is replaced. An installation from
    # a release fetches the next one; a checkout goes on with its own sources.
    # CC_DESK_TUNNEL_UNPACKED says the program here is already the one to run (install.sh unpacked it).
    if [[ "${1:-}" = --from ]]; then
      [[ $# = 2 && -f "$2" ]] || fail "请指定服务端程序包：upgrade --from /path/cc-desk-tunnel-server.tar.gz" \
        "Specify the server archive: upgrade --from /path/cc-desk-tunnel-server.tar.gz"
      ARCHIVE="$2"
    else
      [[ $# = 0 ]] || fail "upgrade 除了 --from SERVER_ARCHIVE 不接受其他参数。" "upgrade takes no arguments besides --from SERVER_ARCHIVE."
      [[ -n "${CC_DESK_TUNNEL_UNPACKED:-}" || -d "$ROOT/.git" ]] || fetch_release
    fi
    if [[ -n "${ARCHIVE:-}" ]]; then
      if tar -tzf "$ARCHIVE" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then fail "程序包内含不安全的路径。" "Unsafe archive paths."; fi
      tar -tzf "$ARCHIVE" | grep -Fx 'deploy/manage.sh' >/dev/null \
        || fail "这不是 CC Desk Tunnel 的服务端程序包。" "Not a CC Desk Tunnel server archive."
      tar -xzf "$ARCHIVE" -C "$ROOT" --no-same-owner
      # The script just unpacked goes on, so that what this version changed in it applies.
      CC_DESK_TUNNEL_UNPACKED=1 bash "$ROOT/deploy/manage.sh" upgrade
      exit
    fi
    say "程序版本 $(version_of)。" "Program version $(version_of)."
    link_command
    previous="$PROXY_IMAGE"
    prepare_image
    # The port frp had before 0.2.10 is no longer published; its setting goes with it.
    if grep -q '^FRPS_PORT=' "$CONFIG"; then sed -i '/^FRPS_PORT=/d' "$CONFIG"; fi
    dc up -d --no-build; wait_healthy
    # Each image is a few gigabytes. The one replaced goes, if it is one of this project's that can be had again.
    if [[ "$previous" != "$PROXY_IMAGE" && "$previous" =~ ^(ghcr\.io/sun168567/cc-desk-tunnel:.+|cc-desk-tunnel:local)$ ]] \
      && [[ "$(docker image inspect -f '{{.Id}}' "$previous" 2>/dev/null)" != "$(docker image inspect -f '{{.Id}}' "$PROXY_IMAGE")" ]] \
      && docker image rm "$previous" >/dev/null 2>&1; then
      say "已删除替换下来的镜像 ${previous}。" "Removed the replaced image ${previous}."
    fi
    summary ;;
  summary) summary ;;
  client)
    [[ $# = 1 && -f "$1" && "$(basename -- "$1")" =~ ^CC-Desk-Tunnel-Setup-[0-9]+\.[0-9]+\.[0-9]+-x64\.exe$ ]] \
      || fail "请指定构建出的原名安装包：CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe" "Specify the installer as built: CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe"
    mkdir -p "$DATA_DIR/state/client"
    install -m 644 "$1" "$DATA_DIR/state/client/"
    [[ "$(id -u)" != 0 ]] || chown -R 1000:1000 "$DATA_DIR/state/client"
    say "安装包已发布，客户端下次连接时会看到升级。" "Installer published. Clients see the upgrade the next time they connect."
    ;;
  token)
    # Every saved client login stops working; the summary prints the new token.
    [[ $# -le 1 ]] || fail "最多指定一个凭据。" "Specify at most one token."
    TOKEN="${1:-$(openssl rand -hex 32)}"
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{24,512}$ ]] || fail "凭据需要 24 到 512 位，只用 A-Z a-z 0-9 . _ ~ + / = -" \
      "The token needs 24..512 characters from A-Z a-z 0-9 . _ ~ + / = -"
    temp="$(mktemp "$DATA_DIR/config/service.env.XXXXXX")"
    { grep -v '^PROXY_TOKEN=' "$DATA_DIR/config/service.env"; write_var PROXY_TOKEN "$TOKEN"; } > "$temp"
    chmod 600 "$temp"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$temp"
    mv -- "$temp" "$DATA_DIR/config/service.env"
    if running; then dc restart; wait_healthy; fi
    summary ;;
  release-token)
    # Read-only access to the releases of a private repository; without an argument the token is removed.
    [[ $# -le 1 ]] || fail "最多指定一个令牌文件。" "Specify at most one token file."
    RELEASE_TOKEN=""
    if [[ $# = 1 ]]; then
      [[ -f "$1" ]] || fail "请指定存放令牌的文件。" "Specify the file holding the token."
      RELEASE_TOKEN="$(tr -d '[:space:]' < "$1")"
      [[ "$RELEASE_TOKEN" =~ ^[A-Za-z0-9_]{20,255}$ ]] || fail "这个文件里不是 GitHub 令牌。" "That file does not hold a GitHub token."
    fi
    temp="$(mktemp "$DATA_DIR/config/service.env.XXXXXX")"
    {
      grep -v '^PROXY_RELEASE_TOKEN=' "$DATA_DIR/config/service.env" || true
      [[ -z "$RELEASE_TOKEN" ]] || write_var PROXY_RELEASE_TOKEN "$RELEASE_TOKEN"
    } > "$temp"
    chmod 600 "$temp"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$temp"
    mv -- "$temp" "$DATA_DIR/config/service.env"
    if running; then dc restart; wait_healthy; fi
    if [[ -n "$RELEASE_TOKEN" ]]; then say "发布令牌已保存。" "Release token saved."; else say "发布令牌已删除。" "Release token removed."; fi
    ;;
  uninstall)
    dc down --remove-orphans
    if grep -qF "'$ROOT/deploy/manage.sh'" "$COMMAND_LINK" 2>/dev/null; then rm -f -- "$COMMAND_LINK"; fi
    say "已删除容器和网络。数据和配置保留在 $DATA_DIR" "Removed containers/network. Data and config retained: $DATA_DIR" ;;
  connection)
    say "服务地址：$CONNECTION_URL" "URL: $CONNECTION_URL"
    if [[ "$MODE" = fingerprint ]]; then
      openssl x509 -in "$DATA_DIR/tls/control.crt" -noout -fingerprint -sha256
    else
      say "证书指纹：留空，按 CA 与域名校验。" "Certificate fingerprint: leave empty for standard CA/domain verification."
    fi
    grep '^PROXY_TOKEN=' "$DATA_DIR/config/service.env"
    ;;
  backup)
    # A directory, or nothing for the current one, gets a file named for this machine and the moment.
    [[ $# -le 1 ]] || fail "最多指定一个文件或目录。" "Specify at most one file or directory."
    archive="${1:-.}"
    [[ ! -d "$archive" ]] || archive="$archive/$(backup_name)"
    archive="$(realpath -m -- "$archive")"
    [[ ! -e "$archive" ]] || fail "$archive 已存在。" "$archive already exists."
    [[ -d "$(dirname -- "$archive")" ]] || fail "没有目录 $(dirname -- "$archive")。" "No directory $(dirname -- "$archive")."
    [[ "$archive" != "$DATA_DIR/"* ]] || fail "备份必须放在数据目录之外。" "Backup must be outside the data directory."
    was_running=false; running && was_running=true
    trap 'if $was_running; then dc start >/dev/null; fi' EXIT
    say "备份期间服务暂停，数据多时需要几分钟…" "The service pauses for the backup; with much data it takes a few minutes…"
    dc stop
    make_backup "$archive" || fail "备份失败，没有保存任何内容。" "Backup failed; nothing was saved."
    say "备份完成：${archive}（$(du -h -- "$archive" | cut -f1)）" "Backed up: ${archive} ($(du -h -- "$archive" | cut -f1))"
    say "内含 Claude 账号登录、服务凭据、证书、设置和全部会话与工作目录，请像密码一样保管。" \
      "It holds the Claude login, the service token, certificates, settings and all sessions and working folders: keep it like a password."
    say "迁移到另一台服务器：在那里安装好，把这个文件拷过去，执行 sudo $(self) restore 文件路径。" \
      "To move to another server: install there, copy this file over and run sudo $(self) restore FILE."
    ;;
  restore)
    yes=false archive=''
    for argument; do
      case "$argument" in
        --yes|-y) yes=true ;;
        *) [[ -z "$archive" ]] || fail "只能指定一个备份。" "Specify one backup."; archive="$argument" ;;
      esac
    done
    [[ -n "$archive" && -f "$archive" ]] || fail "请指定备份文件：restore /path/cc-desk-tunnel-backup-….tar.gz" \
      "Specify the backup file: restore /path/cc-desk-tunnel-backup-….tar.gz"
    archive="$(realpath -- "$archive")"
    [[ "$archive" != "$DATA_DIR/"* ]] || fail "请先把备份移出数据目录，还原会替换数据目录。" \
      "Move the backup out of the data directory first; restoring replaces it."
    listing="$(mktemp)"
    trap 'rm -f -- "$listing"' EXIT
    say "检查备份文件…" "Checking the backup…"
    tar -tzf "$archive" > "$listing" 2>/dev/null || fail "无法把 $archive 当作 .tar.gz 读取。" "Cannot read $archive as a .tar.gz archive."
    grep -Fxq './.cc-desk-tunnel-data' "$listing" && grep -Fxq './config/service.env' "$listing" \
      || fail "这不是 CC Desk Tunnel 的备份。" "Not a CC Desk Tunnel backup."
    if grep -E '(^/|(^|/)\.\.(/|$))' "$listing" >/dev/null; then fail "备份内含不安全的路径。" "Unsafe archive paths."; fi
    # Data written by a newer version may not be readable by this one; migrations only go forward.
    note="$(tar -xzOf "$archive" "$NOTE" 2>/dev/null || true)"
    from="$(sed -n 's/^version=//p' <<< "$note")" current="$(version_of)"
    if [[ -n "$from" && -n "$current" && "$from" != "$current" \
      && "$(printf '%s\n' "$from" "$current" | sort -V | tail -n 1)" = "$from" ]]; then
      fail "这份备份来自 $from 版，比这里的 $current 新。先执行 sudo $(self) upgrade 升级，再还原。" \
        "This backup is from version $from, newer than $current here. Run sudo $(self) upgrade first, then restore."
    fi
    source_text="$(t "（早期版本做的备份，没有记录来源）" "(made by an early version, which kept no record of where)")"
    if [[ -n "$note" ]]; then
      source_text="$(t 主机 host) $(sed -n 's/^host=//p' <<< "$note") · $(t 版本 version) ${from:-$(t 未知 unknown)} · $(sed -n 's/^created=//p' <<< "$note")"
    fi
    safety="$(dirname -- "$archive")/$(backup_name -before-restore)"
    red='' plain=''
    if [[ -t 1 ]]; then red=$'\e[1;31m' plain=$'\e[0m'; fi
    if [[ -n "$english" ]]; then
      cat <<NOTICE

${red}================ Restoring a backup: the data on this server is overwritten ================${plain}
  Backup       ${archive} ($(du -h -- "$archive" | cut -f1))
  From         $source_text
  Replaces     ${DATA_DIR} (now $(du -sh -- "$DATA_DIR" 2>/dev/null | cut -f1))

  The backup replaces all sessions and working folders here, the Claude login, the service token and settings:
  ${red}what is here now is overwritten.${plain} Before that, the data here is saved as
    $safety
  This server’s address, port and entry mode stay as they are. The service pauses and starts again after the restore.
${red}===========================================================================================${plain}

NOTICE
    else
      cat <<NOTICE

${red}================ 还原备份：覆盖这台服务器上的现有数据 ================${plain}
  备份文件   ${archive}（$(du -h -- "$archive" | cut -f1)）
  备份来源   $source_text
  覆盖目标   ${DATA_DIR}（现占用 $(du -sh -- "$DATA_DIR" 2>/dev/null | cut -f1)）

  还原会用备份替换这里的全部会话和工作目录、Claude 账号登录、服务凭据和设置，
  ${red}现有的这些内容都会被覆盖。${plain}覆盖之前，现有数据先另存为
    $safety
  这台服务器的访问地址、端口和入口方式不变。服务暂停，还原后自动启动。
${red}======================================================================${plain}

NOTICE
    fi
    if ! $yes; then
      [[ -t 0 ]] || fail "没有可以确认的终端；不询问直接还原请加 --yes。" "No terminal to confirm on; add --yes to restore without asking."
      read -r -p "$(t "确认覆盖请输入 yes（其他输入都会取消）: " "Type yes to overwrite (anything else cancels): ")" answer
      [[ "$answer" = yes ]] || { say "已取消，没有改动。" "Cancelled; nothing changed."; exit 0; }
    fi
    was_running=false; running && was_running=true
    dc stop
    say "另存现有数据…" "Saving the data here…"
    if ! make_backup "$safety"; then
      if $was_running; then dc start >/dev/null; fi
      fail "无法另存现有数据，没有还原。" "Could not save the current data; nothing was restored."
    fi
    say "还原…" "Restoring…"
    # Unpacked beside the data, on the same disk even when the data directory is a mount of its own, then put in
    # place by renaming.
    stage="$DATA_DIR/.restore" old="$DATA_DIR/.replaced"
    rm -rf -- "$stage" "$old"
    mkdir -- "$stage" "$old"
    if ! tar -xzf "$archive" -C "$stage" --no-same-owner; then
      rm -rf -- "$stage" "$old"
      if $was_running; then dc start >/dev/null; fi
      fail "无法解开备份，数据保持原样。" "Could not unpack the backup; the data is as it was."
    fi
    rm -f -- "$stage/$NOTE"
    # This machine's way in stays its own. A self-signed certificate comes with the backup when this machine uses
    # one too: it names no host, so clients that pinned its fingerprint keep it.
    if ! [[ "$MODE" = fingerprint ]] || ! grep -qx "PROXY_CERT_NAME='cc-desk-tunnel.local'" "$stage/config/service.env" \
      || ! grep -qx "PROXY_TLS_MODE='direct'" "$stage/config/service.env"; then
      way_in='^PROXY_(TLS_MODE|TLS_CERT|TLS_KEY|CERT_NAME)='
      rm -rf -- "$stage/tls"
      cp -a -- "$DATA_DIR/tls" "$stage/tls"
      { grep -Ev "$way_in" "$stage/config/service.env" || true; grep -E "$way_in" "$DATA_DIR/config/service.env"; } \
        > "$stage/config/service.env.new"
      mv -- "$stage/config/service.env.new" "$stage/config/service.env"
    fi
    for entry in "$DATA_DIR"/* "$DATA_DIR"/.[!.]* "$DATA_DIR"/..?*; do
      [[ -e "$entry" || -L "$entry" ]] && [[ "$entry" != "$stage" && "$entry" != "$old" ]] || continue
      mv -- "$entry" "$old/"
    done
    for entry in "$stage"/* "$stage"/.[!.]* "$stage"/..?*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      mv -- "$entry" "$DATA_DIR/"
    done
    rm -rf -- "$stage" "$old"
    chmod 700 "$DATA_DIR"
    [[ "$(id -u)" != 0 ]] || chown -R 1000:1000 "$DATA_DIR"
    say "已还原。还原前的数据另存在 ${safety}，确认无误后可以删除。" \
      "Restored. The data from before is saved in ${safety}; delete it once all is well."
    docker image inspect "$PROXY_IMAGE" >/dev/null 2>&1 || prepare_image
    dc up -d --no-build; wait_healthy
    summary
    ;;
  certificate|renew)
    [[ "$MODE" != nginx ]] || fail "前端证书由 nginx 管理和续期，请在 nginx 那里更换并重新加载。" \
      "nginx owns and renews the frontend certificate; reload nginx there."
    temp="$(mktemp -d)"
    trap 'rm -rf -- "$temp"' EXIT
    if [[ "$command" = renew ]]; then
      [[ "$MODE" = fingerprint ]] || fail "CA 签发的证书请用 certificate FULLCHAIN KEY 更换。" "Use certificate FULLCHAIN KEY for CA certificates."
      make_cert cc-desk-tunnel.local "$temp/control" 365 FALSE
    else
      [[ $# = 2 ]] || fail "请指定证书和私钥。" "Specify certificate and key."
      cert_pair "$1" "$2"
      if [[ "$MODE" = certificate ]]; then
        name="$(sed -n "s/^PROXY_CERT_NAME='\(.*\)'$/\1/p" "$DATA_DIR/config/service.env")"
        cert_name "$1" "$name"
      fi
      cp -- "$1" "$temp/control.crt"; cp -- "$2" "$temp/control.key"
    fi
    was_running=false; running && was_running=true
    dc stop
    install -m 600 "$temp/control.crt" "$DATA_DIR/tls/control.crt"
    install -m 600 "$temp/control.key" "$DATA_DIR/tls/control.key"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$DATA_DIR"/tls/control.{crt,key}
    if $was_running; then dc start; wait_healthy; fi
    say "前端证书已更换。指纹模式下，客户端需要改填新的证书指纹。" "Frontend certificate replaced. Fingerprint mode clients must update their pin."
    ;;
  *) usage; fail "未知命令：$command" "Unknown command: $command" ;;
esac
