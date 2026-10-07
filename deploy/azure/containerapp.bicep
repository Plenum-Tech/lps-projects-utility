// LPS – Projects Utility on Azure Container Apps (see DEPLOY-AZURE.md).
//
// Creates: Log Analytics workspace, Container Apps environment, a user-assigned
// identity with AcrPull on the (existing) Azure Container Registry, and the
// Container App (external HTTPS ingress → :8080, health probes, secrets, env).
//
//   az deployment group create -g <rg> -f deploy/azure/containerapp.bicep \
//     -p acrName=<acr> imageTag=<tag> appUrl=https://<host> \
//        mongoUri=<secret> jwtSecret=<secret> cookieSecret=<secret> ...
//
// Secrets are passed as @secure() parameters and stored as Container App secrets
// (referenced by env vars via secretRef) — never baked into the image.

@description('Azure region (defaults to the resource group\'s).')
param location string = resourceGroup().location

@description('Container App name (also used as a prefix for the other resources).')
param appName string = 'lps-projects-utility'

@description('Existing Azure Container Registry name (without .azurecr.io), in this resource group.')
param acrName string

@description('Image repository in the registry.')
param imageRepository string = 'lps-projects-utility'

@description('Image tag to deploy (e.g. the git short SHA).')
param imageTag string

@description('vCPU per replica. 1.0 is the tested minimum for 150 users; 2.0 gives headroom (see DEPLOY-AZURE.md).')
@allowed(['0.5', '0.75', '1.0', '1.25', '1.5', '1.75', '2.0', '2.5', '3.0', '3.5', '4.0'])
param cpu string = '1.0'

@description('Memory per replica (must match the vCPU ratio: 1.0 → 2Gi, 2.0 → 4Gi).')
param memory string = '2Gi'

@description('Keep 1/1: SSE fan-out and rate limits are in-memory (one replica).')
@minValue(1)
param minReplicas int = 1
@minValue(1)
param maxReplicas int = 1

// ---- Plain configuration ---------------------------------------------------
@description('Public HTTPS URL of the app (custom domain or the *.azurecontainerapps.io FQDN), no trailing slash.')
param appUrl string
param appTimezone string = 'Asia/Kolkata'
param smtpHost string = 'smtp.office365.com'
param smtpPort string = '587'
param smtpSecure string = 'false'
param fromName string = ''
param fromEmail string = ''
param mongoMaxPool string = '50'
param aiReviewDrafts string = 'false'
param meetingAiExtraction string = 'false'

// ---- Secrets ---------------------------------------------------------------
@secure()
@description('MongoDB connection string (Atlas / Cosmos DB for MongoDB vCore / self-managed).')
param mongoUri string
@secure()
@minLength(32)
param jwtSecret string
@secure()
@minLength(32)
param cookieSecret string
@secure()
param smtpUser string = ''
@secure()
param smtpPass string = ''
@secure()
param geminiApiKey string = ''

var acrLoginServer = '${acrName}.azurecr.io'
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-acr-pull'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, pullIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

var secrets = concat(
  [
    { name: 'mongo-uri', value: mongoUri }
    { name: 'jwt-secret', value: jwtSecret }
    { name: 'cookie-secret', value: cookieSecret }
  ],
  empty(smtpUser) ? [] : [{ name: 'smtp-user', value: smtpUser }],
  empty(smtpPass) ? [] : [{ name: 'smtp-pass', value: smtpPass }],
  empty(geminiApiKey) ? [] : [{ name: 'gemini-api-key', value: geminiApiKey }]
)

var envVars = concat(
  [
    { name: 'MONGO_URI', secretRef: 'mongo-uri' }
    { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
    { name: 'COOKIE_SECRET', secretRef: 'cookie-secret' }
    { name: 'APP_URL', value: appUrl }
    { name: 'API_PUBLIC_URL', value: appUrl }
    { name: 'CORS_ORIGIN', value: appUrl }
    { name: 'APP_TIMEZONE', value: appTimezone }
    { name: 'TRUST_PROXY', value: '1' }
    { name: 'JOBS_MODE', value: 'in-process' }
    { name: 'MONGO_MAX_POOL', value: mongoMaxPool }
    { name: 'EMAIL_REDIRECT_TO', value: '' }
    { name: 'SMTP_HOST', value: smtpHost }
    { name: 'SMTP_PORT', value: smtpPort }
    { name: 'SMTP_SECURE', value: smtpSecure }
    { name: 'FROM_NAME', value: fromName }
    { name: 'FROM_EMAIL', value: fromEmail }
    { name: 'AI_REVIEW_DRAFTS', value: aiReviewDrafts }
    { name: 'MEETING_AI_EXTRACTION', value: meetingAiExtraction }
    { name: 'APP_VERSION', value: imageTag }
  ],
  empty(smtpUser) ? [] : [{ name: 'SMTP_USER', secretRef: 'smtp-user' }],
  empty(smtpPass) ? [] : [{ name: 'SMTP_PASS', secretRef: 'smtp-pass' }],
  empty(geminiApiKey) ? [] : [{ name: 'GEMINI_API_KEY', secretRef: 'gemini-api-key' }]
)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  dependsOn: [acrPull]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: pullIdentity.id
        }
      ]
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: 'app'
          image: '${acrLoginServer}/${imageRepository}:${imageTag}'
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: envVars
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/api/health', port: 8080 }
              initialDelaySeconds: 3
              periodSeconds: 5
              failureThreshold: 24 // up to ~2 min for the first index build / DB connect
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 8080 }
              periodSeconds: 30
              failureThreshold: 5 // a ~2.5 min DB outage restarts the replica
              timeoutSeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output url string = 'https://${app.properties.configuration.ingress.fqdn}'
output logAnalyticsWorkspace string = logs.name
