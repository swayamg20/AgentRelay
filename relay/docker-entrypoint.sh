#!/usr/bin/env sh
# Run drizzle migrations once (idempotent — the _journal tracks state),
# then exec the relay server. exec preserves PID 1 so tini's signal
# handling reaches the Node process.
#
# IMPORTANT: cd into /app/relay before running migrate.js. The migration
# code uses a relative `./drizzle` migrationsFolder path, which only
# resolves when cwd is the relay package root. (pnpm --filter relay
# handles this transparently in dev; in the container we do it manually.)

set -e

cd /app/relay

echo "[entrypoint] applying migrations…"
node dist/db/migrate.js

echo "[entrypoint] starting relay on :${RELAY_PORT:-8080}"
exec node dist/main.js
