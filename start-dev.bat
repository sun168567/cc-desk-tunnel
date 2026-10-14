@echo off
cd /d "%~dp0"
chcp 65001 >nul

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm.cmd ci
  if errorlevel 1 (
    echo npm ci failed.
    pause
    exit /b 1
  )
)

if not exist ".local\" mkdir ".local"
if exist ".local\dev-connection.json" del /f /q ".local\dev-connection.json"

where pwsh.exe >nul 2>&1
if errorlevel 1 (
  set "PRINT_SHELL=powershell.exe"
) else (
  set "PRINT_SHELL=pwsh.exe"
)

echo Starting simulation server and browser UI...
echo Close this window to stop both.
start "" /b %PRINT_SHELL% -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\print-dev-connection.ps1"

call npm.cmd run dev
if errorlevel 1 pause
