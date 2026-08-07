#!/usr/bin/env bash

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: ./infra/azure/smoke.sh https://your-relay-host

Checks the Relay process and its database-backed readiness endpoint. This does not
replace the two-machine invite, send, restart, receive, and reply pilot described in
docs/deploy-azure.md.
EOF
}

fail() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

[[ $# -eq 1 ]] || {
	usage >&2
	exit 2
}

relay_url=${1%/}
[[ "$relay_url" == https://* ]] || fail 'Relay URL must use HTTPS'
command -v curl >/dev/null 2>&1 || fail 'required command not found: curl'

health=$(curl --fail --silent --show-error --max-time 15 "$relay_url/healthz")
[[ "$health" == '{"status":"ok"}' ]] || fail "unexpected /healthz response: $health"
printf 'healthz: ok\n'

ready=$(curl --fail --silent --show-error --max-time 15 "$relay_url/readyz")
[[ "$ready" == '{"status":"ready"}' ]] || fail "unexpected /readyz response: $ready"
printf 'readyz: ready (database reachable)\n'

printf '\nRelay smoke check passed: %s\n' "$relay_url"
printf 'Next: complete the two-machine durability pilot in docs/deploy-azure.md.\n'
