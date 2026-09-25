@echo off
rem Sucht obs64.exe und setzt OBS_EXE und OBS_DIR (leer, wenn nicht gefunden).
set "OBS_EXE="
set "OBS_DIR="
if exist "%ProgramFiles%\obs-studio\bin\64bit\obs64.exe" set "OBS_EXE=%ProgramFiles%\obs-studio\bin\64bit\obs64.exe"
if not defined OBS_EXE if exist "%LOCALAPPDATA%\Programs\obs-studio\bin\64bit\obs64.exe" set "OBS_EXE=%LOCALAPPDATA%\Programs\obs-studio\bin\64bit\obs64.exe"
if not defined OBS_EXE if exist "%ProgramFiles(x86)%\Steam\steamapps\common\OBS Studio\bin\64bit\obs64.exe" set "OBS_EXE=%ProgramFiles(x86)%\Steam\steamapps\common\OBS Studio\bin\64bit\obs64.exe"
rem Installationspfad aus der Registry (Standard-Installer)
if not defined OBS_EXE for /f "tokens=2,*" %%A in ('reg query "HKLM\SOFTWARE\OBS Studio" /ve 2^>nul ^| find "REG_SZ"') do if exist "%%B\bin\64bit\obs64.exe" set "OBS_EXE=%%B\bin\64bit\obs64.exe"
if defined OBS_EXE for %%F in ("%OBS_EXE%") do set "OBS_DIR=%%~dpF"
exit /b 0
