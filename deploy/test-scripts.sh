#!/usr/bin/env bash
# Exercise deployment decisions without Docker, credentials, or a remote machine.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
mkdir -p "$TEMP/repo/deploy/docker" "$TEMP/bin" "$TEMP/data/config"
for file in manage.sh install.sh; do tr -d '\r' < "$ROOT/deploy/$file" > "$TEMP/repo/deploy/$file"; done
cp "$ROOT/deploy/compose.yml" "$TEMP/repo/deploy/"
cp "$ROOT/deploy/docker/compose.yaml" "$TEMP/repo/deploy/docker/"
export PROXY_DEPLOY_CONFIG="$TEMP/config.env" MOCK_LOG="$TEMP/docker.log"
export PATH="$TEMP/bin:$PATH"
touch "$TEMP/data/.cc-desk-tunnel-data"
touch "$TEMP/data/config/service.env"
cat > "$TEMP/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$MOCK_LOG"
if [[ "$1" = pull ]]; then [[ "${FAIL_PULL:-0}" != 1 ]]; exit; fi
if [[ "$1" = inspect ]]; then echo healthy; exit; fi
case " $* " in
  *' build '*) [[ "${FAIL_BUILD:-0}" != 1 ]]; exit ;;
  *' ps '*) echo mock-container ;;
esac
exit 0
SH
cat > "$TEMP/bin/curl" <<'SH'
#!/usr/bin/env bash
[[ "${MOCK_CURL_FAIL:-0}" != 1 ]] || exit 1
output=''
url=''
while (($#)); do
  case "$1" in
    -o) output="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
if [[ -n "$output" ]]; then exec > "$output"; fi
case "$url" in
  */commits/*) echo '{"sha":"1111111111111111111111111111111111111111","nested":{"sha":"2222222222222222222222222222222222222222"}}'; exit ;;
  */1111111111111111111111111111111111111111/deploy/manage.sh) cat "$MOCK_SOURCE/manage.sh"; exit ;;
  */1111111111111111111111111111111111111111/deploy/compose.yml) cat "$MOCK_SOURCE/compose.yml"; exit ;;
