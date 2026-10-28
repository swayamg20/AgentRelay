# Back up and restore a Compose Relay

This runbook covers the canonical self-host deployment started with
`docker compose --profile selfhost up -d` from
[`docker-compose.yml`](../docker-compose.yml). Every command uses that file's names:

| Item | Name |
| --- | --- |
| Postgres Compose service | `postgres` |
| Relay Compose service | `relay` |
| Database and database role | `agentrelay` |
| Docker volume | `postgres-data`, prefixed by Compose with the project name |

Run each command from the directory that contains `docker-compose.yml` and the
deployment's `.env`. `pg_dump`, `pg_restore`, and `psql` run inside the `postgres`
container, so the host needs no Postgres client and the tools match the server.

> [!WARNING]
> A restore drops and recreates the `agentrelay` database. Every Relay write made after
> the dump is discarded. Rehearse the complete sequence on a disposable development
> deployment, with throwaway secrets and test data, before running it against a Relay
> that matters. Never test a restore against a production database.

## What to protect

Recovery needs both the database and the Relay's stable secrets. A dump restored
without the matching secrets brings back rows that no existing credential can use.

| State | Where it lives | Covered here |
| --- | --- | --- |
| Relay database | `agentrelay` database in the `postgres` service, stored in the `postgres-data` volume | Yes: dump, validate, store, and restore |
| Relay secrets | `.env` beside `docker-compose.yml`, kept in your secret manager | Yes: what to preserve and what breaks |
| Developer-local state | Each developer's `~/.agentrelay` (raw API key, trust policy, watcher state) and the experimental Node's workspace mappings and journals | No |

The Relay stores only a peppered hash of each API key. The raw key exists only in the
developer's `~/.agentrelay/config.json`, so a database dump cannot replace a lost
developer configuration.

## Preserve the stable secrets

Keep the deployment's `.env` values in a secret manager, separately from database
dumps, and put the same values back before starting a restored Relay. Generate new
values only as described in [`hosting.md`](hosting.md). The effects below were observed
by changing one value at a time on a restored disposable deployment.

| Variable | Used for | If it is lost or changed |
| --- | --- | --- |
| `RELAY_PEPPER` | Hashing agent API keys and Node credentials | Every existing API key is rejected as `unauthenticated` with "Invalid or revoked API key", and `agentrelay doctor` reports `api key valid:    FAIL`. Node credentials are hashed with the same pepper. The rows stay intact and `/readyz` still reports ready. Credentials cannot be recovered under a new pepper; each one must be reissued. |
| `RELAY_ENCRYPTION_KEY` | Encrypting stored Slack webhook URLs | Sends and reads keep working, but a notification for an owner with a stored webhook fails to decrypt, logs `notify.decrypt_failed`, and is skipped. Each owner must submit the webhook URL again through `PUT /agents/me/card`. |
| `RELAY_INVITE_SECRET` | Signing invite URLs | Invites minted before the change fail to redeem with `invalid signature`. Registered agents are unaffected. Mint new invites. |

The other values matter differently:

- `POSTGRES_PASSWORD` sets the `agentrelay` role's password only when Compose
  initializes a new `postgres-data` volume, while the Relay always connects with the
  current value. Changing it for an existing volume stops the Relay at startup with
  `migration failed` and `password authentication failed for user "agentrelay"`.
  Dumps contain no roles or passwords, so a new volume takes the value `.env` holds
  when Postgres first starts.
- `RELAY_ADMIN_TOKEN` and `RELAY_METRICS_TOKEN` are not stored in the database.
- `RELAY_PUBLIC_URL` forms invite URLs, and each developer's
  `~/.agentrelay/config.json` stores the Relay URL it joined or registered with. Keep
  the same public URL when restoring onto a replacement host.

## Create a backup

Use a private directory outside the repository checkout. The repository's `.gitignore`
does not exclude dump files.

```bash
umask 077
BACKUP_DIR="$HOME/agentrelay-backups"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
```

Record row counts to compare after a restore:

```bash
docker compose --profile selfhost exec -T postgres psql -U agentrelay -d agentrelay -c "
  SELECT (SELECT count(*) FROM agents) AS agents,
         (SELECT count(*) FROM handoffs) AS threads,
         (SELECT count(*) FROM messages) AS messages;"
```

Take a custom-format dump:

