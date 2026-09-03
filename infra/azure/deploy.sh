#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_IMAGE='ghcr.io/swayamg20/agentrelay-relay@sha256:7bd29bee61450f18437c6ffb5b0e44990ebed1c46d718226184a695909c089ba'
readonly DEFAULT_PREFIX='agentrelay'
readonly POSTGRES_LOGIN='agentrelay_admin'

usage() {
	cat <<'EOF'
Usage:
  ./infra/azure/deploy.sh plan  --subscription ID --location REGION --resource-group NAME [options]
  ./infra/azure/deploy.sh apply --subscription ID --location REGION --resource-group NAME [options]

Required:
  --subscription ID       Azure subscription ID or name
  --location REGION       Azure region, for example centralindia
  --resource-group NAME   Dedicated resource group for the pilot

Options:
  --name-prefix PREFIX    Lowercase resource prefix (default: agentrelay)
  --image IMAGE           Public Relay image pinned by digest
  --deployer-object-id ID Override the signed-in user's Entra object ID
  -h, --help              Show this help

The plan command registers required providers and creates/tags the resource group
when necessary. It does not create the billable workload. The apply command creates
or updates the workload. Existing deployments reuse every sticky secret from Key
Vault; they are never silently regenerated.
EOF
}

fail() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

new_hex_secret() {
	openssl rand -hex "$1"
}

read_existing_secret() {
	local secret_name=$1
	local value

	if ! value=$(az keyvault secret show \
		--only-show-errors \
		--vault-name "$key_vault_name" \
		--name "$secret_name" \
		--query value \
		--output tsv); then
		fail "cannot read '$secret_name' from Key Vault '$key_vault_name'. Do not redeploy until secret-read access is restored; regenerating sticky secrets would break existing credentials."
	fi

	[[ -n "$value" ]] || fail "Key Vault secret '$secret_name' is empty"
	printf '%s' "$value"
}

clear_sensitive_environment() {
	unset AGENTRELAY_AZURE_POSTGRES_PASSWORD
	unset AGENTRELAY_AZURE_RELAY_PEPPER
	unset AGENTRELAY_AZURE_RELAY_ENCRYPTION_KEY
	unset AGENTRELAY_AZURE_RELAY_INVITE_SECRET
	unset AGENTRELAY_AZURE_RELAY_ADMIN_TOKEN
	unset AGENTRELAY_AZURE_RELAY_METRICS_TOKEN
}

[[ $# -gt 0 ]] || {
	usage >&2
	exit 2
}

case "$1" in
	plan | apply)
		mode=$1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		fail "first argument must be 'plan' or 'apply'"
		;;
esac

subscription=''
location=''
resource_group=''
name_prefix=$DEFAULT_PREFIX
relay_image=$DEFAULT_IMAGE
deployer_principal_id=''

while [[ $# -gt 0 ]]; do
	case "$1" in
		--subscription | --location | --resource-group | --name-prefix | --image | --deployer-object-id)
			[[ $# -ge 2 ]] || fail "$1 requires a value"
			case "$1" in
				--subscription) subscription=$2 ;;
				--location) location=$2 ;;
				--resource-group) resource_group=$2 ;;
				--name-prefix) name_prefix=$2 ;;
				--image) relay_image=$2 ;;
				--deployer-object-id) deployer_principal_id=$2 ;;
			esac
			shift 2
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) fail "unknown argument: $1" ;;
	esac
done

[[ -n "$subscription" ]] || fail '--subscription is required'
[[ -n "$location" ]] || fail '--location is required'
[[ -n "$resource_group" ]] || fail '--resource-group is required'
[[ "$name_prefix" =~ ^[a-z][a-z0-9]{2,11}$ ]] || fail '--name-prefix must be 3-12 lowercase alphanumeric characters and start with a letter'
[[ "$location" =~ ^[a-z0-9]+$ ]] || fail '--location must be an Azure region name such as centralindia'
[[ "$relay_image" =~ ^[A-Za-z0-9./_-]+@sha256:[a-f0-9]{64}$ ]] || fail '--image must be a container image pinned by sha256 digest'
object_id_pattern='^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
[[ -z "$deployer_principal_id" || "$deployer_principal_id" =~ $object_id_pattern ]] || fail '--deployer-object-id must be an Entra object ID'

require_command az
require_command openssl

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
trap clear_sensitive_environment EXIT

az account show --only-show-errors >/dev/null 2>&1 || fail 'Azure CLI is not authenticated; run az login first'
az account set --subscription "$subscription" --only-show-errors

