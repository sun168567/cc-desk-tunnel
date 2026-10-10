#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PROXY_TEST_IMAGE:-cc-desk-tunnel:local}"
HOST=127.0.0.1
TEMP="$(mktemp -d)"
export PROXY_DEPLOY_CONFIG="$TEMP/deploy.env"
manage() { bash "$ROOT/deploy/manage.sh" "$@"; }
cleanup() {
  for config in "$TEMP"/*.env; do
    [[ -f "$config" ]] || continue
    PROXY_DEPLOY_CONFIG="$config" bash "$ROOT/deploy/manage.sh" uninstall >/dev/null 2>&1 || true
  done
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
docker image inspect "$IMAGE" >/dev/null
for port in 19871 19873; do
  if ss -lnt | grep -E ":$port[[:space:]]" >/dev/null; then
    echo "Test port $port is occupied." >&2; exit 1
  fi
done
manage init --host "$HOST" --data "$TEMP/data" --control-port 19871
sed -i "s|cc-desk-tunnel:local|$IMAGE|" "$PROXY_DEPLOY_CONFIG"
if manage init --host "$HOST" 2>/dev/null; then echo "Duplicate init was accepted." >&2; exit 1; fi
if manage backup "$TEMP/data/backup.tar.gz" 2>/dev/null; then echo "Backup inside data was accepted." >&2; exit 1; fi
manage up
source "$PROXY_DEPLOY_CONFIG"
compose=(docker compose --env-file "$PROXY_DEPLOY_CONFIG" -p "$PROJECT_NAME" -f "$ROOT/deploy/docker/compose.yaml")
id="$("${compose[@]}" ps -q proxy)"
docker exec "$id" bash -c 'test "$(id -u)" = 1000; test ! -w /app/apps/server/src/main.ts; test ! -w /opt/runtime/cli/bin/claude; printf native-memory > /data/home/deploy-marker; printf workspace-memory > /data/workspace/deploy-marker; node --version; claude --version; python3 --version; git --version; command -v ssh g++ make jq rg'
curl --cacert "$TEMP/data/tls/control.crt" --resolve cc-desk-tunnel.local:19871:127.0.0.1 -fsS https://cc-desk-tunnel.local:19871/health
manage renew
manage backup "$TEMP/backup.tar.gz"
[[ "$(stat -c %a "$TEMP/backup.tar.gz")" = 600 ]]
if manage restore "$TEMP/backup.tar.gz" 2>/dev/null; then echo "Restore over existing data was accepted." >&2; exit 1; fi
manage stop
manage uninstall
[[ -f "$TEMP/data/home/deploy-marker" ]]

export PROXY_DEPLOY_CONFIG="$TEMP/restore.env"
manage init --host "$HOST" --data "$TEMP/restored" --control-port 19871
sed -i "s|cc-desk-tunnel:local|$IMAGE|" "$PROXY_DEPLOY_CONFIG"
manage restore "$TEMP/backup.tar.gz"
manage up
[[ "$(cat "$TEMP/restored/home/deploy-marker")" = native-memory ]]
[[ "$(cat "$TEMP/restored/workspace/deploy-marker")" = workspace-memory ]]
manage stop
manage uninstall

export PROXY_DEPLOY_CONFIG="$TEMP/nginx.env"
manage init --host "$HOST" --mode nginx --data "$TEMP/nginx" --control-port 19873
sed -i "s|cc-desk-tunnel:local|$IMAGE|" "$PROXY_DEPLOY_CONFIG"
manage up
source "$PROXY_DEPLOY_CONFIG"
id="$(docker compose --env-file "$PROXY_DEPLOY_CONFIG" -p "$PROJECT_NAME" -f "$ROOT/deploy/docker/compose.yaml" ps -q proxy)"
[[ "$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8787/tcp") 0).HostIp}}' "$id")" = 127.0.0.1 ]]
curl -fsS http://127.0.0.1:19873/health
manage stop
manage uninstall

openssl req -x509 -newkey rsa:2048 -nodes -days 3 -subj '/CN=deployment-test-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' -keyout "$TEMP/ca.key" -out "$TEMP/ca.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=deployment-test' \
  -keyout "$TEMP/cert.key" -out "$TEMP/cert.csr" >/dev/null 2>&1
printf 'subjectAltName=IP:%s\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n' "$HOST" > "$TEMP/extension"
openssl x509 -req -in "$TEMP/cert.csr" -CA "$TEMP/ca.crt" -CAkey "$TEMP/ca.key" -CAcreateserial \
  -days 2 -sha256 -extfile "$TEMP/extension" -out "$TEMP/cert.crt" >/dev/null 2>&1
export PROXY_DEPLOY_CONFIG="$TEMP/cert.env"
if manage init --host mismatch.example --mode certificate --cert "$TEMP/cert.crt" --key "$TEMP/cert.key" --data "$TEMP/bad" 2>/dev/null; then
  echo "Mismatched certificate hostname was accepted." >&2; exit 1
fi
manage init --host "$HOST" --mode certificate --cert "$TEMP/cert.crt" --key "$TEMP/cert.key" --data "$TEMP/cert" --control-port 19871
sed -i "s|cc-desk-tunnel:local|$IMAGE|" "$PROXY_DEPLOY_CONFIG"
manage up
curl --cacert "$TEMP/ca.crt" -fsS https://127.0.0.1:19871/health
manage certificate "$TEMP/cert.crt" "$TEMP/cert.key"
manage uninstall

export PROXY_DEPLOY_CONFIG="$TEMP/standalone.env"
manage init --host "$HOST" --data "$TEMP/standalone" --control-port 19871
sed -i "s|cc-desk-tunnel:local|$IMAGE|" "$PROXY_DEPLOY_CONFIG"
export PROXY_COMPOSE_FILE="$ROOT/deploy/compose.yml"
manage up
curl --cacert "$TEMP/standalone/tls/control.crt" --resolve cc-desk-tunnel.local:19871:127.0.0.1 -fsS https://cc-desk-tunnel.local:19871/health
manage backup "$TEMP/standalone-backup.tar.gz"
manage uninstall
unset PROXY_COMPOSE_FILE
echo "PASS: direct TLS, certificate hostname, renewal, nginx loopback, private writable data, backup/restore, lifecycle."
