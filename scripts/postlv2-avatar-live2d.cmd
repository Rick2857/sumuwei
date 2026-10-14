@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not defined POSTLV2_DEPS_ROOT set "POSTLV2_DEPS_ROOT=C:\Users\user\postlv2-deps"
if not defined POSTLV2_SPEECH_PROFILE set "POSTLV2_SPEECH_PROFILE=cosyvoice3"
set "POSTLV2_PYTHON=%POSTLV2_DEPS_ROOT%\cosyvoice3-venv\Scripts\python.exe"
if "%POSTLV2_SPEECH_PROFILE%"=="legacy" set "POSTLV2_PYTHON=%POSTLV2_DEPS_ROOT%\qwen3-tts-venv\Scripts\python.exe"
rem This launcher stays ASCII-only on purpose: cmd occasionally mis-slices a non-ASCII line
rem after a mid-file "chcp", and a mis-sliced line is executed as a command (2026-10-05).
rem The Chinese launch banner is printed by postlv2_vtuber_runtime.py --mode production.
"%POSTLV2_PYTHON%" -B -X utf8 "%~dp0postlv2-vtuber-setup.py" --deps-root "%POSTLV2_DEPS_ROOT%" --model-root "%USERPROFILE%\Downloads\ulvm2_0001\ulvm2_0001" --speech-profile "%POSTLV2_SPEECH_PROFILE%"
if errorlevel 1 goto failed
"%POSTLV2_PYTHON%" -B -X utf8 "%~dp0postlv2_vtuber_runtime.py" --repo-root "%CD%" --deps-root "%POSTLV2_DEPS_ROOT%" %* --mode production
if errorlevel 1 goto failed
exit /b 0
:failed
echo Startup or shutdown failed. See the error above; do not force-unlock the database or run migrations.
pause
exit /b 1