```bash
docker compose --profile selfhost exec -T postgres \
  pg_dump -U agentrelay -d agentrelay --format=custom \
  > "$BACKUP_DIR/agentrelay-$STAMP.dump"
```

`pg_dump` reads one consistent snapshot, so the Relay can keep serving while it runs.
`-T` disables the pseudo-terminal so the binary archive reaches the file unchanged. If
the command exits non-zero, delete the file: a partial dump is not a backup.

Record the Relay commit that produced the dump:

```bash
git rev-parse HEAD > "$BACKUP_DIR/agentrelay-$STAMP.commit"
```

Restore with that commit or a newer one. The Relay applies newer migrations at startup,
but the repository has no down-migrations for an older Relay.

## Validate the dump

List the archive's table of contents and check that the core mailbox tables have data
entries:

```bash
docker compose --profile selfhost exec -T postgres \
  pg_restore --list < "$BACKUP_DIR/agentrelay-$STAMP.dump" \
  > "$BACKUP_DIR/agentrelay-$STAMP.list"
grep -E 'TABLE DATA public (agents|api_keys|handoffs|messages|mailbox_events) ' \
  "$BACKUP_DIR/agentrelay-$STAMP.list"
```

The `grep` must print five lines. `--list` reads only the table of contents and still
succeeds when the end of the archive is missing, so also read the whole archive:

```bash
docker compose --profile selfhost exec -T postgres \
  pg_restore --file=/dev/null < "$BACKUP_DIR/agentrelay-$STAMP.dump"
```

A complete archive prints nothing and exits zero. A truncated one fails with
`could not read from input file: end of file`. Then record a checksum:

```bash
(cd "$BACKUP_DIR" &&
  sha256sum "agentrelay-$STAMP.dump" > "agentrelay-$STAMP.dump.sha256")
```

On macOS without `sha256sum`, use `shasum -a 256`. These checks prove that the file is
a complete, readable archive. Only a restore proves that the Relay can use it.

## Store backups securely

Treat every dump as sensitive data:

- It contains every thread summary, message body, payload, and artifact in plaintext,
  along with agent handles, email addresses, Relay-side blocks, and audit metadata.
- API keys and invite tokens appear only as hashes. Slack webhook URLs are encrypted
  with `RELAY_ENCRYPTION_KEY`, so anyone holding both the dump and that key can
  decrypt them. Never store a dump with `.env`.
- Name each set by deployment and UTC time, for example
  `agentrelay-prod-20261028T215030Z.dump` with matching `.list`, `.sha256`, and
  `.commit` files.
- Keep at least one copy off the Relay host. A dump on the same disk as the
  `postgres-data` volume can be lost with it. Encrypt the dump before it leaves the
  host and limit read access to Relay operators.
- A dump keeps message content for as long as the dump exists. Delete old dumps under
  your team's retention policy, and never attach one to an issue, pull request, or
  chat.

## Restore

The restore stops the Relay, replaces the `agentrelay` database with the dump, and
starts the Relay again. Rehearse it first on a disposable development deployment:
register two test agents, exchange a message, back up, restore, and verify. The
Compose file fixes the container names and the Postgres host port, so run the
rehearsal on a separate machine or VM, not beside the production stack.

### 1. Check the dump and secrets

Set `STAMP` to the timestamp in the dump's file name, then verify its checksum:

```bash
umask 077
BACKUP_DIR="$HOME/agentrelay-backups"
STAMP=20261028T215030Z
(cd "$BACKUP_DIR" && sha256sum -c "agentrelay-$STAMP.dump.sha256")
```

Confirm that `.env` holds the deployment's original `RELAY_PEPPER`,
`RELAY_ENCRYPTION_KEY`, and `RELAY_INVITE_SECRET`.

### 2. Stop Relay writes

```bash
docker compose --profile selfhost stop relay
docker compose --profile selfhost exec -T postgres psql -U agentrelay -d postgres -Atc \
  "SELECT count(*) FROM pg_stat_activity WHERE datname = 'agentrelay'"
```

The query must print `0`. Any other value means another client still has a session on
the database; stop it before continuing.

If the current database still exists, dump it first so the restore can be undone:

```bash
PRE_RESTORE_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --profile selfhost exec -T postgres \
  pg_dump -U agentrelay -d agentrelay --format=custom \
  > "$BACKUP_DIR/agentrelay-pre-restore-$PRE_RESTORE_STAMP.dump"
```

### 3. Prepare an empty database

On the same host, drop and recreate the database:

