@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo ================================================================
echo   iPhone-Webcam: Voraussetzungen pruefen (es wird nichts installiert)
echo ================================================================
echo.
set "MISSING=0"

rem ---------- Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [FEHLT]  Node.js ist nicht installiert.
  echo          Installieren:  winget install OpenJS.NodeJS.LTS
  echo          oder LTS-Version von https://nodejs.org laden. Danach dieses Fenster neu oeffnen.
  set "MISSING=1"
  goto :obs
)
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%a in ("%NODEVER:v=%") do set "NODEMAJOR=%%a"
if %NODEMAJOR% LSS 18 (
  echo [ALT]    Node.js %NODEVER% ist zu alt, mindestens v18 noetig. Update: winget upgrade OpenJS.NodeJS.LTS
  set "MISSING=1"
) else (
  echo [OK]     Node.js %NODEVER%
)
where npm >nul 2>nul || (echo [FEHLT]  npm fehlt ^(gehoert zu Node.js, bitte Node.js neu installieren^) & set "MISSING=1")

:obs
rem ---------- OBS Studio
call "%~dp0scripts\find-obs.bat"
rem (kein Klammerblock: der Pfad kann "(x86)" enthalten)
if not defined OBS_EXE goto :obsmissing
echo [OK]     OBS Studio: %OBS_EXE%
goto :net
:obsmissing
echo [FEHLT]  OBS Studio nicht gefunden.
echo          Installieren:  winget install OBSProject.OBSStudio
echo          oder von https://obsproject.com laden.
set "MISSING=1"

:net

rem ---------- Netzwerkprofil (Firewall-Freigabe gilt nur fuer "Privat")
echo.
powershell -NoProfile -Command "Get-NetConnectionProfile | ForEach-Object { if ($_.NetworkCategory -eq 'Public') { Write-Host ('[WARNUNG] Netzwerk ''' + $_.Name + ''' ist als OEFFENTLICH eingestuft - die Firewall-Freigabe greift dann nicht.'); Write-Host '          Umstellen: Einstellungen - Netzwerk und Internet - WLAN - (dein Netz) - Netzwerkprofiltyp: Privates Netzwerk' } else { Write-Host ('[OK]     Netzwerk ''' + $_.Name + ''' ist ' + $_.NetworkCategory) } }"

rem ---------- Firewall-Regel
netsh advfirewall firewall show rule name="iPhone-Webcam" >nul 2>nul
if errorlevel 1 (
  echo [FEHLT]  Firewall-Freigabe fuer Port 8443/8080. Einrichten: firewall.bat ^(als Administrator^)
) else (
  echo [OK]     Firewall-Freigabe "iPhone-Webcam" vorhanden
)
rem Blockier-Regeln fuer node.exe schlagen jede Freigabe
powershell -NoProfile -Command "$b = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe' } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }; if ($b) { Write-Host '[WARNUNG] Es gibt Firewall-Regeln, die node.exe BLOCKIEREN:'; $b | ForEach-Object { Write-Host ('          - ' + $_.DisplayName + ' (' + $_.Profile + ')') }; Write-Host '          Diese in wf.msc > Eingehende Regeln loeschen, sonst ist der Server vom iPhone nicht erreichbar.' }"

rem ---------- Abhaengigkeiten
if exist "node_modules\express\" (
  echo [OK]     npm-Pakete installiert
) else (
  echo [INFO]   npm-Pakete noch nicht installiert - passiert automatisch beim ersten start.bat
)

echo.
if "%MISSING%"=="1" (
  echo Es fehlt noch etwas ^(siehe oben^). Nach der Installation check.bat erneut ausfuehren.
) else (
  echo Alles Noetige ist vorhanden. Weiter mit start.bat
)
echo.
pause
