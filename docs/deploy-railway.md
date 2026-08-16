# Deploy the Relay to Railway with production approval

This is the repository's guarded Railway path for a shared Relay. A successful
`CI` run on `main` creates a deployment for the `railway-production` GitHub
environment. Railway receives the code only after an approved reviewer releases
that job.

The workflow deploys the exact commit tested by CI and refuses it if a newer
`main` commit already exists. Railway's native GitHub auto-deploy must remain
disabled; otherwise a push can still reach production before the approval gate.

## 1. Create the Railway services

Create a Railway project with:

- a Postgres service;
- a Relay service built from `relay/Dockerfile`, with the repository root as the
  build context;
- `RELAY_DATABASE_URL=${{Postgres.DATABASE_URL}}`, replacing `Postgres` if the
  database service has a different name;
- fresh production values for every required Relay secret in
  [`.env.example`](../.env.example), rather than its committed development
  examples; and
- `/readyz` as the service healthcheck path.

Generate `RELAY_PEPPER`, `RELAY_ENCRYPTION_KEY`, `RELAY_INVITE_SECRET`,
`RELAY_ADMIN_TOKEN`, and `RELAY_METRICS_TOKEN` with the commands documented in
`.env.example`. Keep the pepper and encryption key stable after launch; see
[`hosting.md`](hosting.md) before rotating either value.

Set `RELAY_PUBLIC_URL` to the public HTTPS origin. Confirm both endpoints before
changing deployment automation:

```bash
curl https://relay.example.com/healthz
curl https://relay.example.com/readyz
```

## 2. Protect the GitHub environment

Create a GitHub environment named `railway-production` under **Settings →
Environments**. Configure it as follows:

- require an approval from a maintainer;
- restrict deployments to the protected `main` branch; and
- disallow administrators from bypassing the protection rules.

If the repository has only one maintainer, allow self-review. Turn on prevention
of self-review only after a second trusted reviewer exists, or deployments will
deadlock.

Add these environment variables:

| Name | Value |
|---|---|
| `RAILWAY_PROJECT_ID` | Railway project ID |
| `RAILWAY_ENVIRONMENT_ID` | Railway production environment ID |
| `RAILWAY_SERVICE_ID` | Railway Relay service ID |
| `RELAY_PUBLIC_URL` | Public HTTPS origin, without a trailing slash |

Create a Railway project token scoped to the production environment. Save it as
the environment secret `RAILWAY_TOKEN`; never place it in a repository variable,
workflow file, issue, or log.

## 3. Cut over from native auto-deploy

Before disabling anything, make sure the current production deployment is
healthy and the workflow pull request is green. Then freeze merges briefly and:

1. Disable **GitHub auto-deploy** for the Relay service in Railway. Keep the
   source repository connected.
2. Merge the workflow change.
3. Wait for `CI` on `main` to pass.
4. Review the pending `railway-production` deployment in GitHub Actions and
   select **Approve and deploy**.
5. Verify the workflow and both public health endpoints.

Disabling auto-deploy does not stop the active container. If the gated workflow
cannot deploy, re-enable auto-deploy temporarily while fixing the GitHub
environment or token. If a new release is unhealthy, redeploy a specifically
known-good Railway deployment; do not assume the newest deployment is safe.

Database migrations run when the Relay starts. Keep migrations backward
compatible so the previous image remains a valid rollback while a release is in
flight.
