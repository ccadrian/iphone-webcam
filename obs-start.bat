@echo off
chcp 65001 >nul
setlocal
rem Startet OBS Studio minimiert mit aktiver Virtual Camera.
call "%~dp0scripts\find-obs.bat"
if not defined OBS_EXE (
  echo OBS Studio wurde nicht gefunden. Bitte check.bat ausfuehren.
  pause
  exit /b 1
)
tasklist /fi "imagename eq obs64.exe" 2>nul | find /i "obs64.exe" >nul
if not errorlevel 1 (
  echo OBS laeuft bereits. Virtuelle Kamera dort starten: Button "Virtuelle Kamera starten".
  timeout /t 5 >nul
  exit /b 0
)
rem OBS muss aus seinem eigenen Ordner gestartet werden, sonst findet es seine Dateien nicht
pushd "%OBS_DIR%"
start "" "%OBS_EXE%" --startvirtualcam --minimize-to-tray --disable-shutdown-check
popd
echo OBS wurde mit Virtual Camera gestartet (Symbol unten rechts in der Taskleiste).
timeout /t 3 >nul
