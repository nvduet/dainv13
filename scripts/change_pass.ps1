$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
# Windows PowerShell 5.1 pipes strings to native commands as US-ASCII, which turns Vietnamese letters
# into "?"; send the secrets to wrangler as UTF-8 (no BOM) instead.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
if (-not $npxCommand) {
    $nodeNpx = Join-Path $env:ProgramFiles "nodejs\npx.cmd"
    if (Test-Path -LiteralPath $nodeNpx) {
        $npxCommand = Get-Item -LiteralPath $nodeNpx
    }
}
$wranglerCommand = Get-Command wrangler.cmd -ErrorAction SilentlyContinue
if (-not $wranglerCommand) {
    $globalWrangler = Join-Path $env:APPDATA "npm\wrangler.cmd"
    if (Test-Path -LiteralPath $globalWrangler) {
        $wranglerCommand = Get-Item -LiteralPath $globalWrangler
    }
}
if (-not $nodeCommand -and -not $wranglerCommand) {
    throw "Node.js and npm are required. Install Node.js 22 or later to use Wrangler."
}
if (-not $npxCommand -and -not $wranglerCommand) {
    throw "Node.js and npm are required. Install Node.js 22 or later to use Wrangler."
}

function Set-WorkerSecret {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    Push-Location $projectRoot
    try {
        if ($wranglerCommand) {
            $Value | & $wranglerCommand.Source secret put $Name
        }
        else {
            $Value | & $npxCommand.Source --yes wrangler@4 secret put $Name
        }
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "Could not set Cloudflare Worker secret $Name."
    }
}

$username = Read-Host "Production Admin username"
if ([string]::IsNullOrEmpty($username)) {
    throw "The username cannot be empty."
}

$securePassword = $null
$secureOperationsPassword = $null
$passwordPointer = [IntPtr]::Zero
$operationsPasswordPointer = [IntPtr]::Zero
$password = $null
$operationsPassword = $null
$sessionSecret = $null
try {
    $securePassword = Read-Host "New production Admin password" -AsSecureString
    if ($securePassword.Length -eq 0) {
        throw "The Admin password cannot be empty."
    }

    # Stored as HISTORY_RESTORE_PASSWORD (name kept so nothing else needs reconfiguring).
    $secureOperationsPassword = Read-Host "New operations password for creating/deleting ledgers, Store and restore (different from the Admin password)" -AsSecureString
    if ($secureOperationsPassword.Length -eq 0) {
        throw "The operations password cannot be empty."
    }

    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    $operationsPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureOperationsPassword)
    $operationsPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($operationsPasswordPointer)
    if ([string]::Equals($password, $operationsPassword, [StringComparison]::Ordinal)) {
        throw "The operations password must differ from the Admin password."
    }

    $sessionBytes = New-Object byte[] 48
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($sessionBytes)
    }
    finally {
        $random.Dispose()
    }
    $sessionSecret = [Convert]::ToBase64String($sessionBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    [Array]::Clear($sessionBytes, 0, $sessionBytes.Length)

    Set-WorkerSecret -Name "ADMIN_USERNAME" -Value $username
    Set-WorkerSecret -Name "ADMIN_PASSWORD" -Value $password
    Set-WorkerSecret -Name "ADMIN_SESSION_SECRET" -Value $sessionSecret
    Set-WorkerSecret -Name "HISTORY_RESTORE_PASSWORD" -Value $operationsPassword
}
finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    if ($operationsPasswordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($operationsPasswordPointer)
    }
    $password = $null
    $operationsPassword = $null
    $sessionSecret = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    if ($null -ne $secureOperationsPassword) { $secureOperationsPassword.Dispose() }
}

Write-Host "Production Admin and operations password secrets were set in Cloudflare Workers." -ForegroundColor Green
