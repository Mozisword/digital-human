@echo off
cd /d %~dp0
set VENV=C:\Users\OMEN\.workbuddy\python\envs\shuziren
if not exist "%VENV%\Scripts\python.exe" (
  echo [ERROR] venv not found.
  pause
  exit /b 1
)

echo Checking TTS engine...
"%VENV%\Scripts\python.exe" -c "from TTS.api import TTS" >nul 2>nul
if errorlevel 1 (
  echo [WARN] Custom voice engine (coqui-tts==0.27.5) not installed.
  echo   Install via (project venv, may take long for PyTorch ~800MB):
  echo     "%VENV%\Scripts\python.exe" -m pip install num2words --index-url https://pypi.org/simple
  echo     "%VENV%\Scripts\python.exe" -m pip install "coqui-tts==0.27.5" librosa
  echo.
)

echo Starting server at http://localhost:8000
"%VENV%\Scripts\python.exe" -m uvicorn app:app --host 0.0.0.0 --port 8000
pause
