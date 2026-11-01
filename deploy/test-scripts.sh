#!/usr/bin/env bash
# The decisions of the deployment scripts, against stand-ins for Docker, GitHub and the host: which image is used,
# what a failure leaves behind, how a release is fetched and unpacked. No Docker, network or root needed.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
export MOCK_LOG="$TEMP/docker.log" MOCK_RELEASE="$TEMP/release" CC_DESK_TUNNEL_COMMAND="$TEMP/bin/cc-desk-tunnel"
export PATH="$TEMP/bin:$PATH"
mkdir -p "$TEMP/bin" "$MOCK_RELEASE"

# A program directory as a release archive unpacks it, at a version of our choosing.
program() {
  mkdir -p "$1/deploy/docker" "$1/apps/desktop"
  for file in manage.sh install.sh; do tr -d '\r' < "$ROOT/deploy/$file" > "$1/deploy/$file"; done
  cp "$ROOT/deploy/compose.yml" "$1/deploy/"
  cp "$ROOT/deploy/docker/compose.yaml" "$1/deploy/docker/"
  printf '{\n  "version": "%s",\n}\n' "$2" > "$1/apps/desktop/package.json"
}
# The release on the stand-in GitHub: its archive and SHA256SUMS.
release() {
  rm -rf "$TEMP/archive" "$MOCK_RELEASE"/*
  program "$TEMP/archive" "$1"
  tar -czf "$MOCK_RELEASE/cc-desk-tunnel-server-$1.tar.gz" -C "$TEMP/archive" deploy apps
  (cd "$MOCK_RELEASE" && sha256sum "cc-desk-tunnel-server-$1.tar.gz" > SHA256SUMS)
}
cat > "$TEMP/bin/docker" <<'MOCK'
#!/usr/bin/env bash
echo "$*" >> "$MOCK_LOG"
case "$1 $2" in
  'pull '*) [[ "${FAIL_PULL:-0}" != 1 ]]; exit ;;
  'image inspect')
    [[ "${MISSING_IMAGE:-0}" != 1 ]] || exit 1
    [[ "$*" != *'{{.Id}}'* ]] || echo "sha256:${*: -1}"
    exit ;;
  'image rm') exit 0 ;;
  'inspect '*) echo healthy; exit ;;
esac
case " $* " in
  *' build '*) [[ "${FAIL_BUILD:-0}" != 1 ]]; exit ;;
  *' ps '*) echo mock-container ;;
esac
exit 0
MOCK
cat > "$TEMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
output='' url=''
while (($#)); do
  case "$1" in -o) output="$2"; shift ;; https://*) url="$1" ;; esac
  shift
done
file="$MOCK_RELEASE/${url##*/}"
[[ "$url" == https://github.com/sun168567/cc-desk-tunnel/releases/* && -f "$file" ]] || exit 22
version="$(ls "$MOCK_RELEASE" | sed -n 's/^cc-desk-tunnel-server-\(.*\)\.tar\.gz$/\1/p')"
[[ "$url" == */latest/download/* || "$url" == */download/v$version/* ]] || exit 22
if [[ -n "$output" ]]; then cp "$file" "$output"; else cat "$file"; fi
MOCK
chmod +x "$TEMP/bin/"*

DEPLOYED="$TEMP/deployed"
export PROXY_DEPLOY_CONFIG="$TEMP/config.env"
mkdir -p "$TEMP/data/config"
touch "$TEMP/data/.cc-desk-tunnel-data" "$TEMP/data/config/service.env"
deployment() {
  rm -rf "$DEPLOYED"
  program "$DEPLOYED" "$1"
  cat > "$PROXY_DEPLOY_CONFIG" <<CONFIG
PROJECT_NAME='fixture'
DATA_DIR='$TEMP/data'
PROXY_IMAGE='${2:-cc-desk-tunnel:local}'
MODE='nginx'
CONNECTION_URL='wss://fixture/ws'
CONTROL_PORT='8787'
CONTROL_BIND='127.0.0.1'
CONFIG
  : > "$MOCK_LOG"
}
manage() { bash "$DEPLOYED/deploy/manage.sh" "$@"; }
image() { sed -n "s/^PROXY_IMAGE='\(.*\)'$/\1/p" "$PROXY_DEPLOY_CONFIG"; }

# The prebuilt image of the program's own version.
deployment 1.2.3
manage pull
test "$(image)" = ghcr.io/sun168567/cc-desk-tunnel:1.2.3
! grep -q ' build ' "$MOCK_LOG"
! grep -q ' up ' "$MOCK_LOG"
# No image to pull: built here, and only then configured.
deployment 1.2.3
FAIL_PULL=1 CC_DESK_TUNNEL_UNPACKED=1 manage upgrade > /dev/null
test "$(image)" = cc-desk-tunnel:local
grep -q ' build --pull' "$MOCK_LOG"
grep -q ' up -d --no-build' "$MOCK_LOG"
# Neither: the deployment stays as it was and nothing restarts.
for failure in 'FAIL_PULL=1 FAIL_BUILD=1' 'FAIL_PULL=1 CC_DESK_TUNNEL_BUILD=0'; do
  deployment 1.2.3 old:1
  if env $failure CC_DESK_TUNNEL_UNPACKED=1 bash "$DEPLOYED/deploy/manage.sh" upgrade > /dev/null 2>&1; then
    echo "Upgrade went on with no image ($failure)." >&2; exit 1
  fi
  test "$(image)" = old:1
  ! grep -q ' up ' "$MOCK_LOG"
done
# Asked to build: no pull.
deployment 1.2.3
CC_DESK_TUNNEL_BUILD=1 CC_DESK_TUNNEL_UNPACKED=1 manage upgrade > /dev/null
! grep -q '^pull ' "$MOCK_LOG"
# up gets the image first when there is none yet, as after init.
deployment 1.2.3
MISSING_IMAGE=1 manage up
grep -q '^pull ghcr.io/sun168567/cc-desk-tunnel:1.2.3' "$MOCK_LOG"

# upgrade fetches the newest release, checks it, unpacks it and goes on with the script it brought. The image it
# replaces goes; one of the administrator's own stays.
release 1.3.0
deployment 1.2.3 ghcr.io/sun168567/cc-desk-tunnel:1.2.3
manage upgrade > "$TEMP/upgrade.log"
grep -q '"version": "1.3.0"' "$DEPLOYED/apps/desktop/package.json"
test "$(image)" = ghcr.io/sun168567/cc-desk-tunnel:1.3.0
grep -q '^image rm ghcr.io/sun168567/cc-desk-tunnel:1.2.3' "$MOCK_LOG"
deployment 1.2.3 my-own:1
manage upgrade > /dev/null
! grep -q '^image rm' "$MOCK_LOG"
# Nothing newer: nothing is fetched, and the image of the version here is used again. The same without GitHub.
release 1.2.3
deployment 1.2.3 old:1
manage upgrade > /dev/null
test "$(image)" = ghcr.io/sun168567/cc-desk-tunnel:1.2.3
release 1.2.0
deployment 1.2.3 old:1
manage upgrade > /dev/null
grep -q '"version": "1.2.3"' "$DEPLOYED/apps/desktop/package.json"
rm -f "$MOCK_RELEASE"/*
deployment 1.2.3 old:1
manage upgrade > /dev/null
test "$(image)" = ghcr.io/sun168567/cc-desk-tunnel:1.2.3
# A version asked for, and one that does not exist.
release 1.2.9
deployment 1.2.3
CC_DESK_TUNNEL_VERSION=1.2.9 manage upgrade > /dev/null
test "$(image)" = ghcr.io/sun168567/cc-desk-tunnel:1.2.9
deployment 1.2.3 old:1
if CC_DESK_TUNNEL_VERSION=9.9.9 manage upgrade > /dev/null 2>&1; then echo 'A missing version was accepted.' >&2; exit 1; fi
if CC_DESK_TUNNEL_VERSION=latest manage upgrade > /dev/null 2>&1; then echo 'A malformed version was accepted.' >&2; exit 1; fi
test "$(image)" = old:1
test ! -s "$MOCK_LOG"
# An archive that does not match SHA256SUMS is not unpacked.
release 1.3.0
echo tampered >> "$MOCK_RELEASE/cc-desk-tunnel-server-1.3.0.tar.gz"
deployment 1.2.3 old:1
if manage upgrade > /dev/null 2>&1; then echo 'A tampered archive was accepted.' >&2; exit 1; fi
grep -q '"version": "1.2.3"' "$DEPLOYED/apps/desktop/package.json"

# The one-line installer, as root on Linux: a first install, then the command it leaves, then an upgrade.
if [[ "$(uname -s)" != Linux ]]; then
  echo 'PASS: image choice, failures, release upgrade. SKIP: the installer, which needs Linux.'
  exit 0
fi
for tool in id chown uname openssl; do
  case "$tool" in
    id) body='echo 0' ;;
    chown) body='exit 0' ;;
    uname) body='if [[ "$1" = -s ]]; then echo Linux; else echo x86_64; fi' ;;
    openssl) body='printf "%064d\n" 0' ;;
  esac
  printf '#!/usr/bin/env bash\n%s\n' "$body" > "$TEMP/bin/$tool"
  chmod +x "$TEMP/bin/$tool"
done
unset PROXY_DEPLOY_CONFIG
export CC_DESK_TUNNEL_DIR="$TEMP/installed"
release 1.3.0
: > "$MOCK_LOG"
tr -d '\r' < "$ROOT/deploy/install.sh" > "$TEMP/install.sh"
printf 'y\n' | bash "$TEMP/install.sh" init --host 127.0.0.1 --mode nginx --data "$TEMP/installed-data" > "$TEMP/install.log"
grep -q '"version": "1.3.0"' "$TEMP/installed/apps/desktop/package.json"
test -f "$TEMP/installed/.local/docker.env"
grep -q "deploy/manage.sh" "$CC_DESK_TUNNEL_COMMAND"
MISSING_IMAGE=1 bash "$CC_DESK_TUNNEL_COMMAND" up > /dev/null
grep -q "PROXY_IMAGE='ghcr.io/sun168567/cc-desk-tunnel:1.3.0'" "$TEMP/installed/.local/docker.env"
release 1.4.0
: > "$MOCK_LOG"
printf 'y\n' | bash "$TEMP/install.sh" > "$TEMP/reinstall.log"
grep -q "PROXY_IMAGE='ghcr.io/sun168567/cc-desk-tunnel:1.4.0'" "$TEMP/installed/.local/docker.env"
test "$(grep -c '^pull ' "$MOCK_LOG")" = 1
bash "$CC_DESK_TUNNEL_COMMAND" uninstall > /dev/null
test ! -e "$CC_DESK_TUNNEL_COMMAND"
echo 'PASS: image choice, failures, release upgrade, installer, management command.'
