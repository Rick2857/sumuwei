@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
if not defined POSTLV2_DEPS_ROOT set "POSTLV2_DEPS_ROOT=C:\Users\user\postlv2-deps"
if not defined POSTLV2_SPEECH_PROFILE set "POSTLV2_SPEECH_PROFILE=cosyvoice3"
set "POSTLV2_PYTHON=%POSTLV2_DEPS_ROOT%\cosyvoice3-venv\Scripts\python.exe"
if "%POSTLV2_SPEECH_PROFILE%"=="legacy" set "POSTLV2_PYTHON=%POSTLV2_DEPS_ROOT%\qwen3-tts-venv\Scripts\python.exe"
"%POSTLV2_PYTHON%" -B -X utf8 "%~dp0postlv2-vtuber-setup.py" --deps-root "%POSTLV2_DEPS_ROOT%" --model-root "%USERPROFILE%\Downloads\ulvm2_0001\ulvm2_0001" --speech-profile "%POSTLV2_SPEECH_PROFILE%"
if errorlevel 1 exit /b %errorlevel%
"%POSTLV2_PYTHON%" -B -X utf8 "%~dp0postlv2_vtuber_runtime.py" --repo-root "%CD%" --deps-root "%POSTLV2_DEPS_ROOT%" %* --mode sandbox-copy
exit /b %errorlevel%
