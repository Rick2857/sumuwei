@echo off
setlocal
cd /d "%~dp0.."
node scripts/start-3d-omni.mjs %*
exit /b %errorlevel%
