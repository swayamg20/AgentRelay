targetScope = 'resourceGroup'

@description('Lowercase product prefix used in resource names.')
@minLength(3)
@maxLength(12)
param namePrefix string

@description('Stable eight-character lowercase hexadecimal suffix for globally unique names.')
@minLength(8)
@maxLength(8)
param resourceSuffix string

@description('Azure region for every regional resource.')
param location string = resourceGroup().location

@description('Pinned public Relay container image. Prefer an immutable digest.')
param relayImage string

@description('PostgreSQL administrator login used by the pilot migration runner and Relay.')
param postgresAdministratorLogin string = 'agentrelay_admin'

@description('Object ID of the human or service principal running deployments.')
param deployerPrincipalId string

@secure()
param postgresAdminPassword string

@secure()
param relayPepper string

@secure()
param relayEncryptionKey string

@secure()
param relayInviteSecret string

@secure()
param relayAdminToken string

@secure()
param relayMetricsToken string

var stem = '${namePrefix}-${resourceSuffix}'
var relayName = '${stem}-relay'
var keyVaultName = '${stem}-kv'
var privateDnsZoneName = '${stem}.postgres.database.azure.com'
var tags = {
  application: 'AgentRelay'
  environment: 'pilot'
  managedBy: 'Bicep'
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${stem}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.42.0.0/24'
      ]
    }
  }
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: virtualNetwork
  name: 'container-apps'
  properties: {
    addressPrefix: '10.42.0.0/27'
    delegations: [
      {
        name: 'Microsoft.App-environments'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: virtualNetwork
  name: 'postgres'
  properties: {
    addressPrefix: '10.42.0.32/28'
    delegations: [
      {
        name: 'Microsoft.DBforPostgreSQL-flexibleServers'
        properties: {
          serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
        }
      }
    ]
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneName
  location: 'global'
  tags: tags
}

resource privateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZone
  name: 'agentrelay-vnet'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork.id
    }
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${stem}-pg'
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdministratorLogin
    administratorLoginPassword: postgresAdminPassword
    version: '16'
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: privateDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      storageSizeGB: 32
    }
  }
  dependsOn: [
    privateDnsLink
  ]
}

resource postgresDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'agentrelay'
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// Azure blocks CREATE EXTENSION until each extension is explicitly allowlisted.
resource postgresExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    source: 'user-override'
    value: 'citext,pgcrypto'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${stem}-logs'
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource relayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${stem}-identity'
  location: location
  tags: tags
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: false
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

var keyVaultSecretsUserRole = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource relayKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, relayIdentity.id, keyVaultSecretsUserRole)
  scope: keyVault
  properties: {
    principalId: relayIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

resource deployerKeyVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  // A stable name makes a principal change fail closed instead of silently
  // retaining the old deployer's secret access in incremental deployments.
  name: guid(keyVault.id, 'agentrelay-deployer-secrets-user', keyVaultSecretsUserRole)
  scope: keyVault
  properties: {
    principalId: deployerPrincipalId
    roleDefinitionId: keyVaultSecretsUserRole
  }
}

var databaseUrl = 'postgresql://${postgresAdministratorLogin}:${postgresAdminPassword}@${postgres.properties.fullyQualifiedDomainName}:5432/agentrelay?sslmode=verify-full'

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'relay-database-url'
  properties: {
    value: databaseUrl
  }
}

// Retained separately so deploy.sh can reuse the database credential without
// parsing the connection URL during a safe redeployment.
resource postgresPasswordSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'postgres-admin-password'
  properties: {
    value: postgresAdminPassword
  }
}

resource pepperSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'relay-pepper'
  properties: {
    value: relayPepper
  }
}

resource encryptionKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'relay-encryption-key'
  properties: {
    value: relayEncryptionKey
  }
}

resource inviteSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'relay-invite-secret'
  properties: {
    value: relayInviteSecret
  }
}

resource adminTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'relay-admin-token'
  properties: {
    value: relayAdminToken
  }
}

resource metricsTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'relay-metrics-token'
  properties: {
    value: relayMetricsToken
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: '${stem}-cae'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnet.id
      internal: false
    }
    zoneRedundant: false
  }
}

var relayPublicUrl = 'https://${relayName}.${containerEnvironment.properties.defaultDomain}'

resource relay 'Microsoft.App/containerApps@2025-01-01' = {
  name: relayName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${relayIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 8080
        transport: 'auto'
      }
      secrets: [
        {
          identity: relayIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${databaseUrlSecret.name}'
          name: 'database-url'
        }
        {
          identity: relayIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${pepperSecret.name}'
          name: 'pepper'
        }
        {
          identity: relayIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${encryptionKeySecret.name}'
          name: 'encryption-key'
        }
        {
          identity: relayIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${inviteSecret.name}'
          name: 'invite-secret'
        }
        {
          identity: relayIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${adminTokenSecret.name}'
          name: 'admin-token'
        }
        {
          identity: relayIdentity.id
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${metricsTokenSecret.name}'
          name: 'metrics-token'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'relay'
          image: relayImage
          env: [
            {
              name: 'RELAY_DATABASE_URL'
              secretRef: 'database-url'
            }
            {
              name: 'RELAY_PEPPER'
              secretRef: 'pepper'
            }
            {
              name: 'RELAY_ENCRYPTION_KEY'
              secretRef: 'encryption-key'
            }
            {
              name: 'RELAY_INVITE_SECRET'
              secretRef: 'invite-secret'
            }
            {
              name: 'RELAY_ADMIN_TOKEN'
              secretRef: 'admin-token'
            }
            {
              name: 'RELAY_METRICS_TOKEN'
              secretRef: 'metrics-token'
            }
            {
              name: 'RELAY_PUBLIC_URL'
              value: relayPublicUrl
            }
            {
              name: 'RELAY_ENV'
              value: 'production'
            }
            {
              name: 'RELAY_LOG_LEVEL'
              value: 'info'
            }
            {
              name: 'RELAY_PORT'
              value: '8080'
            }
            {
              name: 'RELAY_AUDIT_RETENTION_DAYS'
              value: '90'
            }
            {
              name: 'RELAY_RATE_LIMIT_PER_MIN'
              value: '60'
            }
            {
              name: 'RELAY_DB_POOL_SIZE'
              value: '5'
            }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 20
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 10
              successThreshold: 1
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
              successThreshold: 1
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: 8080
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 10
              successThreshold: 1
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    postgresDatabase
    postgresExtensions
    relayKeyVaultAccess
  ]
}

output relayUrl string = relayPublicUrl
output relayName string = relay.name
output containerEnvironmentName string = containerEnvironment.name
output keyVaultName string = keyVault.name
output postgresServerName string = postgres.name
output deployedRelayImage string = relayImage
