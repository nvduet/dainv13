$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "wrangler.toml"
$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue

if (-not $npxCommand) {
    throw "Node.js and npm are required. Install Node.js 22 or later to use Wrangler."
}
if (-not $nodeCommand) {
    throw "Node.js is required to run the local tests. Install Node.js 22.13 or later."
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

    Push-Location $projectRoot
    try {
        & $npxCommand.Source --yes wrangler@4 @Arguments
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "Wrangler command failed: wrangler $($Arguments -join ' ')"
    }
}

Write-Host "Running local tests..." -ForegroundColor Cyan
Push-Location $projectRoot
# Without node:sqlite (Node.js older than 22.13) the integration suites fail here instead of being skipped.
$env:REQUIRE_NODE_SQLITE = "1"
try {
    & $nodeCommand.Source --test
    $testExitCode = $LASTEXITCODE
}
finally {
    Remove-Item -Path Env:\REQUIRE_NODE_SQLITE -ErrorAction SilentlyContinue
    Pop-Location
}
if ($testExitCode -ne 0) {
    throw "Local tests failed; refusing to deploy."
}

Write-Host "Checking Cloudflare authentication..." -ForegroundColor Cyan
Invoke-Wrangler -Arguments @("whoami")

Write-Host "Checking production Admin secrets for Worker '$workerName'..." -ForegroundColor Cyan
# Under "Stop", Windows PowerShell 5.1 aborts on the first stderr line of a native command captured with
# 2>&1 (any npm or wrangler notice). Capture with "Continue" and keep only stdout for the JSON.
Push-Location $projectRoot
$previousErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $secretOutput = @(& $npxCommand.Source --yes wrangler@4 secret list 2>&1)
    $secretExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
}
$secretErrors = @($secretOutput | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
$secretJson = @($secretOutput | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
$secretErrors | ForEach-Object { Write-Host $_ }
if ($secretExitCode -ne 0) {
    $secretJson | ForEach-Object { Write-Host $_ }
    throw "Could not list Worker secrets. Check Wrangler authentication."
}
try {
    $secrets = ($secretJson -join "`n") | ConvertFrom-Json
}
catch {
    throw "Wrangler returned an unreadable secret list; refusing to deploy."
}
$secretNames = @($secrets | ForEach-Object { $_.name })
$requiredSecrets = @("ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "HISTORY_RESTORE_PASSWORD")
$missingSecrets = @($requiredSecrets | Where-Object { $_ -notin $secretNames })
if ($missingSecrets.Count -gt 0) {
    if ("HISTORY_RESTORE_PASSWORD" -in $missingSecrets) {
        throw "Missing Worker secret HISTORY_RESTORE_PASSWORD (the operations password). Run .\scripts\change_pass.ps1 to set the Admin password and the operations password before deploying."
    }
    throw "Missing Worker secrets: $($missingSecrets -join ', '). Run .\scripts\change_pass.ps1 before deploying."
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
