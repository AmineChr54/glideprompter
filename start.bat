@echo off
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Installing Electron (first run only)...
  call npm install --no-audit --no-fund
)
start "" /b npx electron .
