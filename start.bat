@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Rattana Social Posting
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :eof
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3210"
node server.js
pause
