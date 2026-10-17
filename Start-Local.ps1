$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$projectRoot = $PSScriptRoot
Set-Location $projectRoot

function Stop-OnNativeFailure {
    param([string]$CommandName)

    if ($LASTEXITCODE -ne 0) {
        throw "$CommandName failed with exit code $LASTEXITCODE."
    }
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand -and (Test-Path "C:\Program Files\nodejs\node.exe")) {
    $nodeFolder = "C:\Program Files\nodejs"
    $env:Path = "$nodeFolder;$env:Path"
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
}
if (-not $nodeCommand) {
    throw "Node.js was not found in PATH. Open a new terminal or install Node.js in C:\Program Files\nodejs."
}

$nodeVersionText = (& $nodeCommand.Source --version).Trim()
if ($nodeVersionText -notmatch "^v(\d+)\.") {
    throw "Could not read the Node.js version: $nodeVersionText"
}
if ([int]$Matches[1] -lt 22) {
    throw "The current Wrangler release requires Node.js 22 or later. Detected: $nodeVersionText"
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand -and (Test-Path "C:\Program Files\nodejs\npm.cmd")) {
    $npmCommand = Get-Item "C:\Program Files\nodejs\npm.cmd"
}
if (-not $npmCommand) {
    throw "Could not find npm.cmd in the Node.js installation."
}
$npmPath = if ($npmCommand.Source) { $npmCommand.Source } else { $npmCommand.FullName }

$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
}
if (-not $pythonCommand) {
    throw "Python 3 is required to import the workbook. Install Python 3 and try again."
}

$referenceDirectory = Join-Path $projectRoot "temp refer"
$workbooks = @(Get-ChildItem -LiteralPath $referenceDirectory -Filter "*.xlsx" -File -ErrorAction SilentlyContinue)
if ($workbooks.Count -ne 1) {
    throw "Expected exactly one .xlsx workbook in the temp refer folder. Found $($workbooks.Count)."
}
$workbookPath = $workbooks[0].FullName

$devVarsPath = Join-Path $projectRoot ".dev.vars"
if (-not (Test-Path -LiteralPath $devVarsPath -PathType Leaf)) {
    Write-Host "Creating local Admin settings in .dev.vars (this file is git-ignored)." -ForegroundColor Cyan
    $securePassword = Read-Host "Enter a new local Admin password" -AsSecureString
    if ($securePassword.Length -lt 1) {
        throw "The Admin password must contain at least 1 character."
    }

    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }

    if ($password.Contains("`r") -or $password.Contains("`n")) {
        throw "The password cannot contain a newline."
    }

    $secretBytes = New-Object byte[] 48
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($secretBytes)
    }
    finally {
        $random.Dispose()
    }
    $sessionSecret = [Convert]::ToBase64String($secretBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    $devVars = @(
        "ADMIN_USERNAME=admin"
        "ADMIN_PASSWORD=$password"
        "ADMIN_SESSION_SECRET=$sessionSecret"
    ) -join "`n"
    [IO.File]::WriteAllText($devVarsPath, "$devVars`n", [Text.UTF8Encoding]::new($false))
    $password = $null
    $securePassword.Dispose()
}

$devVarsText = Get-Content -LiteralPath $devVarsPath -Raw
$restorePasswordMatch = [regex]::Match($devVarsText, '(?m)^HISTORY_RESTORE_PASSWORD=(.*)$')
if (-not $restorePasswordMatch.Success -or [string]::IsNullOrEmpty($restorePasswordMatch.Groups[1].Value)) {
    $adminPasswordMatch = [regex]::Match($devVarsText, '(?m)^ADMIN_PASSWORD=(.*)$')
    if (-not $adminPasswordMatch.Success) {
        throw ".dev.vars is missing ADMIN_PASSWORD; cannot configure the separate restore password."
    }

    $secureRestorePassword = Read-Host "Enter a separate local history-restore password" -AsSecureString
    $restorePasswordPointer = [IntPtr]::Zero
    $restorePassword = $null
    try {
        if ($secureRestorePassword.Length -lt 1) {
            throw "The history-restore password must contain at least 1 character."
        }
        $restorePasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureRestorePassword)
        $restorePassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($restorePasswordPointer)
        if ($restorePassword.Contains("`r") -or $restorePassword.Contains("`n")) {
            throw "The password cannot contain a newline."
        }
        if ([string]::Equals($restorePassword, $adminPasswordMatch.Groups[1].Value, [System.StringComparison]::Ordinal)) {
            throw "The history-restore password must differ from the Admin password."
        }

        $separator = if ($devVarsText.EndsWith("`n")) { "" } else { "`n" }
        [IO.File]::AppendAllText(
            $devVarsPath,
            "${separator}HISTORY_RESTORE_PASSWORD=$restorePassword`n",
            [Text.UTF8Encoding]::new($false)
        )
    }
    finally {
        if ($restorePasswordPointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($restorePasswordPointer)
        }
        $restorePassword = $null
        $secureRestorePassword.Dispose()
    }
    $devVarsText = Get-Content -LiteralPath $devVarsPath -Raw
}