esac
[[ "$url" == */SHA256SUMS ]] || exit 1
printf '%064d  cc-desk-tunnel-server-1.2.3.tar.gz\n' 0
SH
chmod +x "$TEMP/bin/"*
reset_config() {
  cat > "$PROXY_DEPLOY_CONFIG" <<SH
PROJECT_NAME='fixture'
DATA_DIR='$TEMP/data'
PROXY_IMAGE='old:1.0.0'
MODE='nginx'
CONNECTION_URL='wss://fixture/ws'
CONTROL_PORT='8787'
CONTROL_BIND='127.0.0.1'
SH
  : > "$MOCK_LOG"
}
manage() { bash "$TEMP/repo/deploy/manage.sh" "$@"; }
reset_config
cp "$PROXY_DEPLOY_CONFIG" "$TEMP/before"
if FAIL_PULL=1 manage upgrade > "$TEMP/failure.log" 2>&1; then echo 'Failed pull accepted'; exit 1; fi
cmp "$PROXY_DEPLOY_CONFIG" "$TEMP/before"
! grep -q ' up ' "$MOCK_LOG"
reset_config
CC_DESK_TUNNEL_VERSION=1.2.3 manage upgrade > "$TEMP/success.log"
grep -q "PROXY_IMAGE='ghcr.io/sun168567/cc-desk-tunnel:1.2.3'" "$PROXY_DEPLOY_CONFIG"
grep -q ' up -d --no-build' "$MOCK_LOG"
! grep -q ' build ' "$MOCK_LOG"
reset_config
manage pull
grep -q 'pull ghcr.io/sun168567/cc-desk-tunnel:1.2.3' "$MOCK_LOG"
! grep -q ' up ' "$MOCK_LOG"
reset_config
CC_DESK_TUNNEL_BUILD=1 manage upgrade > "$TEMP/source.log"
grep -q ' build --pull' "$MOCK_LOG"
grep -q "PROXY_IMAGE='cc-desk-tunnel:local'" "$PROXY_DEPLOY_CONFIG"
! grep -q '^pull ' "$MOCK_LOG"
reset_config
cp "$PROXY_DEPLOY_CONFIG" "$TEMP/before"
if FAIL_BUILD=1 CC_DESK_TUNNEL_BUILD=1 manage upgrade > "$TEMP/build-failure.log" 2>&1; then exit 1; fi
cmp "$PROXY_DEPLOY_CONFIG" "$TEMP/before"
! grep -q ' up ' "$MOCK_LOG"
reset_config
cp "$PROXY_DEPLOY_CONFIG" "$TEMP/before"
if CC_DESK_TUNNEL_VERSION=invalid manage pull > "$TEMP/invalid.log" 2>&1; then exit 1; fi
cmp "$PROXY_DEPLOY_CONFIG" "$TEMP/before"
test ! -s "$MOCK_LOG"
# The online entry point forwards maintenance arguments without fetching a release or changing directories.
mkdir -p "$TEMP/managed/deploy"
cat > "$TEMP/managed/deploy/manage.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$MOCK_DISPATCH"
SH
printf '#!/usr/bin/env bash\necho 0\n' > "$TEMP/bin/id"
chmod +x "$TEMP/bin/id"
cp "$TEMP/repo/deploy/install.sh" "$TEMP/bootstrap.sh"
export MOCK_DISPATCH="$TEMP/dispatch.args"
MOCK_CURL_FAIL=1 CC_DESK_TUNNEL_DIR="$TEMP/managed" bash "$TEMP/bootstrap.sh" token
test "$(cat "$MOCK_DISPATCH")" = token
MOCK_CURL_FAIL=1 CC_DESK_TUNNEL_DIR="$TEMP/managed" bash "$TEMP/bootstrap.sh" backup '/secure/with spaces/backup.tar.gz'
printf 'backup\n/secure/with spaces/backup.tar.gz\n' > "$TEMP/expected.args"
cmp "$MOCK_DISPATCH" "$TEMP/expected.args"
if CC_DESK_TUNNEL_DIR="$TEMP/missing" bash "$TEMP/bootstrap.sh" status > "$TEMP/missing.log" 2>&1; then exit 1; fi
if CC_DESK_TUNNEL_DIR="$TEMP/managed" bash "$TEMP/bootstrap.sh" unknown > "$TEMP/unknown.log" 2>&1; then exit 1; fi
test ! -s "$MOCK_LOG"
# Git Bash uses a different regex engine for the Linux installer's existing token validation.
if [[ "$(uname -s)" != Linux ]]; then
  echo 'PASS: pull/build selection, version pinning, failure retention and online management dispatch. SKIP: Linux bootstrap on this host.'
  exit 0
fi
# Bootstrap first installs only deployment tooling, then can upgrade that source-free directory.
for tool in id chown uname openssl; do
  case "$tool" in
    id) body='echo 0' ;;
    chown) body='exit 0' ;;
    uname) body='if [[ "$1" = -s ]]; then echo Linux; else echo x86_64; fi' ;;
    openssl) body='printf "%032d\n" 0' ;;
  esac
  printf '#!/usr/bin/env bash\n%s\n' "$body" > "$TEMP/bin/$tool"
  chmod +x "$TEMP/bin/$tool"
done
export MOCK_SOURCE="$TEMP/repo/deploy"
export CC_DESK_TUNNEL_DIR="$TEMP/installed"
unset PROXY_DEPLOY_CONFIG
cp "$TEMP/repo/deploy/install.sh" "$TEMP/bootstrap.sh"
printf 'y\n' | bash "$TEMP/bootstrap.sh" init --host 127.0.0.1 --mode nginx --data "$TEMP/bootstrap-data" > "$TEMP/bootstrap.log"
test -f "$TEMP/installed/deploy/manage.sh"
test ! -e "$TEMP/installed/apps"
test -f "$TEMP/installed/.local/docker.env"
printf 'y\n' | bash "$TEMP/bootstrap.sh" upgrade > "$TEMP/bootstrap-upgrade.log"
grep -q "PROXY_IMAGE='ghcr.io/sun168567/cc-desk-tunnel:1.2.3'" "$TEMP/installed/.local/docker.env"
echo 'PASS: default pull, explicit build, failure retention, version validation, source-free bootstrap and upgrade.'
