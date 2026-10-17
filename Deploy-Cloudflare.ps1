$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = $PSScriptRoot
$configPath = Join-Path $projectRoot "wrangler.toml"
$wranglerPath = Join-Path $projectRoot ".local\wrangler\node_modules\.bin\wrangler.cmd"

if (-not (Test-Path -LiteralPath $wranglerPath -PathType Leaf)) {
    throw "Wrangler was not found. Run Start-Local.ps1 or install Wrangler into .local first."
}
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw "wrangler.toml was not found."
}

$config = Get-Content -LiteralPath $configPath -Raw
if ($config -notmatch '(?m)^name\s*=\s*"([^"]+)"') {
    throw "Could not find the Worker name in wrangler.toml."
}
$workerName = $Matches[1]
if ($config -match 'database_id\s*=\s*"00000000-0000-0000-0000-000000000000"') {
    throw "Set the production D1 database_id in wrangler.toml before deploying."
}
if ($config -notmatch '(?m)^database_name\s*=\s*"([^"]+)"') {
    throw "Could not find the D1 database name in wrangler.toml."
}
$databaseName = $Matches[1]

function Invoke-Wrangler {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    & $wranglerPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Wrangler command failed: wrangler $($Arguments -join ' ')"
    }
}

Write-Host "Checking Cloudflare authentication..." -ForegroundColor Cyan
Invoke-Wrangler -Arguments @("whoami")

Write-Host "Checking production Admin secrets for Worker '$workerName'..." -ForegroundColor Cyan
$secretOutput = & $wranglerPath secret list 2>&1
if ($LASTEXITCODE -ne 0) {
    $secretOutput | ForEach-Object { Write-Host $_ }
    throw "Could not list Worker secrets. Check Wrangler authentication."
}
try {
    $secrets = ($secretOutput -join "`n") | ConvertFrom-Json
}
catch {
    throw "Wrangler returned an unreadable secret list; refusing to deploy."
}
$secretNames = @($secrets | ForEach-Object { $_.name })
$requiredSecrets = @("ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET")
$missingSecrets = @($requiredSecrets | Where-Object { $_ -notin $secretNames })
if ($missingSecrets.Count -gt 0) {
    throw "Missing Worker secrets: $($missingSecrets -join ', '). Run Set-CloudflareSecrets.ps1 before deploying."
}

Write-Host "Applying pending migrations to remote D1 '$databaseName'..." -ForegroundColor Cyan
Invoke-Wrangler -Arguments @("d1", "migrations", "apply", $databaseName, "--remote")

Write-Host "Deploying Worker '$workerName'..." -ForegroundColor Cyan
Invoke-Wrangler -Arguments @("deploy")

$siteUrl = "https://$workerName.nvdandrip.workers.dev"
Write-Host "Checking deployed state API at $siteUrl/api/state..." -ForegroundColor Cyan
try {
    $response = Invoke-WebRequest -Uri "$siteUrl/api/state" -UseBasicParsing
}
catch {
    throw "Deployment completed, but the state API check failed: $($_.Exception.Message)"
}
if ([int]$response.StatusCode -ne 200) {
    throw "Deployment completed, but the state API returned HTTP $([int]$response.StatusCode)."
}

Write-Host "Deployment and health check succeeded: $siteUrl" -ForegroundColor Green
