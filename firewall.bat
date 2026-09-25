@echo off
chcp 65001 >nul
setlocal
rem Freigabe der Ports 8443 (HTTPS, iPhone) und 8080 (HTTP, Zertifikat-Download)
rem nur fuer PRIVATE Netzwerke. Entfernen:  firewall.bat remove

rem Adminrechte anfordern, falls noetig
net session >nul 2>nul
if errorlevel 1 (
  echo Adminrechte werden angefordert...
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
  )
  exit /b
)

netsh advfirewall firewall delete rule name="iPhone-Webcam" >nul 2>nul
if /i "%~1"=="remove" (
  echo Firewall-Regel "iPhone-Webcam" entfernt.
  pause
  exit /b 0
)

netsh advfirewall firewall add rule name="iPhone-Webcam" dir=in action=allow protocol=TCP localport=8443,8080 profile=private description="iPhone-Webcam: Zugriff vom iPhone im Heimnetz"
if errorlevel 1 (
  echo Fehler beim Anlegen der Regel.
) else (
  echo Firewall-Regel "iPhone-Webcam" angelegt: TCP 8443, 8080 eingehend, nur private Netzwerke.
  echo Hinweis: Ist dein WLAN als "Oeffentlich" eingestuft, greift die Regel nicht - siehe README.
)
pause
