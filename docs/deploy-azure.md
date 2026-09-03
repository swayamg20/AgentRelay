# Deploy the AgentRelay team pilot on Azure

This guide deploys the current shared Relay and PostgreSQL database. Developer agents,
the experimental AgentRelay Node, local workspace mappings, and Mission Capsules remain
on each teammate's machine.

The template is deliberately a pilot topology:

- one public-HTTPS Azure Container App pinned to a tested Relay image digest;
- one private PostgreSQL 16 Flexible Server;
- sticky credentials in Azure Key Vault, read by managed identity;
- one replica while the Relay container owns startup migrations; and
- Log Analytics with 30-day retention.

High availability, geo-redundant backups, a separate migration job, and split database
schema-owner/runtime roles are not included. Do not describe this topology as
production-hardened.

## Prerequisites

You need:

- an Azure subscription where you can create resources and role assignments;
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 2.53 or newer;
- Bash, OpenSSL, and curl; and
- a dedicated resource group name and explicit Azure region.

The account running the deployment must also be allowed to create role assignments.
The template grants that deployment principal read access to the pilot's Key Vault so
later deployments can safely reuse sticky credentials. The deploy script refuses to
replace an unreadable or missing credential.

Sign in and inspect the subscriptions you can actually use:

```bash
az login
az account list --output table
```

The repository does not choose a subscription or region for you. For an India-based
team, `centralindia` is a reasonable first region only after confirming PostgreSQL and
Container Apps availability for your subscription.

Interactive user logins are detected automatically. For a service principal or an
account whose directory object cannot be queried, add
`--deployer-object-id '<entra-object-id>'` to both commands.
Keep the same deployment principal for redeployments. Changing it fails closed at the
stable role assignment instead of leaving the previous principal's secret access
behind; transfer that access deliberately before changing deployment ownership.

## Review the change before paying for it

From the repository root, run `plan` with explicit targets:

```bash
./infra/azure/deploy.sh plan \
  --subscription '<subscription-id>' \
  --location centralindia \
  --resource-group agentrelay-pilot-rg
```

`plan` validates the Bicep and runs Azure what-if. It may register the required Azure
resource providers and create/tag the resource group, but it does not create the
billable Container Apps or PostgreSQL workload.

Read the what-if output. In particular, confirm the subscription, region, dedicated
resource group, private PostgreSQL network, and `Standard_B1ms` database SKU.

## Deploy

Use the same arguments with `apply`:

```bash
./infra/azure/deploy.sh apply \
  --subscription '<subscription-id>' \
  --location centralindia \
  --resource-group agentrelay-pilot-rg
```

The first deployment generates URL-safe credentials in memory and stores them in Key
Vault. The resource group's `agentrelaySuffix` tag preserves globally unique resource
names. Later deployments read and reuse the existing values; in particular, they never
silently rotate `RELAY_PEPPER` or `RELAY_ENCRYPTION_KEY`.

The default image is immutable:

```text
ghcr.io/swayamg20/agentrelay-relay@sha256:7bd29bee61450f18437c6ffb5b0e44990ebed1c46d718226184a695909c089ba
```

Supply `--image` only for another public image that you have built and verified. The
template intentionally has no private-registry credential path yet.

## Verify service and database readiness

The apply command prints the HTTPS Relay URL, Container App name, and Key Vault name.
Check both probes:

```bash
./infra/azure/smoke.sh 'https://<relay-host>'
```

Expected results:

```text
healthz: ok
readyz: ready (database reachable)
```

`/healthz` proves the process is serving. `/readyz` also probes PostgreSQL, so a green
health check alone is not deployment acceptance.

Inspect the single active revision and recent logs without printing application
secrets:

```bash
az containerapp revision list \
  --resource-group agentrelay-pilot-rg \
  --name '<relay-app-name>' \
  --query '[?properties.active].{name:name,health:properties.healthState,replicas:properties.replicas}' \
  --output table

az containerapp logs show \
  --resource-group agentrelay-pilot-rg \
  --name '<relay-app-name>' \
  --tail 100
```

The startup log should report `migrations applied`, followed by the Relay listening on
port 8080. The database is private and has no public firewall exception.

## Connect the first two teammates