printf 'Validating Bicep...\n'
if ! az bicep version >/dev/null 2>&1; then
	printf 'Installing Bicep through Azure CLI...\n'
	az bicep install --only-show-errors
fi
az bicep build --file "$script_dir/main.bicep" --stdout >/dev/null

account_name=$(az account show --query name --output tsv)
account_id=$(az account show --query id --output tsv)

if [[ -z "$deployer_principal_id" ]]; then
	deployer_principal_id=$(az ad signed-in-user show --query id --output tsv 2>/dev/null || true)
	[[ "$deployer_principal_id" =~ $object_id_pattern ]] || fail 'could not resolve the signed-in user object ID; pass --deployer-object-id explicitly (required for service-principal deployments)'
fi

printf 'Azure subscription: %s (%s)\n' "$account_name" "$account_id"
printf 'Region: %s\nResource group: %s\n' "$location" "$resource_group"

for provider in \
	Microsoft.App \
	Microsoft.DBforPostgreSQL \
	Microsoft.KeyVault \
	Microsoft.ManagedIdentity \
	Microsoft.Network \
	Microsoft.OperationalInsights; do
	state=$(az provider show --namespace "$provider" --query registrationState --output tsv 2>/dev/null || true)
	if [[ "$state" != 'Registered' ]]; then
		printf 'Registering provider %s...\n' "$provider"
		az provider register --namespace "$provider" --wait --only-show-errors
	fi
done

if ! az group show --name "$resource_group" --only-show-errors >/dev/null 2>&1; then
	printf 'Creating resource group %s...\n' "$resource_group"
	az group create \
		--name "$resource_group" \
		--location "$location" \
		--tags application=AgentRelay environment=pilot \
		--only-show-errors \
		--output none
fi

resource_suffix=$(az group show \
	--name "$resource_group" \
	--query tags.agentrelaySuffix \
	--output tsv 2>/dev/null || true)

if [[ ! "$resource_suffix" =~ ^[a-f0-9]{8}$ ]]; then
	[[ -z "$resource_suffix" || "$resource_suffix" == 'None' ]] || fail "resource group tag agentrelaySuffix has invalid value '$resource_suffix'"
	resource_suffix=$(new_hex_secret 4)
	az group update \
		--name "$resource_group" \
		--set \
			tags.application=AgentRelay \
			tags.environment=pilot \
			tags.agentrelayPrefix="$name_prefix" \
			tags.agentrelaySuffix="$resource_suffix" \
		--only-show-errors \
		--output none
fi

stored_prefix=$(az group show \
	--name "$resource_group" \
	--query tags.agentrelayPrefix \
	--output tsv 2>/dev/null || true)

if [[ -z "$stored_prefix" || "$stored_prefix" == 'None' ]]; then
	az group update \
		--name "$resource_group" \
		--set tags.agentrelayPrefix="$name_prefix" \
		--only-show-errors \
		--output none
elif [[ "$stored_prefix" != "$name_prefix" ]]; then
	fail "resource group is already bound to name prefix '$stored_prefix'; reuse it instead of creating a second pilot"
fi

