@echo off
rem Startet den Server in einem eigenen Fenster und danach OBS mit Virtual Camera.
cd /d "%~dp0"
start "iPhone-Webcam Server" cmd /c "%~dp0start.bat"
timeout /t 4 >nul
call "%~dp0obs-start.bat"