$requiredVariables = @("ADMIN_USERNAME", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET", "HISTORY_RESTORE_PASSWORD")
foreach ($variable in $requiredVariables) {
    if ($devVarsText -notmatch "(?m)^$variable=.+$") {
        throw ".dev.vars is missing ${variable}. Add it and run the script again."
    }
}
$adminPasswordValue = [regex]::Match($devVarsText, '(?m)^ADMIN_PASSWORD=(.*)$').Groups[1].Value
$restorePasswordValue = [regex]::Match($devVarsText, '(?m)^HISTORY_RESTORE_PASSWORD=(.*)$').Groups[1].Value
if ([string]::Equals($adminPasswordValue, $restorePasswordValue, [System.StringComparison]::Ordinal)) {
    throw "HISTORY_RESTORE_PASSWORD must differ from ADMIN_PASSWORD."
}
$adminPasswordValue = $null
$restorePasswordValue = $null
$devVarsText = $null

$localDirectory = Join-Path $projectRoot ".local"
New-Item -ItemType Directory -Path $localDirectory -Force | Out-Null
$importSqlPath = Join-Path $localDirectory "initial-detail.sql"
$wranglerDirectory = Join-Path $localDirectory "wrangler"
$wranglerPath = Join-Path $wranglerDirectory "node_modules\.bin\wrangler.cmd"
$workerdPath = Join-Path $wranglerDirectory "node_modules\.bin\workerd.cmd"

if (-not (Test-Path -LiteralPath $wranglerPath -PathType Leaf)) {
    Write-Host "Installing Wrangler in .local (git-ignored)..." -ForegroundColor Cyan
    & $npmPath install --prefix $wranglerDirectory --no-audit --no-fund wrangler@4
    Stop-OnNativeFailure "Installing Wrangler"
}

& $workerdPath --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Preparing Wrangler's Windows runtime..." -ForegroundColor Cyan
    Push-Location $wranglerDirectory
    try {
        & $npmPath install-scripts approve esbuild workerd --allow-scripts-pin
        Stop-OnNativeFailure "Approving Wrangler runtime installation scripts"
    }
    finally {
        Pop-Location
    }

    & $npmPath rebuild --prefix $wranglerDirectory --no-audit --no-fund
    Stop-OnNativeFailure "Preparing Wrangler's Windows runtime"
    & $workerdPath --version
    Stop-OnNativeFailure "Verifying Wrangler's Windows runtime"
}

Write-Host "Node.js $nodeVersionText" -ForegroundColor Green
Write-Host "Applying D1 migrations to the local database..." -ForegroundColor Cyan
& $wranglerPath d1 migrations apply dainv13-group-expenses --local
Stop-OnNativeFailure "Applying local D1 migrations"

Write-Host "Importing the Detail worksheet into local D1..." -ForegroundColor Cyan
& $pythonCommand.Source (Join-Path $projectRoot "tools\import_detail.py") $workbookPath --output $importSqlPath
Stop-OnNativeFailure "Generating the local workbook import"
& $wranglerPath d1 execute dainv13-group-expenses --local --file $importSqlPath
Stop-OnNativeFailure "Importing the workbook into local D1"

Write-Host ""
Write-Host "Starting the website. Open the local URL Wrangler prints; press Ctrl+C to stop." -ForegroundColor Green
& $wranglerPath dev
