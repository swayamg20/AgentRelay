# Where to host the AgentRelay relay

The relay is a single Docker container that talks to Postgres. Anywhere
that runs containers will work. The base setup
(`docker compose --profile selfhost up -d`) brings up both the relay
and Postgres on one box; managed-Postgres platforms typically expect
you to run them separately.

This doc is a quick survey of common options as of **May 2026** so you
don't have to research each one. Pricing changes; verify before
committing. The project does not endorse any specific platform — pick
what matches your team's posture.

## Quick comparison

| Platform | Realistic monthly | Free tier? | Setup effort | Notes |
|---|---|---|---|---|
| **Your own VPS** (Hetzner, DigitalOcean, OVH, Linode, etc.) | €4–6 / $5–6 | ❌ | medium | Manual Linux ops; `docker compose --profile selfhost up -d`; reverse proxy via Caddy. Cheapest reliable path. |
| **Railway Hobby** | $5 (flat sub + $5 usage credit) | trial only ($5 credit) | low | Push to GitHub, auto-detect Dockerfile, one-click Postgres add-on, custom domain + auto SSL. AgentRelay's tiny load fits inside the included credit. |
| **Fly.io** | ~$5–10 | ❌ (retired Oct 2024) | medium | Pay-as-you-go: ~$2 VM + ~$5 Postgres dev cluster. New signups need a credit card. Fast deploy via `flyctl`. |
| **Render Starter** | ~$7 per service | free web service sleeps after 15min | low | Always-on at Starter tier. Postgres add-on extra. Free tier's idle-sleep makes inbox checks slow. |
| **Oracle Cloud Always Free** | $0 forever | ✅ (4 ARM cores, 24 GB RAM) | high | Most generous free hardware in the industry, but capacity errors during signup are common and Oracle has been known to reclaim idle accounts. |
| **Self-hosted on your own hardware** (NUC, Pi, NAS) | $0 (you own it) | ✅ | varies | DDNS or Cloudflare Tunnel for the public URL. Fine for a small team. |

## Universal contract

Whichever platform you pick, the relay needs:

- **A container runtime** that can build from `relay/Dockerfile` (build context = repo root). Multi-stage Node 22 Alpine; non-root user; tini for signals; healthcheck on `/healthz`.
- **Postgres 16+** reachable via `RELAY_DATABASE_URL`.
- **A persistent disk** for Postgres if you're co-locating it with the relay.
- **A public HTTPS endpoint** (most platforms auto-provision; if not, Caddy or Cloudflare Tunnel in front).
- **These env vars set as secrets** (not committed to the platform config):
  - `RELAY_PEPPER` (32+ bytes hex) — `openssl rand -hex 32`
  - `RELAY_ENCRYPTION_KEY` (32 bytes hex) — `openssl rand -hex 32`
  - `RELAY_INVITE_SECRET` (32+ bytes hex) — `openssl rand -hex 32`
  - `RELAY_ADMIN_TOKEN` (16+ bytes hex) — `openssl rand -hex 16`
  - `RELAY_METRICS_TOKEN` (any non-empty string) — `openssl rand -hex 16`
  - `RELAY_PUBLIC_URL` — the publicly-resolvable HTTPS URL of the relay
  - Plus the others from `.env.example` if you want to override defaults.

## Migration / rotation notes

- `RELAY_PEPPER` is **sticky** — rotating it invalidates every existing API key (every teammate has to re-register). Pick a stable value at launch and keep it.
- `RELAY_ENCRYPTION_KEY` is sticky for any encrypted-at-rest fields (Slack webhook URLs today). Rotate only with a re-encrypt step.
- `RELAY_ADMIN_TOKEN` is rotatable freely; existing teammates aren't affected.
- `RELAY_INVITE_SECRET` is rotatable but invalidates any minted-but-unredeemed invite URLs.

## Worked examples

The repo ships some reference configs you may find useful, but they're
not the primary path:

- **`fly.toml`** at the repo root and **`docs/deploy-fly.md`** — a complete Fly walkthrough, kept as a reference for users who already use Fly.
- **`.github/workflows/deploy.yml`** — auto-deploy to Fly on `v*.*.*` tag push. Adapt the steps for your platform if it's different.
- **`docker-compose.yml`** with the `selfhost` profile — the canonical "everything on one box" setup. Use it on any VPS.

If you write a guide for a platform that isn't in this list, PRs are
welcome. Keep cost notes honest and dated.
