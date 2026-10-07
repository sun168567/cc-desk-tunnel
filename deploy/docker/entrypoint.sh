#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /data/home /data/state /data/workspace
if [ ! -r /data/config/service.env ] || [ ! -w /data/home ] || [ ! -w /data/state ]; then
  echo "Run manage.sh init first; data must be writable by container uid 1000." >&2
  exit 1
fi
[ "${1:-}" = server ] || exec "$@"

# The service runs the program in the image unless a newer one was installed into the data directory from the
# client. One that failed to start three times in a row is left aside.
PROGRAM=/app
STORE=/data/program
IMAGE_VERSION="$(node -p "require('/app/apps/desktop/package.json').version")"
VERSION="$(head -n 1 "$STORE/current" 2>/dev/null || true)"
if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -f "$STORE/$VERSION/apps/server/src/main.ts" \
  && "$VERSION" != "$IMAGE_VERSION" \
  && "$(printf '%s\n' "$IMAGE_VERSION" "$VERSION" | sort -V | tail -n 1)" = "$VERSION" ]]; then
  ATTEMPTS="$(cat "$STORE/attempts" 2>/dev/null || echo 0)"
  if [[ "$ATTEMPTS" =~ ^[0-2]$ ]]; then
    echo "$((ATTEMPTS + 1))" > "$STORE/attempts"
    PROGRAM="$STORE/$VERSION"
  else
    echo "Program $VERSION did not start; running $IMAGE_VERSION from the image." >&2
  fi
fi
[ ! -x "$PROGRAM/cli/bin/claude" ] || PATH="$PROGRAM/cli/bin:$PATH"
echo "Starting program $(node -p "require('$PROGRAM/apps/desktop/package.json').version") from $PROGRAM"
export PROXY_PROGRAM_DIR="$STORE" PROXY_RUNTIME_DIR=/opt/runtime
exec node --env-file=/data/config/service.env "$PROGRAM/apps/server/src/main.ts"
