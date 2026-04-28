# Multi-stage build for AgentRelay relay (Hono + Drizzle + Postgres).
#
# Stage 1: install dev deps and build TS → JS.
# Stage 2: copy only the built dist + production deps + migration files
#          into a slim runtime image.
#
# The runtime entrypoint runs Drizzle migrations once (idempotent), then
# starts the server. Build with:
#
#     docker build -t agentrelay-relay:0.1.1 -f relay/Dockerfile .
#
# (build context is the repo root so we can copy the workspace lockfile.)

# ─── builder ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Workspace metadata first — gives us the dependency graph for the install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY relay/package.json relay/tsconfig.json ./relay/

# Install dev deps so we can run tsc during the build. Filtered to just the
# relay subgraph (no mcp-server deps pulled into the build).
RUN pnpm install --frozen-lockfile --filter relay...

# Copy source (everything in relay/) and build.
COPY relay/ ./relay/
RUN pnpm --filter relay build

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Curl for healthchecks. Non-root user for the runtime — relay never needs root.
RUN apk add --no-cache curl tini && \
    addgroup -S agentrelay && adduser -S agentrelay -G agentrelay

COPY --from=builder --chown=agentrelay:agentrelay /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder --chown=agentrelay:agentrelay /app/relay/package.json ./relay/
COPY --from=builder --chown=agentrelay:agentrelay /app/relay/dist ./relay/dist
COPY --from=builder --chown=agentrelay:agentrelay /app/relay/drizzle ./relay/drizzle

# Production deps only.
RUN pnpm install --frozen-lockfile --prod --filter relay... && \
    chown -R agentrelay:agentrelay /app

# Entrypoint runs migrations then starts the server. Migrations are idempotent
# (drizzle's _journal tracks applied versions) so safe to run on every boot.
COPY --chown=agentrelay:agentrelay relay/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER agentrelay
EXPOSE 8080

# tini reaps zombies + handles SIGTERM cleanly so the relay exits gracefully.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]

# Health probe: relay's /healthz returns 200 once the process is up. /readyz
# is what we'd use for "are dependencies wired" — kept here for future k8s.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS http://localhost:8080/healthz || exit 1
