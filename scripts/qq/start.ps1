param([switch]$CheckOnly, [switch]$PreflightOnly)
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Production database preflight (2026-10-15)
# ---------------------------------------------------------------------------
# Why this exists: on 2026-10-15 20:12:45 Docker Desktop restarted. The QQ
# gateway came back by itself (restart policy unless-stopped) but the
# production PostgreSQL container did NOT, because it was pinned to
# restart "no" (scripts/postgresql/compose.production.yml). The core then
# failed its very first identity read-back on 127.0.0.1:55432, refused to
# open the database (that refusal is the designed fail-closed guard), exited
# with code 1, and the QQ entry surfaced it only as "lg_bridge_exit_1".
#
# This check turns that silent-late failure into a named error before any
# QQ startup work happens. It never guesses the target: an unresolvable
# container name or port is a named rejection, not a fallback default.
#
# Messages are ASCII on purpose. start.cmd launches this file through
# powershell.exe (Windows PowerShell 5.1), which decodes a BOM-less .ps1 with
# the OEM code page (936 here) -- non-ASCII text would be mangled on the way in
# and has already caused a real byte-loss incident elsewhere in this repo.
# ---------------------------------------------------------------------------

function Get-LgEnvValue {
  param([string]$Key)
  $lgFile = Join-Path $lgQqRoot '.env'
  if (!(Test-Path -LiteralPath $lgFile)) { return '' }
  $lgPrefix = $Key + '='
  $lgLine = [System.IO.File]::ReadAllLines($lgFile) | Where-Object { $_.StartsWith($lgPrefix) } | Select-Object -First 1
  if ($null -eq $lgLine) { return '' }
  return $lgLine.Substring($lgPrefix.Length).Trim()
}

function Get-LgProductionDatabaseTarget {
  # Process environment wins over .env, mirroring how the core itself resolves
  # LG_PG_CONTAINER; neither present means we refuse rather than assume.
  $lgContainer = ''
  if ($env:LG_PG_CONTAINER) { $lgContainer = $env:LG_PG_CONTAINER.Trim() }
  if ($lgContainer -eq '') { $lgContainer = Get-LgEnvValue 'LG_PG_CONTAINER' }
  if ($lgContainer -eq '') {
    throw 'lg_pg_container_unresolved: set LG_PG_CONTAINER=<container name> in .env or in the environment before starting the QQ entry'
  }
  $lgUrl = ''
  if ($env:POSTGRES_URL) { $lgUrl = $env:POSTGRES_URL.Trim() }
  if ($lgUrl -eq '') { $lgUrl = Get-LgEnvValue 'POSTGRES_URL' }
  if ($lgUrl -eq '') {
    throw 'lg_pg_url_unresolved: set POSTGRES_URL in .env or in the environment before starting the QQ entry'
  }
  $lgParsed = [System.Uri]$lgUrl
  if ($lgParsed.Scheme -ne 'postgres' -and $lgParsed.Scheme -ne 'postgresql') {
    throw "lg_pg_url_not_postgres: POSTGRES_URL scheme is '$($lgParsed.Scheme)', expected postgres or postgresql"
  }
  return [pscustomobject]@{ Container = $lgContainer; Port = $lgParsed.Port }
}

function Test-LgLoopbackPort {
  param([int]$Port, [int]$TimeoutMs = 1000)
  $lgClient = New-Object System.Net.Sockets.TcpClient
  try {
    $lgAsync = $lgClient.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (!$lgAsync.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $lgClient.EndConnect($lgAsync)
    return $true
  } catch {
    return $false
  } finally {
    $lgClient.Close()
  }
}

function Invoke-LgDocker {
  # Windows PowerShell 5.1 promotes native-command stderr to a *terminating*
  # error while $ErrorActionPreference is 'Stop', and a plain 2>$null does not
  # suppress it. Measured on 2026-10-15: 'docker inspect' against a missing
  # container aborted this script with a raw docker error instead of reaching
  # the named rejection below. Merge both streams and read the exit code.
  param([string[]]$DockerArgs)
  $lgPrevious = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lgOutput = & docker @DockerArgs 2>&1
    $lgCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $lgPrevious
  }
  return [pscustomobject]@{ Code = $lgCode; Output = ($lgOutput | Out-String).Trim() }
}

