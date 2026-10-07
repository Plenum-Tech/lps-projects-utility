<#
.SYNOPSIS
  Build + push the LPS – Projects Utility image to Azure Container Registry and
  create/update the Azure Container App (deploy/azure/containerapp.bicep).

.DESCRIPTION
  Run from the repository root after `az login` (and `az account set -s <subscription>`).
  Secrets are read from environment variables (never from files in the repo):
    LPS_MONGO_URI, LPS_JWT_SECRET, LPS_COOKIE_SECRET            (required)
    LPS_SMTP_USER, LPS_SMTP_PASS, LPS_GEMINI_API_KEY            (optional)
  Missing required secrets are prompted for (input hidden).

.EXAMPLE
  ./deploy/azure/deploy.ps1 -ResourceGroup rg-lps-prod -AcrName lpsacr -AppUrl https://lps.plenum-tech.com
.EXAMPLE
  # Local Docker build + push instead of a cloud build:
  ./deploy/azure/deploy.ps1 -ResourceGroup rg-lps-prod -AcrName lpsacr -AppUrl https://lps.plenum-tech.com -BuildMode docker
.EXAMPLE
  # Redeploy an existing tag (rollback / config change only):
  ./deploy/azure/deploy.ps1 -ResourceGroup rg-lps-prod -AcrName lpsacr -AppUrl https://lps.plenum-tech.com -Tag 1a2b3c4 -BuildMode none
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $ResourceGroup,
  [Parameter(Mandatory)] [string] $AcrName,
  [Parameter(Mandatory)] [string] $AppUrl,
  [string] $Location = 'centralindia',
  [string] $AppName = 'lps-projects-utility',
  [string] $Tag = '',
  [ValidateSet('acr', 'docker', 'none')] [string] $BuildMode = 'acr',
  [ValidateSet('1.0', '2.0')] [string] $Cpu = '2.0',
  [string] $AppTimezone = 'Asia/Kolkata',
  [string] $FromEmail = '',
  [string] $FromName = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

function Get-Secret([string] $envName, [string] $label, [bool] $required) {
  $value = [Environment]::GetEnvironmentVariable($envName)
  if (-not $value -and $required) {
    $secure = Read-Host -AsSecureString "$label ($envName)"
    $value = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  return $value
}

# --- Preconditions -----------------------------------------------------------
az account show --output none 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Not logged in: run `az login` (and `az account set -s <subscription>`) first.' }

if (-not $Tag) { $Tag = (git rev-parse --short HEAD).Trim() }
$image = "$AcrName.azurecr.io/lps-projects-utility:$Tag"
$memory = if ($Cpu -eq '2.0') { '4Gi' } else { '2Gi' }
Write-Host "Image: $image  (cpu $Cpu / $memory)" -ForegroundColor Cyan

# --- Resource group + registry -------------------------------------------------
if ((az group exists -n $ResourceGroup) -ne 'true') {
  az group create -n $ResourceGroup -l $Location --output none
}
az acr show -n $AcrName -g $ResourceGroup --output none 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating registry $AcrName (Basic)..." -ForegroundColor Cyan
  az acr create -n $AcrName -g $ResourceGroup --sku Basic --admin-enabled false --output none
}

# --- Build + push --------------------------------------------------------------
switch ($BuildMode) {
  'acr' {
    # Cloud build: uploads the context (minus .dockerignore) and builds in ACR.
    az acr build --registry $AcrName --image "lps-projects-utility:$Tag" --build-arg "APP_VERSION=$Tag" --file Dockerfile .
    if ($LASTEXITCODE -ne 0) { throw 'az acr build failed' }
  }
  'docker' {
    az acr login --name $AcrName
    docker build -t $image --build-arg "APP_VERSION=$Tag" .
    if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }
    docker push $image
    if ($LASTEXITCODE -ne 0) { throw 'docker push failed' }
  }
  'none' { Write-Host 'Skipping build (deploying an existing tag).' }
}

# --- Secrets ---------------------------------------------------------------------
$mongoUri = Get-Secret 'LPS_MONGO_URI' 'MongoDB connection string' $true
$jwtSecret = Get-Secret 'LPS_JWT_SECRET' 'JWT secret (>= 32 chars)' $true
$cookieSecret = Get-Secret 'LPS_COOKIE_SECRET' 'Cookie secret (>= 32 chars)' $true
$smtpUser = Get-Secret 'LPS_SMTP_USER' 'SMTP user' $false
$smtpPass = Get-Secret 'LPS_SMTP_PASS' 'SMTP password' $false
$gemini = Get-Secret 'LPS_GEMINI_API_KEY' 'Gemini API key' $false
foreach ($s in @(@('JWT secret', $jwtSecret), @('Cookie secret', $cookieSecret))) {
  if ($s[1].Length -lt 32) { throw "$($s[0]) must be at least 32 characters." }
}

# Parameters go through a temp file (deleted afterwards) so secrets never appear on a command line.
$paramsFile = Join-Path ([IO.Path]::GetTempPath()) "lps-deploy-$([Guid]::NewGuid()).json"
$parameters = @{
  '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
  contentVersion = '1.0.0.0'
  parameters     = @{
    appName      = @{ value = $AppName }
    acrName      = @{ value = $AcrName }
    imageTag     = @{ value = $Tag }
    cpu          = @{ value = $Cpu }
    memory       = @{ value = $memory }
    appUrl       = @{ value = $AppUrl.TrimEnd('/') }
    appTimezone  = @{ value = $AppTimezone }
    fromEmail    = @{ value = $FromEmail }
    fromName     = @{ value = $FromName }
    mongoUri     = @{ value = $mongoUri }
    jwtSecret    = @{ value = $jwtSecret }
    cookieSecret = @{ value = $cookieSecret }
    smtpUser     = @{ value = "$smtpUser" }
    smtpPass     = @{ value = "$smtpPass" }
    geminiApiKey = @{ value = "$gemini" }
  }
}
try {
  $parameters | ConvertTo-Json -Depth 5 | Set-Content -Path $paramsFile -Encoding utf8
  az deployment group create `
    --resource-group $ResourceGroup `
    --name "lps-$Tag-$(Get-Date -Format yyyyMMddHHmmss)" `
    --template-file deploy/azure/containerapp.bicep `
    --parameters "@$paramsFile" `
    --query 'properties.outputs.url.value' --output tsv
  if ($LASTEXITCODE -ne 0) { throw 'Deployment failed' }
}
finally {
  Remove-Item -Force $paramsFile -ErrorAction SilentlyContinue
}

Write-Host "Deployed $image. Check: curl https://<fqdn>/api/health" -ForegroundColor Green