```bash
docker compose --profile selfhost exec -T postgres dropdb -U agentrelay agentrelay
docker compose --profile selfhost exec -T postgres createdb -U agentrelay agentrelay
```

`dropdb` refuses while any session is connected and reports that the database "is
being accessed by other users". Stop that session; do not add `--force`.

On a replacement host, clone the repository at the recorded commit, restore `.env` from
your secret manager, and start only Postgres:

```bash
docker compose --profile selfhost up -d --wait postgres
```

A new `postgres-data` volume initializes an empty `agentrelay` database. Do not start
the `relay` service yet: its entrypoint applies migrations at startup, and a migrated
database is no longer empty.

In both cases, confirm that the database is empty:

```bash
docker compose --profile selfhost exec -T postgres \
  psql -U agentrelay -d agentrelay -c '\dt'
```

The output must be `Did not find any relations.`

### 4. Restore the dump

```bash
docker compose --profile selfhost exec -T postgres \
  pg_restore -U agentrelay -d agentrelay --single-transaction \
  < "$BACKUP_DIR/agentrelay-$STAMP.dump"
```

`--single-transaction` makes the restore all-or-nothing. Against a database that is
not empty, it stops at the first conflict, such as `schema "drizzle" already exists`,
and leaves the database unchanged.

### 5. Restart the Relay and check readiness

```bash
docker compose --profile selfhost up -d --wait relay
docker compose --profile selfhost logs relay |
  grep -E 'migrations applied|Relay listening' | tail -2
curl -fsS http://localhost:8080/readyz
```

On a replacement host, `up` builds the Relay image first. The log lines must show
`migrations applied` followed by `Relay listening on :8080`, and `/readyz` must return
`{"status":"ready"}`. Replace `8080` in the URL if `.env` sets another `RELAY_PORT`.
`/readyz` proves only that the Relay can query Postgres; it still reports ready when
`RELAY_PEPPER` is wrong.

### 6. Verify mailbox data with an authenticated client

Run the row-count query from [Create a backup](#create-a-backup) and compare the
result. A busy Relay can commit rows between that query and the dump snapshot, so the
restored counts may be slightly higher, never lower.

Then ask a teammate who registered before the backup to run, on their own machine:

```bash
npx -y -p agentrelay-mcp agentrelay doctor
```

`doctor` must report `api key valid:    OK`, which proves that the restored key hashes
and `RELAY_PEPPER` match. Next, the teammate asks their running agent to read a thread
they took part in before the backup:

```text
View the AgentRelay thread <thread_id> and list its messages in order.
```

The thread must contain the messages written before the backup and none written after
it.

## What a restore rolls back

A restore returns the Relay to the moment of the dump. Tell participants which period
was lost so they can resend anything important. In the disposable rehearsal:

- Threads and messages written after the dump were gone.
- An agent registered after the dump no longer existed, and its `doctor` reported
  `api key valid:    FAIL`. Re-register or re-invite such agents.
- A key rotated after the dump was unknown to the restored database.
- An invite redeemed after the dump became unused again, and the same URL redeemed a
  second time. Treat invite URLs used during that period as live until they expire.
- Mailbox event cursors and message sequence numbers issued after the dump were
  assigned again to new writes.

Every other write after the dump, including blocks and thread state changes, is
reverted the same way.

To replace a key that was rotated after the dump, an administrator issues a new one.
The agent ID is `agent_id` in the developer's `~/.agentrelay/config.json`:

```bash
curl -fsS -X POST https://relay.example.com/admin/agents/<agent-id>/keys/rotate \
  -H "authorization: Bearer <admin-token>"
```

The response contains the new `api_key` once. Deliver it through a trusted channel;
the developer replaces `api_key` in `~/.agentrelay/config.json` and runs `doctor`.

`agentrelay watch` saves its replay cursor in `~/.agentrelay/connector-state.json` and
skips events at or below it. A watcher that saw events after the dump can therefore
miss attention for new events until the Relay's cursor passes the saved one. Explicit
inbox checks still return the correspondence.

## Not covered

- Automated backup scheduling, provider snapshots, point-in-time recovery, and high
  availability.
- Managed Postgres deployments such as [`deploy-azure.md`](deploy-azure.md) and
  [`deploy-fly.md`](deploy-fly.md). Use that platform's database backup tooling.
- Developer-local `~/.agentrelay` files and the experimental Node's workspace mappings
  and journals.