Read [`onboarding.md`](onboarding.md) for the complete CLI contract. The compact pilot
sequence is:

1. On laptop A, register the first teammate with the Key Vault-backed admin token.
2. Mint a signed invite for laptop B and share it through a trusted channel.
3. On laptop B, run `agentrelay join`, then `agentrelay doctor`.
4. Send and accept one handoff, reply, and view the thread from laptop A.
5. Send a second handoff, restart the active Container App revision, then receive and
   reply from laptop B. This proves that PostgreSQL state, not a live process, owns
   delivery durability.

Use `agentrelay-mcp@0.3.0` explicitly during the pilot so both machines test the same
published client:

```bash
export AGENTRELAY_ADMIN_TOKEN="$(az keyvault secret show \
  --vault-name '<key-vault-name>' \
  --name relay-admin-token \
  --query value \
  --output tsv)"

npx -y -p agentrelay-mcp@0.3.0 agentrelay register \
  --relay 'https://<relay-host>' \
  --admin-token "$AGENTRELAY_ADMIN_TOKEN" \
  --handle 'alice@your-team' \
  --email 'alice@example.com' \
  --name 'Alice' \
  --role backend

unset AGENTRELAY_ADMIN_TOKEN
npx -y -p agentrelay-mcp@0.3.0 agentrelay install --client all --overwrite
npx -y -p agentrelay-mcp@0.3.0 agentrelay doctor
```

Continue with the signed invite and round-trip commands in
[`onboarding.md`](onboarding.md), substituting `agentrelay-mcp@0.3.0` in every pilot
command on both machines. The command substitution keeps the literal token out of
shell history, but `--admin-token "$AGENTRELAY_ADMIN_TOKEN"` still exposes it briefly
in both the process environment and the registration process arguments. Run it only
on a trusted administrator machine and unset it immediately.

## Secret handling and redeployment

Never paste Key Vault values into issues, chat, shell history, or logs.

- `relay-pepper` authenticates stored credentials. Changing it invalidates them.
- `relay-encryption-key` protects encrypted webhook data. Changing it without a
  re-encryption migration loses access to that data.
- `relay-invite-secret` invalidates unredeemed invites when rotated.
- `relay-admin-token` and `relay-metrics-token` are independently rotatable.
- `postgres-admin-password` is retained separately so safe redeployment does not need
  to parse the database URL.

If `deploy.sh` cannot read an existing secret, restore the deployer's Key Vault data
access. Do not delete the vault or generate replacement values as a workaround.
If every deployment credential is missing but a Relay or PostgreSQL resource already
exists, the script also fails closed; restore the original values or deliberately
retire that partial pilot before starting with a new resource group.

Key Vault role assignments can take time to propagate on the first deployment. If
Container App creation reports a Key Vault authorization error, wait a few minutes and
rerun the exact same `apply` command. The resource-group suffix and any already-created
secrets are reused.

## Pilot limits and next hardening step

The current image runs database migrations in its entrypoint and then runs the Relay
with the PostgreSQL administrator credential. That is acceptable for this controlled
pilot, not for a mature production service. Before increasing `maxReplicas` above one:

1. move migrations to a separately owned deployment job;
2. introduce distinct schema-owner and least-privilege runtime database roles;
3. add high availability and a tested restore procedure; and
4. decide the ingress/IP policy and monitoring alerts for your team.

Azure resources incur charges while they exist. Use Azure Cost Management during the
pilot. When the pilot is intentionally finished, review the resource group contents
before deleting that dedicated group; deletion also removes the database and Key
Vault and is not a rollback strategy.

## Troubleshooting

- **`az` is missing:** install Azure CLI, then run `az login`.
- **Provider registration fails:** ask a subscription administrator to register the
  provider named in the error.
- **`CREATE EXTENSION` fails:** verify PostgreSQL parameter `azure.extensions` contains
  both `citext` and `pgcrypto`; the Bicep configures them before app startup.
- **`/healthz` works but `/readyz` fails:** inspect Container App logs and private DNS,
  subnet delegation, and PostgreSQL state. Do not mark the deployment healthy.
- **Key Vault reference fails:** confirm the Relay user-assigned identity still has the
  `Key Vault Secrets User` role and retry after RBAC propagation.