function Invoke-LgProductionDatabasePreflight {
  $lgTarget = Get-LgProductionDatabaseTarget
  $lgInspect = Invoke-LgDocker @('inspect', '--format', '{{.State.Running}}', $lgTarget.Container)
  if ($lgInspect.Code -ne 0) {
    throw "lg_pg_container_absent: no container named '$($lgTarget.Container)' (docker: $($lgInspect.Output)). Create the production database instance first, then retry."
  }
  if ($lgInspect.Output -ne 'true') {
    # The restart policy now brings this back on its own; this is the manual
    # path for a container that was stopped on purpose earlier.
    Write-Host "Production database '$($lgTarget.Container)' is not running; starting it."
    $lgStart = Invoke-LgDocker @('start', $lgTarget.Container)
    if ($lgStart.Code -ne 0) {
      throw "lg_pg_start_failed: 'docker start $($lgTarget.Container)' failed (docker: $($lgStart.Output)). Check 'docker logs $($lgTarget.Container)' and retry."
    }
  }
  # A crash-recovered PostgreSQL only accepts connections after redo completes,
  # so a successful loopback connect is a fair readiness signal here. The
  # core's own identity read-back remains the real gate.
  # 60 attempts x (<=1s connect timeout + 1s sleep) => up to ~120s worst case.
  for ($lgAttempt = 0; $lgAttempt -lt 60; $lgAttempt++) {
    if (Test-LgLoopbackPort $lgTarget.Port) {
      Write-Host "Production database ready: container=$($lgTarget.Container) 127.0.0.1:$($lgTarget.Port)"
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "lg_pg_not_accepting_connections: container '$($lgTarget.Container)' is up but 127.0.0.1:$($lgTarget.Port) still refuses connections after 60 attempts (up to ~120s). Check 'docker logs $($lgTarget.Container)'."
}

$lgQqRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $lgQqRoot
& pnpm qq:prepare
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& pnpm qq:check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& docker compose --env-file .env.qq -f scripts/qq/compose.yml config --quiet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($CheckOnly) { exit 0 }
& docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  $lgDockerApp = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
  if (!(Test-Path -LiteralPath $lgDockerApp)) { $lgDockerApp = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
  Start-Process -FilePath $lgDockerApp -WindowStyle Hidden
  $lgDockerReady = $false
  for ($lgAttempt = 0; $lgAttempt -lt 90; $lgAttempt++) {
    & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $lgDockerReady = $true; break }
    Start-Sleep -Seconds 2
  }
  if (!$lgDockerReady) { throw 'Docker Desktop did not become ready' }
}
# Fail fast and by name when the production database is not reachable. This runs
# before any QQ startup work so a down database is reported as such instead of
# surfacing later as lg_bridge_exit_1.
& Invoke-LgProductionDatabasePreflight
if ($PreflightOnly) { exit 0 }
& docker compose --env-file .env.qq -f scripts/qq/compose.yml up -d
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$lgQqWebuiReady = $false
for ($lgAttempt = 0; $lgAttempt -lt 60; $lgAttempt++) {
  try {
    $lgQqResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:6101/webui' -UseBasicParsing -TimeoutSec 2
    if ($lgQqResponse.StatusCode -eq 200) { $lgQqWebuiReady = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}
if (!$lgQqWebuiReady) { throw 'Independent NapCat WebUI did not become ready' }
$lgQqWebuiTokenLine = [System.IO.File]::ReadAllLines((Join-Path $lgQqRoot '.env.qq')) | Where-Object { $_.StartsWith('QQ_NAPCAT_WEBUI_TOKEN=') } | Select-Object -First 1
$lgQqWebuiToken = $lgQqWebuiTokenLine.Substring('QQ_NAPCAT_WEBUI_TOKEN='.Length)
Start-Process -FilePath "http://127.0.0.1:6101/webui?token=$lgQqWebuiToken"
Write-Host 'Log in with the independent bot QQ account. Keep this terminal open for LG private chat.'
& pnpm qq:chat
exit $LASTEXITCODE
