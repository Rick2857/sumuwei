param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
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
