@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not defined POSTLV2_DEPS_ROOT set "POSTLV2_DEPS_ROOT=C:\Users\user\postlv2-deps"
if not exist "%POSTLV2_DEPS_ROOT%\venv\Scripts\python.exe" (
  echo ASR Python environment is missing: %POSTLV2_DEPS_ROOT%\venv
  exit /b 1
)
"%POSTLV2_DEPS_ROOT%\venv\Scripts\python.exe" -X utf8 "%~dp0postlv2-microphone.py" %*
set "mic_exit=%errorlevel%"
if "%~1"=="" pause
exit /b %mic_exit%
