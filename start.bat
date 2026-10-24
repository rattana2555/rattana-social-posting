@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Rattana Social Posting

rem Already running (e.g. a second double-click): just open the page
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3210/api/status -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:3210
  exit /b
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :eof
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3210"
node server.js
pause
