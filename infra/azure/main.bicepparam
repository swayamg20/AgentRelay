using './main.bicep'

param namePrefix = readEnvironmentVariable('AGENTRELAY_AZURE_NAME_PREFIX')
param resourceSuffix = readEnvironmentVariable('AGENTRELAY_AZURE_RESOURCE_SUFFIX')
param location = readEnvironmentVariable('AGENTRELAY_AZURE_LOCATION')
param relayImage = readEnvironmentVariable('AGENTRELAY_AZURE_RELAY_IMAGE')
param postgresAdministratorLogin = readEnvironmentVariable('AGENTRELAY_AZURE_POSTGRES_LOGIN')
param deployerPrincipalId = readEnvironmentVariable('AGENTRELAY_AZURE_DEPLOYER_PRINCIPAL_ID')
param postgresAdminPassword = readEnvironmentVariable('AGENTRELAY_AZURE_POSTGRES_PASSWORD')
param relayPepper = readEnvironmentVariable('AGENTRELAY_AZURE_RELAY_PEPPER')
param relayEncryptionKey = readEnvironmentVariable('AGENTRELAY_AZURE_RELAY_ENCRYPTION_KEY')
param relayInviteSecret = readEnvironmentVariable('AGENTRELAY_AZURE_RELAY_INVITE_SECRET')
param relayAdminToken = readEnvironmentVariable('AGENTRELAY_AZURE_RELAY_ADMIN_TOKEN')
param relayMetricsToken = readEnvironmentVariable('AGENTRELAY_AZURE_RELAY_METRICS_TOKEN')
