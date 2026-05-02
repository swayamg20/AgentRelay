# Deploying AgentRelay relay to Fly.io

## What this gets you
This walkthrough gets you a 256 MB shared-cpu-1x free-tier AgentRelay relay running on Fly.io in the default `iad` region, reachable at a `*.fly.dev` subdomain or your own domain via CNAME. Fly auto-provisions HTTPS for the app, the internal port is 8080, and the healthcheck path is `/healthz`.

After setup, `fly deploy` is the one-command release path from the repo root. The committed `fly.toml` builds from the repo root using `relay/Dockerfile`, migrations run on container boot via the entrypoint with no separate `release_command`, and auto-deploy on `v*.*.*` tag push via GitHub Actions is wired up through `.github/workflows/deploy.yml` but optional.

## Prerequisites
- A Fly.io account (`fly auth signup`)
- `flyctl` installed locally (`brew install flyctl` on macOS, or curl install on Linux)
- A clone of this repo with the `fly.toml` already present at the root
- (Optional) A domain you control if you want a custom hostname instead of `<app>.fly.dev`

## One-time setup

### 1. Authenticate
```bash
brew install flyctl
fly auth signup       # or `fly auth login` if you already have an account
```

### 2. Launch the app (does not deploy yet)
From the repo root:
```bash
fly launch --no-deploy --copy-config
```

This deploys only the relay. The `agentrelay-mcp` package on npm is the client, not the Fly app you are launching here.

What this does: reads our committed `fly.toml`, prompts you to pick a unique app name (the default `agentrelay-relay` is almost certainly taken - pick something like `agentrelay-<yourhandle>`), and creates the app. `--no-deploy` keeps it from trying to push an image before secrets are set. `--copy-config` keeps our `fly.toml` instead of regenerating one.

If `fly launch` rewrites `fly.toml` with a different app name, that is expected - commit the change.

### 3. Provision Postgres
```bash
fly postgres create --name agentrelay-pg --vm-size shared-cpu-1x --volume-size 1 --region iad
fly postgres attach agentrelay-pg --app <your-app-name>
```

Attach injects a `DATABASE_URL` secret into the app. The relay reads `RELAY_DATABASE_URL`, so duplicate the value:
```bash
fly ssh console -a <your-app-name> -C 'env' | grep DATABASE_URL
# Copy the postgres://... value, then:
fly secrets set RELAY_DATABASE_URL='postgres://...' -a <your-app-name>
```

(If you would rather not SSH, `fly secrets list` shows the digest but not the value - keep the URL from the `attach` output the first time it is printed.)

Fly does not support server-side secret aliases, so explicitly setting `RELAY_DATABASE_URL` to the same connection string is the cleanest path.

### 4. Set the rest of the secrets
These app secrets are required and should not be committed to `fly.toml`: `RELAY_PEPPER`, `RELAY_ENCRYPTION_KEY`, `RELAY_ADMIN_TOKEN`, `RELAY_METRICS_TOKEN`, `RELAY_INVITE_SECRET`, `RELAY_PUBLIC_URL`, and `RELAY_DATABASE_URL`.

Generate strong values and push them all in one call (one machine restart):
```bash
fly secrets set \
  RELAY_PEPPER=$(openssl rand -hex 32) \
  RELAY_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  RELAY_INVITE_SECRET=$(openssl rand -hex 32) \
  RELAY_ADMIN_TOKEN=$(openssl rand -hex 16) \
  RELAY_METRICS_TOKEN=$(openssl rand -hex 16) \
  RELAY_PUBLIC_URL=https://<your-app-name>.fly.dev \
  -a <your-app-name>
```

Save these values somewhere safe (1Password, age-encrypted file). `RELAY_PEPPER` and `RELAY_ENCRYPTION_KEY` are sticky - rotating them invalidates every issued API key and every encrypted Slack webhook respectively.

### 5. Deploy
```bash
fly deploy -a <your-app-name>
```

The build runs remotely on Fly's builder (no local Docker required if you use `--remote-only`, which is the default for tagged deploys). The container's entrypoint runs Drizzle migrations idempotently before starting the relay.

### 6. Verify
```bash
curl https://<your-app-name>.fly.dev/healthz
# Expected: {"status":"ok"}
```

## Custom domain (optional)
```bash
fly certs add relay.yourdomain.com -a <your-app-name>
```

Fly prints the DNS records you need (a CNAME pointing at `<your-app-name>.fly.dev` plus an `_acme-challenge` validator). Add them at your DNS provider. Once propagation completes (usually under a minute for Cloudflare), update `RELAY_PUBLIC_URL`:
```bash
fly secrets set RELAY_PUBLIC_URL=https://relay.yourdomain.com -a <your-app-name>
```

## Auto-deploy on tag push (optional)
The repo ships `.github/workflows/deploy.yml`. To enable it:

1. `fly auth token` (locally) - copy the token.
2. GitHub repo -> Settings -> Secrets and variables -> Actions -> New repository secret. Name: `FLY_API_TOKEN`. Value: paste.
3. From now on, `git tag v0.2.1 && git push origin v0.2.1` triggers a deploy. Day-to-day pushes to `main` do not deploy.

## Troubleshooting

### Healthcheck failing right after deploy
Check `fly logs -a <your-app-name>`. The most common causes:
- Migrations failed at boot. Look for `[entrypoint] applying migrations...` followed by an error. Usually a missing or wrong `RELAY_DATABASE_URL`.
- Postgres connection refused. Confirm the postgres app is running (`fly status -a agentrelay-pg`) and the attach injected a working URL.

### Migrations fail at boot
The entrypoint is `cd /app/relay && node dist/db/migrate.js && exec node dist/main.js`. If migrate.js exits non-zero the container restarts in a loop. SSH in to inspect:
```bash
fly ssh console -a <your-app-name>
cd /app/relay && node dist/db/migrate.js
```

If you need to roll forward a stuck migration, edit Drizzle metadata in the postgres app directly (`fly postgres connect -a agentrelay-pg`).

### Relay rejects a secret as too short
The relay's zod config requires `RELAY_PEPPER`, `RELAY_ENCRYPTION_KEY`, and `RELAY_INVITE_SECRET` to be at least 32 bytes. `openssl rand -hex 32` produces 64 hex chars (32 bytes), which is correct. `openssl rand -hex 16` produces 32 hex chars (16 bytes) - only safe for `RELAY_ADMIN_TOKEN` and `RELAY_METRICS_TOKEN`.

### Free-tier machine reclaim
Fly may stop idle free-tier machines. `fly.toml` sets `auto_start_machines = true` so the next inbound request boots a machine cold (~2s startup). For consistent latency, upgrade to paid `shared-cpu-1x` (~$1.94/mo) and set `min_machines_running = 1`.

### Custom domain stuck on "awaiting CNAME"
Run `fly certs show relay.yourdomain.com -a <your-app-name>`. The output lists exactly which DNS records Fly is looking for. Cloudflare's "proxied" mode (the orange cloud) breaks Fly's ACME challenge - set the record to "DNS only" (grey cloud) until the cert issues, then optionally re-enable proxying.

## Cost expectations
- Relay app on free tier: $0/mo (3x shared-1x 256 MB free forever)
- Postgres on free tier: $0/mo (3 GB volume free)
- Custom domain: ~$9/yr at Cloudflare Registrar
- Total: ~$1/mo amortized

If your relay starts handling real traffic, upgrade Postgres to `shared-cpu-2x` with a 10 GB volume (~$8/mo) before you run out of memory.
