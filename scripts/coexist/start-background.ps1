# post-Lv2 / ADR-109 WP5 -- start the coexistence core in the background (production activation).
#
# NOTE: this launcher stays ASCII-only on purpose. Windows PowerShell 5.1 reads a
#       BOM-less .ps1 as ANSI, so non-ASCII lines get mangled and break the parser
#       (same reason scripts/postlv2-avatar-production.cmd is ASCII-only).
#
# It does NOT grant authorization by itself: you run it, and it passes the exact
# authorization string for the resolved data directory to `pnpm coexist:start`.
# Stop it with `pnpm coexist:stop` (writes the STOP sentinel -> ordered shutdown).
# Do NOT taskkill: that would skip draining in-flight turns.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\coexist\start-background.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\coexist\start-background.ps1 -DataDir "D:\...\data\pglite"

param(
  [string]$DataDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'data\pglite')
)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runtime = Join-Path $root 'artifacts\post-lv2\local\coexist-runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$log = Join-Path $runtime 'supervisor.log'
$stop = Join-Path $runtime 'STOP'

if (Test-Path $stop) {
  Remove-Item $stop -Force
  Write-Host 'Removed a leftover STOP sentinel.'
}

$resolved = (Resolve-Path -LiteralPath $DataDir).Path
$env:PROJECT_LG_COEXIST_ACTIVATE = "coexist@$resolved"
Write-Host "Authorization: PROJECT_LG_COEXIST_ACTIVATE='coexist@$resolved'"
Write-Host "Log: $log"

Start-Process -FilePath 'cmd.exe' `
  -ArgumentList '/c', "pnpm coexist:start >> `"$log`" 2>&1" `
  -WorkingDirectory $root -WindowStyle Hidden

Start-Sleep -Seconds 3
Write-Host 'Started in background. Watch the log for COEXIST_READY. Stop with: pnpm coexist:stop'
