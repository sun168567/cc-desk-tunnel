#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${PROXY_DEPLOY_CONFIG:-$ROOT/.local/docker.env}"
COMPOSE="${PROXY_COMPOSE_FILE:-$ROOT/deploy/compose.yml}"

usage() {
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
HELP
}
fail() { echo "$*" >&2; exit 1; }
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
write_var() { safe_value "$2" || fail "Unsupported characters in $1"; printf "%s='%s'\n" "$1" "$2"; }
dc() { docker compose --env-file "$CONFIG" -p "$PROJECT_NAME" -f "$COMPOSE" "$@"; }
load() {
  [[ -f "$CONFIG" ]] || fail "Run init first."
  # This file is a private, locally generated deployment configuration.
  source "$CONFIG"
  [[ "$DATA_DIR" = /* && -f "$DATA_DIR/.cc-desk-tunnel-data" ]] || fail "Invalid managed data directory."
  DATA_DIR="$(realpath -- "$DATA_DIR")"
}
cert_pair() {
  [[ -f "$1" && -f "$2" ]] || fail "Certificate or key file not found."
  openssl x509 -in "$1" -noout -checkend 86400 >/dev/null || fail "Certificate expires within one day."
  local public private
  public="$(openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)"
  private="$(openssl pkey -in "$2" -pubout -outform DER | sha256sum)"
  [[ "$public" = "$private" ]] || fail "Certificate and private key do not match."
}
cert_name() {
  local output
  if [[ "$2" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    output="$(openssl x509 -in "$1" -noout -checkip "$2")"
  else
    output="$(openssl x509 -in "$1" -noout -checkhost "$2")"
  fi
  [[ "$output" != *"NOT"* ]] || fail "Certificate does not match $2."
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
  [[ -n "$id" ]] || fail "Container did not start."
  for _ in {1..60}; do
    state="$(docker inspect --format '{{.State.Health.Status}}' "$id")"
    [[ "$state" = healthy ]] && return
    [[ "$(docker inspect --format '{{.State.Running}}' "$id")" = true ]] || break
    sleep 2
  done
  fail "Service is not healthy. Run manage.sh logs; credentials are not printed automatically."
}
# A release archive brings the Web client built, and the image uses it over any sources beside it: an archive
# unpacked into a git checkout leaves the checkout's older client sources in place. A checkout that has moved
# on since drops the unpacked client, so that the image builds the client from the sources again.
build_image() {
  local web="$ROOT/apps/server/web/index.html" commit
  if [[ -f "$web" && -d "$ROOT/.git" ]] && command -v git >/dev/null; then
    commit="$(git -c safe.directory="$ROOT" -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 0)"
    if ((commit > $(stat -c %Y "$web"))); then rm -rf -- "$ROOT/apps/server/web"; fi
  fi
  PROXY_IMAGE=cc-desk-tunnel:local docker compose --env-file "$CONFIG" -p "$PROJECT_NAME" \
    -f "$ROOT/deploy/docker/compose.yaml" build --pull
  save_image cc-desk-tunnel:local
}
version_of() { sed -n 's/^ *"version": "\([0-9.]*\)",\{0,1\}$/\1/p' "$ROOT/apps/desktop/package.json" 2>/dev/null | head -n 1; }
save_image() {
  local temp
  temp="$(mktemp "$CONFIG.XXXXXX")"
  { grep -v '^PROXY_IMAGE=' "$CONFIG" || true; write_var PROXY_IMAGE "$1"; } > "$temp"
  mv -- "$temp" "$CONFIG"
  PROXY_IMAGE="$1"
}
# The image of this program's version, as the release workflow published it for amd64 and arm64.
pull_image() {
  local version image
  version="$(version_of)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "No program version in $ROOT/apps/desktop/package.json."
  image="${CC_DESK_TUNNEL_IMAGE:-ghcr.io/sun168567/cc-desk-tunnel}:$version"
  echo "拉取镜像 $image …"
  docker pull "$image" || return
  # Only a pulled image is configured: a failed pull leaves the deployment as it was.
  save_image "$image"
}
# Where the image cannot be pulled (a version released before there were images, a registry this machine cannot
# reach, a checkout with changes of its own), it is built here from the program beside this script.
prepare_image() {
  case "${CC_DESK_TUNNEL_BUILD:-}" in
    1) build_image ;;
    0) pull_image || fail "Cannot pull the image." ;;
    *)
      pull_image && return
      echo "没有拉取到预构建镜像，改为在本机构建（需要几分钟，期间联网下载系统包和依赖）…"
      build_image ;;
  esac
}
# The newest release's server archive (or CC_DESK_TUNNEL_VERSION's), checked against its SHA256SUMS.
fetch_release() {
  local releases=https://github.com/sun168567/cc-desk-tunnel/releases name version current
  local listed="$releases/latest/download"
  if [[ -n "${CC_DESK_TUNNEL_VERSION:-}" ]]; then
    [[ "$CC_DESK_TUNNEL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "CC_DESK_TUNNEL_VERSION must be X.Y.Z."
    listed="$releases/download/v$CC_DESK_TUNNEL_VERSION"
  fi
  FETCHED="$(mktemp -d)"
  trap 'rm -rf -- "$FETCHED"' EXIT
  if ! curl -fsSL --connect-timeout 20 --max-time 60 -o "$FETCHED/SHA256SUMS" "$listed/SHA256SUMS"; then
    [[ -z "${CC_DESK_TUNNEL_VERSION:-}" ]] || fail "Cannot read release $CC_DESK_TUNNEL_VERSION; check that it exists."
    echo "读不到发布页（检查这台机器能否访问 github.com），不下载新版本，用当前的 $(version_of) 继续。"
    return
  fi
  name="$(awk '$2 ~ /^cc-desk-tunnel-server-[0-9]+\.[0-9]+\.[0-9]+\.tar\.gz$/ { print $2 }' "$FETCHED/SHA256SUMS" | head -n 1)"
  [[ -n "$name" ]] || fail "The release has no server archive."
  version="${name#cc-desk-tunnel-server-}"; version="${version%.tar.gz}"
  # Nothing newer, or the version asked for is here already. This is also how a manage.sh from before the images hands
  # over: it unpacks the archive it was given and runs this one without saying so.
  current="$(version_of)"
  if [[ "$version" = "$current" || ( -z "${CC_DESK_TUNNEL_VERSION:-}" && -n "$current" \
    && "$(printf '%s\n' "$version" "$current" | sort -V | tail -n 1)" = "$current" ) ]]; then
    echo "已是最新版本 ${current}。"
    return
  fi
  # The version found is fetched by its own address, even if the newest release changes meanwhile.
  echo "下载 $name …"
  curl -fL --connect-timeout 20 --max-time 600 --progress-bar -o "$FETCHED/$name" \
    "$releases/download/v$version/$name" || fail "Download failed."
  (cd "$FETCHED" && grep "  $name\$" SHA256SUMS | sha256sum -c - >/dev/null) || fail "The archive does not match SHA256SUMS."
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
    || echo "Could not write $COMMAND_LINK; run $ROOT/deploy/manage.sh instead." >&2
}
running() { [[ -n "$(dc ps --status running -q proxy)" ]]; }
ask() {
  local prompt="$1" default="${2:-}" answer
  read -r -p "$prompt${default:+ [$default]}: " answer
  printf '%s' "${answer:-$default}"
}
# Everything the Windows client and the administrator need after an install or upgrade.
summary() {
  local id
  echo
  echo "================ CC Desk Tunnel 部署汇总 ================"
  echo "客户端填写"
  echo "  服务地址   $CONNECTION_URL"
  if [[ "$MODE" = fingerprint ]]; then
    echo "  证书指纹   $(openssl x509 -in "$DATA_DIR/tls/control.crt" -noout -fingerprint -sha256 | cut -d= -f2)"
  else
    echo "  证书指纹   留空（按 CA 与域名校验）"
  fi
  echo "  服务凭据   $(sed -n "s/^PROXY_TOKEN='\(.*\)'$/\1/p" "$DATA_DIR/config/service.env")"
  echo "服务器"
  echo "  入口模式   $MODE"
  echo "  需放行端口 $([[ "$MODE" = nginx ]] && echo "nginx 的 443/TCP" || echo "$CONTROL_PORT/TCP")"
  echo "  数据目录   $DATA_DIR"
  echo "  部署配置   $CONFIG"
  id="$(dc ps -q proxy 2>/dev/null || true)"
  echo "  容器状态   $([[ -n "$id" ]] && docker inspect --format '{{.State.Health.Status}}' "$id" || echo 未启动)"
  echo "下一步"
  echo "  1. 云防火墙只放行上面“需放行端口”一项；本项目不需要其他入站端口。"
  echo "  2. Windows 客户端填入服务地址、指纹和凭据并连接。"
  echo "  3. 在客户端账号页登录 Claude 账号。"
  echo "  使用第三方 API 时编辑 $DATA_DIR/config/provider.json 后执行 sudo $(self) restart。"
  echo "  日常管理：sudo $(self) status | logs | upgrade | help"
  echo "以上凭据等同于服务器登录权限，请勿外传。"
  echo "======================================================="
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
      echo "已有部署配置（${CONFIG}），跳过问答，准备镜像并启动。"
    else
      [[ -t 0 ]] || fail "setup needs an interactive terminal; use init with options in scripts."
      echo "CC Desk Tunnel 首次安装。直接回车使用方括号内的默认值。"
      detected="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
      [[ "$detected" =~ ^[0-9.]+$ ]] || detected="$(hostname -I 2>/dev/null | awk '{print $1}')"
      # Each answer is checked as it is given and asked again, not after all the questions.
      while :; do
        host="$(host_of "$(ask "Windows 能访问到的公网 IP 或域名" "$detected")")"
        valid_host "$host" && break
        echo "“${host}”不是 IPv4 地址或域名：只填地址本身，不带 https://、端口和路径；中文域名填 xn-- 开头的形式；暂不支持 IPv6。" >&2
      done
      echo "入口方式：1) 自签证书 + 指纹（无域名时用）  2) 已有域名证书  3) 已有 nginx 反代"
      while :; do
        case "$(ask "选择 1 / 2 / 3" 1)" in
          1) mode=fingerprint ;; 2) mode=certificate ;; 3) mode=nginx ;; *) echo "请输入 1、2 或 3。" >&2; continue ;;
        esac
        break
      done
      options=(--host "$host" --mode "$mode")
      if [[ "$mode" = certificate ]]; then
        while :; do
          cert="$(ask "证书链文件 fullchain.pem 的路径")"
          key="$(ask "私钥文件 privkey.pem 的路径")"
          (cert_pair "$cert" "$key" && cert_name "$cert" "$host") && break
          echo "请重新填写证书和私钥。" >&2
        done
        options+=(--cert "$cert" --key "$key")
      fi
      if [[ "$mode" = nginx ]]; then
        while :; do
          url="$(ask "客户端使用的 WSS 地址" "wss://$host/ws")"
          [[ "$url" =~ ^wss://[^/@?#]+/ws$ ]] && break
          echo "WSS 地址应写成 wss://域名/ws。" >&2
        done
        options+=(--url "$url")
      fi
      while :; do
        port="$(ask "控制端口" 8787)"
        valid_port "$port" && break
        echo "端口应在 1024 到 65535 之间。" >&2
      done
      options+=(--control-port "$port")
      default_data="${HOME}/.local/share/cc-desk-tunnel-container"
      [[ "$(id -u)" != 0 ]] || default_data=/srv/cc-desk-tunnel
      while :; do
        data="$(ask "数据目录（新建，存放账号、会话与证书）" "$default_data")"
        [[ "$data" = /* && "$data" != / && "$(realpath -m -- "$data")" != "$(realpath -- "$HOME")" ]] && safe_value "$data" \
          || { echo "请填写一个专用的绝对路径，例如 $default_data。" >&2; continue; }
        [[ ! -e "$data" ]] && break
        echo "$data 已存在。数据目录必须是新的，以免覆盖已有内容；换一个路径。" >&2
      done
      options+=(--data "$data")
      while :; do
        token="$(ask "服务凭据（至少 24 位；留空自动生成）")"
        [[ -z "$token" || "$token" =~ ^[A-Za-z0-9._~+/=-]{24,512}$ ]] && break
        echo "凭据需要 24 到 512 位，只用字母、数字和 . _ ~ + / = -。" >&2
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
      [[ $# -ge 2 ]] || fail "Missing value for $1"
      case "$1" in
        --host) HOST="$2" ;; --mode) MODE="$2" ;; --data) DATA_DIR="$2" ;;
        --control-port) CONTROL_PORT="$2" ;;
        # Given by scripts written for 0.2.9 and earlier, when the execution channel had a port of its own.
        --frps-port) ;;
        --cert) CERT="$2" ;; --key) KEY="$2" ;; --url) URL="$2" ;; --token) TOKEN="$2" ;;
        *) fail "Unknown option: $1" ;;
      esac
      shift 2
    done
    valid_host "$HOST" || fail "--host needs an IPv4 address or DNS name reachable by Windows (no IPv6 yet)."
    [[ "$MODE" =~ ^(fingerprint|certificate|nginx)$ ]] || fail "Invalid mode."
    valid_port "$CONTROL_PORT" || fail "The port must be 1024..65535."
    [[ "$DATA_DIR" = /* && "$DATA_DIR" != / && "$DATA_DIR" != "$HOME" ]] || fail "Choose an absolute dedicated data directory."
    DATA_DIR="$(realpath -m -- "$DATA_DIR")"
    [[ "$DATA_DIR" != / && "$DATA_DIR" != "$(realpath -- "$HOME")" ]] || fail "Choose a dedicated data directory."
    [[ ! -e "$CONFIG" ]] || fail "Configuration already exists; use upgrade or a separate PROXY_DEPLOY_CONFIG."
    safe_value "$DATA_DIR" || fail "Unsupported data path."
    [[ "$(id -u)" = 0 || "$(id -u)" = 1000 ]] || fail "Run init with sudo; container data needs uid 1000 ownership."
    [[ ! -e "$DATA_DIR" ]] || fail "Data directory already exists; do not overwrite it."
    command -v docker >/dev/null && docker compose version >/dev/null || fail "Install Docker Engine and Compose first."
    command -v openssl >/dev/null || fail "Install OpenSSL first."
    if [[ "$MODE" = certificate ]]; then
      [[ -n "$CERT" && -n "$KEY" ]] || fail "--cert and --key required."
      cert_pair "$CERT" "$KEY"
      cert_name "$CERT" "$HOST"
    fi
    CONTROL_BIND=0.0.0.0
    [[ "$MODE" != nginx ]] || CONTROL_BIND=127.0.0.1
    URL="${URL:-wss://$HOST:$CONTROL_PORT/ws}"
    if [[ "$MODE" = nginx && "$URL" = "wss://$HOST:$CONTROL_PORT/ws" ]]; then URL="wss://$HOST/ws"; fi
    [[ "$URL" =~ ^wss://[^/@?#]+/ws$ ]] || fail "--url must be a WSS /ws address."
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
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{24,512}$ ]] || fail "--token needs 24..512 characters from A-Z a-z 0-9 . _ ~ + / = -"
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
    } > "$CONFIG"
    if [[ "$(id -u)" = 0 ]]; then
      chown -R 1000:1000 "$DATA_DIR"
    fi
    link_command
    echo "Initialized. Edit $DATA_DIR/config/provider.json for API settings, then up."
    echo "Private client connection information: manage.sh connection"
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
      [[ $# = 2 && -f "$2" ]] || fail "Specify the server archive: upgrade --from /path/cc-desk-tunnel-server.tar.gz"
      ARCHIVE="$2"
    else
      [[ $# = 0 ]] || fail "upgrade takes no arguments besides --from SERVER_ARCHIVE."
      [[ -n "${CC_DESK_TUNNEL_UNPACKED:-}" || -d "$ROOT/.git" ]] || fetch_release
    fi
    if [[ -n "${ARCHIVE:-}" ]]; then
      if tar -tzf "$ARCHIVE" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then fail "Unsafe archive paths."; fi
      tar -tzf "$ARCHIVE" | grep -Fx 'deploy/manage.sh' >/dev/null || fail "Not a CC Desk Tunnel server archive."
      tar -xzf "$ARCHIVE" -C "$ROOT" --no-same-owner
      # The script just unpacked goes on, so that what this version changed in it applies.
      CC_DESK_TUNNEL_UNPACKED=1 bash "$ROOT/deploy/manage.sh" upgrade
      exit
    fi
    echo "程序版本 $(version_of)。"
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
      echo "已删除替换下来的镜像 ${previous}。"
    fi
    summary ;;
  summary) summary ;;
  client)
    [[ $# = 1 && -f "$1" && "$(basename -- "$1")" =~ ^CC-Desk-Tunnel-Setup-[0-9]+\.[0-9]+\.[0-9]+-x64\.exe$ ]] \
      || fail "Specify the installer as built: CC-Desk-Tunnel-Setup-X.Y.Z-x64.exe"
    mkdir -p "$DATA_DIR/state/client"
    install -m 644 "$1" "$DATA_DIR/state/client/"
    [[ "$(id -u)" != 0 ]] || chown -R 1000:1000 "$DATA_DIR/state/client"
    echo "Installer published. Clients see the upgrade the next time they connect."
    ;;
  token)
    # Every saved client login stops working; the summary prints the new token.
    [[ $# -le 1 ]] || fail "Specify at most one token."
    TOKEN="${1:-$(openssl rand -hex 32)}"
    [[ "$TOKEN" =~ ^[A-Za-z0-9._~+/=-]{24,512}$ ]] || fail "The token needs 24..512 characters from A-Z a-z 0-9 . _ ~ + / = -"
    temp="$(mktemp "$DATA_DIR/config/service.env.XXXXXX")"
    { grep -v '^PROXY_TOKEN=' "$DATA_DIR/config/service.env"; write_var PROXY_TOKEN "$TOKEN"; } > "$temp"
    chmod 600 "$temp"
    [[ "$(id -u)" != 0 ]] || chown 1000:1000 "$temp"
    mv -- "$temp" "$DATA_DIR/config/service.env"
    if running; then dc restart; wait_healthy; fi
    summary ;;
  release-token)
    # Read-only access to the releases of a private repository; without an argument the token is removed.
    [[ $# -le 1 ]] || fail "Specify at most one token file."
    RELEASE_TOKEN=""
    if [[ $# = 1 ]]; then
      [[ -f "$1" ]] || fail "Specify the file holding the token."
      RELEASE_TOKEN="$(tr -d '[:space:]' < "$1")"
      [[ "$RELEASE_TOKEN" =~ ^[A-Za-z0-9_]{20,255}$ ]] || fail "That file does not hold a GitHub token."
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
    echo "Release token $([[ -n "$RELEASE_TOKEN" ]] && echo saved || echo removed)."
    ;;
  uninstall)
    dc down --remove-orphans
    if grep -qF "'$ROOT/deploy/manage.sh'" "$COMMAND_LINK" 2>/dev/null; then rm -f -- "$COMMAND_LINK"; fi
    echo "Removed containers/network. Data and config retained: $DATA_DIR" ;;
  connection)
    echo "URL: $CONNECTION_URL"
    if [[ "$MODE" = fingerprint ]]; then
      openssl x509 -in "$DATA_DIR/tls/control.crt" -noout -fingerprint -sha256
    else
      echo "Certificate fingerprint: leave empty for standard CA/domain verification."
    fi
    grep '^PROXY_TOKEN=' "$DATA_DIR/config/service.env"
    ;;
  backup)
    # A directory, or nothing for the current one, gets a file named for this machine and the moment.
    [[ $# -le 1 ]] || fail "Specify at most one file or directory."
    archive="${1:-.}"
    [[ ! -d "$archive" ]] || archive="$archive/$(backup_name)"
    archive="$(realpath -m -- "$archive")"
    [[ ! -e "$archive" ]] || fail "$archive already exists."
    [[ -d "$(dirname -- "$archive")" ]] || fail "No directory $(dirname -- "$archive")."
    [[ "$archive" != "$DATA_DIR/"* ]] || fail "Backup must be outside the data directory."
    was_running=false; running && was_running=true
    trap 'if $was_running; then dc start >/dev/null; fi' EXIT
    echo "备份期间服务暂停，数据多时需要几分钟…"
    dc stop
    make_backup "$archive" || fail "Backup failed; nothing was saved."
    echo "备份完成：$archive（$(du -h -- "$archive" | cut -f1)）"
    echo "内含 Claude 账号登录、服务凭据、证书、设置和全部会话与工作目录，请像密码一样保管。"
    echo "迁移到另一台服务器：在那里安装好，把这个文件拷过去，执行 sudo $(self) restore 文件路径。"
    ;;
  restore)
    yes=false archive=''
    for argument; do
      case "$argument" in
        --yes|-y) yes=true ;;
        *) [[ -z "$archive" ]] || fail "Specify one backup."; archive="$argument" ;;
      esac
    done
    [[ -n "$archive" && -f "$archive" ]] || fail "Specify the backup file: restore /path/cc-desk-tunnel-backup-….tar.gz"
    archive="$(realpath -- "$archive")"
    [[ "$archive" != "$DATA_DIR/"* ]] || fail "Move the backup out of the data directory first; restoring replaces it."
    listing="$(mktemp)"
    trap 'rm -f -- "$listing"' EXIT
    echo "检查备份文件…"
    tar -tzf "$archive" > "$listing" 2>/dev/null || fail "Cannot read $archive as a .tar.gz archive."
    grep -Fxq './.cc-desk-tunnel-data' "$listing" && grep -Fxq './config/service.env' "$listing" \
      || fail "Not a CC Desk Tunnel backup."
    if grep -E '(^/|(^|/)\.\.(/|$))' "$listing" >/dev/null; then fail "Unsafe archive paths."; fi
    # Data written by a newer version may not be readable by this one; migrations only go forward.
    note="$(tar -xzOf "$archive" "$NOTE" 2>/dev/null || true)"
    from="$(sed -n 's/^version=//p' <<< "$note")" current="$(version_of)"
    if [[ -n "$from" && -n "$current" && "$from" != "$current" \
      && "$(printf '%s\n' "$from" "$current" | sort -V | tail -n 1)" = "$from" ]]; then
      fail "这份备份来自 $from 版，比这里的 $current 新。先执行 sudo $(self) upgrade 升级，再还原。"
    fi
    source_text="（早期版本做的备份，没有记录来源）"
    if [[ -n "$note" ]]; then
      source_text="主机 $(sed -n 's/^host=//p' <<< "$note") · 版本 ${from:-未知} · $(sed -n 's/^created=//p' <<< "$note")"
    fi
    safety="$(dirname -- "$archive")/$(backup_name -before-restore)"
    red='' plain=''
    if [[ -t 1 ]]; then red=$'\e[1;31m' plain=$'\e[0m'; fi
    cat <<NOTICE

${red}================ 还原备份：覆盖这台服务器上的现有数据 ================${plain}
  备份文件   $archive（$(du -h -- "$archive" | cut -f1)）
  备份来源   $source_text
  覆盖目标   $DATA_DIR（现占用 $(du -sh -- "$DATA_DIR" 2>/dev/null | cut -f1)）

  还原会用备份替换这里的全部会话和工作目录、Claude 账号登录、服务凭据和设置，
  ${red}现有的这些内容都会被覆盖。${plain}覆盖之前，现有数据先另存为
    $safety
  这台服务器的访问地址、端口和入口方式不变。服务暂停，还原后自动启动。
${red}======================================================================${plain}

NOTICE
    if ! $yes; then
      [[ -t 0 ]] || fail "No terminal to confirm on; add --yes to restore without asking."
      read -r -p "确认覆盖请输入 yes（其他输入都会取消）: " answer
      [[ "$answer" = yes ]] || { echo "已取消，没有改动。"; exit 0; }
    fi
    was_running=false; running && was_running=true
    dc stop
    echo "另存现有数据…"
    if ! make_backup "$safety"; then
      if $was_running; then dc start >/dev/null; fi
      fail "Could not save the current data; nothing was restored."
    fi
    echo "还原…"
    # Unpacked beside the data, on the same disk even when the data directory is a mount of its own, then put in
    # place by renaming.
    stage="$DATA_DIR/.restore" old="$DATA_DIR/.replaced"
    rm -rf -- "$stage" "$old"
    mkdir -- "$stage" "$old"
    if ! tar -xzf "$archive" -C "$stage" --no-same-owner; then
      rm -rf -- "$stage" "$old"
      if $was_running; then dc start >/dev/null; fi
      fail "Could not unpack the backup; the data is as it was."
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
    echo "已还原。还原前的数据另存在 $safety，确认无误后可以删除。"
    docker image inspect "$PROXY_IMAGE" >/dev/null 2>&1 || prepare_image
    dc up -d --no-build; wait_healthy
    summary
    ;;
  certificate|renew)
    [[ "$MODE" != nginx ]] || fail "nginx owns and renews the frontend certificate; reload nginx there."
    temp="$(mktemp -d)"
    trap 'rm -rf -- "$temp"' EXIT
    if [[ "$command" = renew ]]; then
      [[ "$MODE" = fingerprint ]] || fail "Use certificate FULLCHAIN KEY for CA certificates."
      make_cert cc-desk-tunnel.local "$temp/control" 365 FALSE
    else
      [[ $# = 2 ]] || fail "Specify certificate and key."
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
    echo "Frontend certificate replaced. Fingerprint mode clients must update their pin."
    ;;
  *) usage; fail "Unknown command: $command" ;;
esac
