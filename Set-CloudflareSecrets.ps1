$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = $PSScriptRoot
$wranglerPath = Join-Path $projectRoot ".local\wrangler\node_modules\.bin\wrangler.cmd"
if (-not (Test-Path -LiteralPath $wranglerPath -PathType Leaf)) {
    throw "Wrangler was not found. Run Start-Local.ps1 or install Wrangler into .local first."
}

function Set-WorkerSecret {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $Value | & $wranglerPath secret put $Name
    if ($LASTEXITCODE -ne 0) {
        throw "Could not set Cloudflare Worker secret $Name."
    }
}

$username = Read-Host "Production Admin username (default: admin)"
if ([string]::IsNullOrWhiteSpace($username)) {
    $username = "admin"
}
if ($username.Contains("`r") -or $username.Contains("`n")) {
    throw "The username cannot contain a newline."
}

$securePassword = $null
$secureRestorePassword = $null
$passwordPointer = [IntPtr]::Zero
$restorePasswordPointer = [IntPtr]::Zero
$password = $null
$restorePassword = $null
$sessionSecret = $null
try {
    $securePassword = Read-Host "New production Admin password (at least 1 character)" -AsSecureString
    if ($securePassword.Length -lt 1) {
        throw "The Admin password must contain at least 1 character."
    }

    $secureRestorePassword = Read-Host "New separate history-restore password (at least 1 character)" -AsSecureString
    if ($secureRestorePassword.Length -lt 1) {
        throw "The history-restore password must contain at least 1 character."
    }

    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ($password.Contains("`r") -or $password.Contains("`n")) {
        throw "The Admin password cannot contain a newline."
    }

    $restorePasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureRestorePassword)
    $restorePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($restorePasswordPointer)
    if ($restorePassword.Contains("`r") -or $restorePassword.Contains("`n")) {
        throw "The history-restore password cannot contain a newline."
    }
    if ([string]::Equals($password, $restorePassword, [StringComparison]::Ordinal)) {
        throw "The history-restore password must differ from the Admin password."
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
    Set-WorkerSecret -Name "HISTORY_RESTORE_PASSWORD" -Value $restorePassword
}
finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    if ($restorePasswordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($restorePasswordPointer)
    }
    $password = $null
    $restorePassword = $null
    $sessionSecret = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    if ($null -ne $secureRestorePassword) { $secureRestorePassword.Dispose() }
}

Write-Host "Production Admin and history-restore secrets were set in Cloudflare Workers." -ForegroundColor Green
