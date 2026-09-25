@echo off
chcp 65001 >nul
title iPhone-Webcam Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte zuerst check.bat ausfuehren.
  pause
  exit /b 1
)

if not exist "node_modules\express\" (
  echo Installiere benoetigte Pakete ^(einmalig^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install ist fehlgeschlagen. Internetverbindung pruefen und erneut starten.
    pause
    exit /b 1
  )
)

node server.js
echo.
echo Server wurde beendet.
pause