key_vault_name="${name_prefix}-${resource_suffix}-kv"
relay_name="${name_prefix}-${resource_suffix}-relay"
postgres_server_name="${name_prefix}-${resource_suffix}-pg"
if az keyvault show --name "$key_vault_name" --resource-group "$resource_group" --only-show-errors >/dev/null 2>&1; then
	if ! secret_names=$(az keyvault secret list \
		--vault-name "$key_vault_name" \
		--query '[].name' \
		--output tsv \
		--only-show-errors); then
		fail "cannot list Key Vault '$key_vault_name'. Restore secret-read access before redeploying."
	fi

	expected_secrets=(
		postgres-admin-password
		relay-pepper
		relay-encryption-key
		relay-invite-secret
		relay-admin-token
		relay-metrics-token
	)
	present_secret_count=0
	for secret_name in "${expected_secrets[@]}"; do
		if grep -Fxq "$secret_name" <<<"$secret_names"; then
			present_secret_count=$((present_secret_count + 1))
		fi
	done

	if [[ "$present_secret_count" -eq 0 ]]; then
		if ! relay_count=$(az resource list \
			--resource-group "$resource_group" \
			--name "$relay_name" \
			--resource-type Microsoft.App/containerApps \
			--query 'length(@)' \
			--output tsv \
			--only-show-errors); then
			fail 'cannot prove whether an existing Relay depends on the missing credentials'
		fi
		if ! postgres_count=$(az resource list \
			--resource-group "$resource_group" \
			--name "$postgres_server_name" \
			--resource-type Microsoft.DBforPostgreSQL/flexibleServers \
			--query 'length(@)' \
			--output tsv \
			--only-show-errors); then
			fail 'cannot prove whether an existing PostgreSQL server depends on the missing credentials'
		fi
		[[ "$relay_count" =~ ^[0-9]+$ ]] || fail 'Azure returned an invalid Relay inventory result'
		[[ "$postgres_count" =~ ^[0-9]+$ ]] || fail 'Azure returned an invalid PostgreSQL inventory result'
		if [[ "$relay_count" -ne 0 || "$postgres_count" -ne 0 ]]; then
			fail \
				"Key Vault '$key_vault_name' has no deployment credentials, but an existing workload may depend on them." \
				'Restore the original values; regeneration would break stored credentials or encrypted data.'
		fi
		printf 'Key Vault exists without deployment credentials; recovering first-deployment secret generation.\n'
		postgres_password=$(new_hex_secret 24)
		relay_pepper=$(new_hex_secret 32)
		relay_encryption_key=$(new_hex_secret 32)
		relay_invite_secret=$(new_hex_secret 32)
		relay_admin_token=$(new_hex_secret 24)
		relay_metrics_token=$(new_hex_secret 16)
	elif [[ "$present_secret_count" -ne "${#expected_secrets[@]}" ]]; then
		fail "Key Vault '$key_vault_name' contains only $present_secret_count of ${#expected_secrets[@]} deployment credentials. Restore the missing values; partial secret replacement is unsafe."
	else
		printf 'Reusing sticky secrets from Key Vault %s.\n' "$key_vault_name"
		postgres_password=$(read_existing_secret postgres-admin-password)
		relay_pepper=$(read_existing_secret relay-pepper)
		relay_encryption_key=$(read_existing_secret relay-encryption-key)
		relay_invite_secret=$(read_existing_secret relay-invite-secret)
		relay_admin_token=$(read_existing_secret relay-admin-token)
		relay_metrics_token=$(read_existing_secret relay-metrics-token)
	fi
else
	printf 'Generating first-deployment secrets in memory.\n'
	postgres_password=$(new_hex_secret 24)
	relay_pepper=$(new_hex_secret 32)
	relay_encryption_key=$(new_hex_secret 32)
	relay_invite_secret=$(new_hex_secret 32)
	relay_admin_token=$(new_hex_secret 24)
	relay_metrics_token=$(new_hex_secret 16)
fi

export AGENTRELAY_AZURE_NAME_PREFIX=$name_prefix
export AGENTRELAY_AZURE_RESOURCE_SUFFIX=$resource_suffix
export AGENTRELAY_AZURE_LOCATION=$location
export AGENTRELAY_AZURE_RELAY_IMAGE=$relay_image
export AGENTRELAY_AZURE_POSTGRES_LOGIN=$POSTGRES_LOGIN
export AGENTRELAY_AZURE_DEPLOYER_PRINCIPAL_ID=$deployer_principal_id
export AGENTRELAY_AZURE_POSTGRES_PASSWORD=$postgres_password
export AGENTRELAY_AZURE_RELAY_PEPPER=$relay_pepper
export AGENTRELAY_AZURE_RELAY_ENCRYPTION_KEY=$relay_encryption_key
export AGENTRELAY_AZURE_RELAY_INVITE_SECRET=$relay_invite_secret
export AGENTRELAY_AZURE_RELAY_ADMIN_TOKEN=$relay_admin_token
export AGENTRELAY_AZURE_RELAY_METRICS_TOKEN=$relay_metrics_token

if [[ "$mode" == 'plan' ]]; then
	printf 'Running Azure what-if (secure values are masked)...\n'
	az deployment group what-if \
		--name agentrelay-pilot-plan \
		--resource-group "$resource_group" \
		--parameters "$script_dir/main.bicepparam" \
		--only-show-errors
	exit 0
fi

deployment_name="agentrelay-pilot-$(date -u +%Y%m%d%H%M%S)"
printf 'Applying deployment %s...\n' "$deployment_name"
relay_url=$(az deployment group create \
	--name "$deployment_name" \
	--resource-group "$resource_group" \
	--parameters "$script_dir/main.bicepparam" \
	--only-show-errors \
	--query properties.outputs.relayUrl.value \
	--output tsv)

[[ "$relay_url" == https://* ]] || fail 'deployment completed without an HTTPS Relay URL output'
printf '\nRelay deployed: %s\n' "$relay_url"
printf 'Container App: %s\nKey Vault: %s\n' "$relay_name" "$key_vault_name"
printf 'Verify it with: %q %q\n' "$script_dir/smoke.sh" "$relay_url"
