$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $releaseRoot

# This bootstrap is only for a fresh CI checkout, never an existing runtime.
foreach ($configName in @('.env', '.env.local', '.env.qq', '.env.test')) {
    if (Test-Path -LiteralPath (Join-Path $releaseRoot $configName)) {
        throw "Public CI requires a fresh checkout without $configName"
    }
}
if (Test-Path -LiteralPath (Join-Path $releaseRoot 'data')) {
    throw 'Public CI requires a fresh checkout without data/'
}

Get-ChildItem Env: | Where-Object {
    $_.Name -match 'KEY|TOKEN|SECRET|PASSWORD' -or
    $_.Name -match '^(OPENAI_|CHARACTER_|QQ_|M55_|PGLITE_|PROJECT_LG_|TEST_)' -or
    $_.Name -in @('POSTGRES_URL', 'DATABASE_URL', 'USER_NAME')
} | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$env:CI = 'true'
$env:NO_COLOR = '1'
$env:PROMPTFOO_DISABLE_TELEMETRY = '1'
# Read-only CLI assembly checks key presence but does not call a model.
$env:OPENAI_API_KEY = 'offline'
$env:OPENAI_BASE_URL = 'http://127.0.0.1:9/v1'
$env:OPENAI_LARGE_MODEL = 'public-offline-fixture'
$env:OPENAI_SMALL_MODEL = 'public-offline-fixture'
$env:USER_NAME = 'Alex'

# A local empty .env stops plugin-sql from loading any ancestor checkout's .env.
$ciEnvPath = Join-Path $releaseRoot '.env'
$ciEnvMarker = "# public-ci empty environment`n"
[System.IO.File]::WriteAllText($ciEnvPath, $ciEnvMarker)
try {
    # No source runtime database, conversations, or model calls are used.
    pnpm db:init
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    pnpm migrate:apply
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    pnpm m4.5:ci
    exit $LASTEXITCODE
} finally {
    if ([System.IO.File]::ReadAllText($ciEnvPath) -eq $ciEnvMarker) {
        Remove-Item -LiteralPath $ciEnvPath
    }
}
