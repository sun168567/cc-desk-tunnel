#!/usr/bin/env bash
# Synthetic old data, an old program overlay, and a real registry pull; no accounts or model calls.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${PROXY_TEST_IMAGE:-cc-desk-tunnel:local}"
TEMP="$(mktemp -d)"
export PROXY_DEPLOY_CONFIG="$TEMP/deploy.env"
registry="ccdt-registry-$$"
manage() { bash "$ROOT/deploy/manage.sh" "$@"; }
cleanup() {
  manage uninstall >/dev/null 2>&1 || true
  docker rm -f "$registry" >/dev/null 2>&1 || true
  rm -rf -- "$TEMP"
}
trap cleanup EXIT
version="$(docker run --rm --entrypoint node "$IMAGE" -p "require('/app/apps/desktop/package.json').version")"
docker run --rm --entrypoint bash "$IMAGE" -c '
  test ! -d /app/node_modules/electron
  test -z "$(find /app /opt/runtime -type f \( -name "CC-Desk-Tunnel-Setup-*.exe" -o -name "*.dmg" -o -name "*.deb" \) -print -quit)"
  test -s /app/apps/server/web/index.html
'
manage init --host 127.0.0.1 --mode nginx --data "$TEMP/data" --control-port 19874
seed_old_data() {
docker run --rm -i --entrypoint node -v "$TEMP/data:/data" "$IMAGE" --input-type=module <<'JS'
import { SessionStore } from '/app/apps/server/src/store.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const store = new SessionStore('/data/state');
const session = store.create(randomUUID(), 'upgrade fixture', 'D:\\fixture', { id: randomUUID(), name: 'fixture' });
const run = randomUUID(), message = randomUUID();
store.append(session.id, run, { type: 'text.delta', messageId: message, text: 'before-' });
store.append(session.id, run, { type: 'text.delta', messageId: message, text: 'upgrade' });
store.database.exec("DELETE FROM migrations WHERE name IN ('merged-fragments', 'updated-at-activity')");
store.close();
mkdirSync('/data/program/0.0.1/apps/server/src', { recursive: true });
writeFileSync('/data/program/current', '0.0.1\n');
writeFileSync('/data/program/0.0.1/apps/server/src/main.ts', 'throw new Error("Old overlay must not run")');
writeFileSync('/data/home/upgrade-marker', 'keep-account-data');
writeFileSync('/data/workspace/upgrade-marker', 'keep-workspace');
JS
}
sed -i "s|cc-desk-tunnel:local|$IMAGE|" "$PROXY_DEPLOY_CONFIG"
manage up
source "$PROXY_DEPLOY_CONFIG"
dc=(docker compose --env-file "$PROXY_DEPLOY_CONFIG" -p "$PROJECT_NAME" -f "$ROOT/deploy/compose.yml")
before="$("${dc[@]}" ps -q proxy)"
config_hash="$(sha256sum "$PROXY_DEPLOY_CONFIG")"
if CC_DESK_TUNNEL_IMAGE=127.0.0.1:1/missing CC_DESK_TUNNEL_VERSION="$version" manage upgrade >"$TEMP/failed-pull.log" 2>&1; then
  echo 'A failed pull was accepted.' >&2; exit 1
fi
test "$config_hash" = "$(sha256sum "$PROXY_DEPLOY_CONFIG")"
test "$before" = "$("${dc[@]}" ps -q proxy)"
manage stop
seed_old_data
# A temporary local registry exercises the same pull path without publishing a release.
docker run -d --name "$registry" -p 127.0.0.1::5000 registry:2 >/dev/null
port="$(docker port "$registry" 5000/tcp | cut -d: -f2)"
for attempt in {1..30}; do
  if curl -fsS "http://127.0.0.1:$port/v2/" >/dev/null; then break; fi
  sleep 1
done
remote="127.0.0.1:$port/cc-desk-tunnel"
docker tag "$IMAGE" "$remote:$version"
docker push "$remote:$version"
CC_DESK_TUNNEL_IMAGE="$remote" CC_DESK_TUNNEL_VERSION="$version" manage upgrade >"$TEMP/upgrade.log" 2>&1
after="$("${dc[@]}" ps -q proxy)"
test "$before" != "$after"
test "$(docker inspect --format '{{.Config.Image}}' "$after")" = "$remote:$version"
manage restart
docker exec -i "$after" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const db = new DatabaseSync('/data/state/sessions.sqlite', { readOnly: true });
const rows = db.prepare('SELECT data FROM events ORDER BY sequence').all();
const texts = rows.map(row => JSON.parse(row.data).payload).filter(p => p.type === 'text.delta');
assert.equal(texts.length, 1);
assert.equal(texts[0].text, 'before-upgrade');
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name IN ('merged-fragments','updated-at-activity')").get().n, 2);
db.close();
assert.equal(readFileSync('/data/home/upgrade-marker', 'utf8'), 'keep-account-data');
assert.equal(readFileSync('/data/workspace/upgrade-marker', 'utf8'), 'keep-workspace');
JS
curl -fsS http://127.0.0.1:19874/health
echo 'PASS: installer-free image, startup migration, stale program overlay, registry pull, failed pull, recreation and restart.'
