#!/usr/bin/env sh
# Run drizzle migrations once (idempotent — the _journal tracks state),
# then exec the relay server. exec preserves PID 1 so tini's signal
# handling reaches the Node process.

set -e

echo "[entrypoint] applying migrations…"
node /app/relay/dist/db/migrate.js

echo "[entrypoint] starting relay on :${RELAY_PORT:-8080}"
exec node /app/relay/dist/main.js
