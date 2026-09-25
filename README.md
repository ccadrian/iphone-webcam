# iPhone als Webcam am Windows-PC (ohne App, nur Safari)

Das iPhone schickt sein Kamerabild per **WebRTC** direkt über dein WLAN an den PC. Auf dem PC zeigt **OBS Studio** das Bild an, und die **OBS Virtual Camera** stellt es Windows als normale Webcam bereit. Danach ist es in Zoom, Teams, Discord und im Browser auswählbar.

```
iPhone (Safari, /send) ──WebRTC, direkt im LAN──▶ OBS-Browserquelle (/view) ──▶ OBS Virtual Camera ──▶ Zoom/Teams/Discord/Browser
          └──────── Signalisierung (WebSocket) ────────┘
                  Node.js-Server auf dem PC
```

- Alles bleibt im Heimnetz. Es gibt keine Cloud und keine STUN/TURN-Server, und nach der Installation braucht es auch kein Internet mehr.
- Auf dem iPhone installierst du keine App. Einmalig installierst du nur ein Zertifikatsprofil, weil Safari die Kamera ausschließlich über HTTPS freigibt.

---

## Einrichtung Schritt für Schritt

### 0. Voraussetzungen prüfen

Doppelklick auf **`check.bat`**. Das Skript installiert nichts. Es prüft:

- Node.js (mindestens v18)
- ob OBS Studio installiert ist und wo
- ob dein WLAN in Windows als *Privat* eingestuft ist
- ob die Firewall-Regel existiert und ob Windows `node.exe` blockiert

Falls etwas fehlt:

| Fehlt | Installieren (PowerShell oder cmd) |
|---|---|
| Node.js | `winget install OpenJS.NodeJS.LTS` (oder https://nodejs.org) |
| OBS Studio | `winget install OBSProject.OBSStudio` (oder https://obsproject.com) |

Öffne danach ein neues Fenster und führe `check.bat` noch einmal aus.

### 1. Firewall freigeben (einmalig)

Doppelklick auf **`firewall.bat`** und die Admin-Abfrage bestätigen. Das Skript führt diesen Befehl aus:

```bat
netsh advfirewall firewall add rule name="iPhone-Webcam" dir=in action=allow protocol=TCP localport=8443,8080 profile=private
```

Gleichwertig in PowerShell (als Administrator):

```powershell
New-NetFirewallRule -DisplayName "iPhone-Webcam" -Direction Inbound -Protocol TCP -LocalPort 8443,8080 -Action Allow -Profile Private
```

Wieder entfernen kannst du die Regel mit `firewall.bat remove`.

- **8443** ist die HTTPS-Kameraseite für das iPhone.
- **8080** ist HTTP für den Zertifikats-Download und für OBS auf `localhost`.

> Die Regel gilt nur für **private** Netzwerke. Ist dein WLAN als „Öffentlich“ eingestuft, stellst du es so um: *Einstellungen → Netzwerk und Internet → WLAN → (dein Netz) → Netzwerkprofiltyp: Privates Netzwerk*.

Beim ersten Start fragt Windows eventuell zusätzlich, ob **Node.js** im Netzwerk kommunizieren darf. Setze dort den Haken bei **Private Netzwerke** und klicke auf *Zugriff zulassen*.

### 2. Server starten

Doppelklick auf **`start.bat`**. Beim ersten Mal installiert es automatisch die npm-Pakete (Internet nötig). Danach zeigt das Fenster:

- die Adresse für das Zertifikat, z. B. `http://192.168.178.34:8080/ca.crt`
- die Kamera-URL für das iPhone, z. B. `https://192.168.178.34:8443/send`, plus **QR-Code**
- die Adresse für OBS: `http://localhost:8080/view`

Ist der QR-Code im Terminal unleserlich, öffne am PC **http://localhost:8080/**. Dort stehen beide QR-Codes groß im Browser.

Lass das Fenster offen, solange du die Webcam nutzt.

### 3. Zertifikat auf dem iPhone vertrauen (einmalig)

Der Server erzeugt beim ersten Start eine **eigene, lokale Zertifizierungsstelle (CA)** in `certs\`. Diese installierst du einmal auf dem iPhone. Ändert sich später die IP-Adresse des PCs, stellt der Server automatisch ein neues Server-Zertifikat von derselben CA aus. Auf dem iPhone musst du dann nichts neu machen.

1. Öffne auf dem iPhone in **Safari** die Zertifikats-Adresse aus dem Terminal (`http://<PC-IP>:8080/ca.crt`, der kleine QR-Code auf http://localhost:8080/). Safari meldet: *„Diese Website versucht, ein Konfigurationsprofil zu laden“*. Tippe auf **Erlauben**.
2. Gehe zu **Einstellungen → Allgemein → VPN & Geräteverwaltung → „iPhone-Webcam lokale CA“ → Installieren**, gib den Code ein und tippe noch einmal auf *Installieren*. Oft steht auch ganz oben in den Einstellungen „Profil geladen“.
3. **Wichtig, sonst geht es nicht:** Gehe zu **Einstellungen → Allgemein → Info → (ganz unten) Zertifikatsvertrauenseinstellungen** und schalte den Schalter bei **„iPhone-Webcam lokale CA“** ein. Bestätige mit *Fortfahren*.

Sicherheit: Die CA ist technisch eingeschränkt (X.509 *Name Constraints*). Sie kann nur Zertifikate für private IP-Adressen (192.168.x.x, 10.x.x.x, 172.16–31.x.x), `localhost` und `*.local` ausstellen, also für keine echte Website. Den privaten Schlüssel `certs\ca.key` gibst du trotzdem nicht weiter. Entfernen kannst du das Profil jederzeit unter *VPN & Geräteverwaltung*.

<details><summary>Alternative: mkcert statt der eingebauten CA</summary>

Wer lieber mkcert nutzt: Lege `rootCA.pem` aus `mkcert -CAROOT` als `certs\ca.crt` und `rootCA-key.pem` als `certs\ca.key` ab. Lösche dann `certs\server.*` und starte neu. Der Server stellt sein Zertifikat dann mit der mkcert-CA aus. Die mkcert-CA hat allerdings **keine** Name Constraints, und auf dem iPhone musst du sie genauso wie oben vertrauen.
</details>

### 4. Kamera am iPhone starten

1. Scanne den QR-Code aus dem Terminal mit der iPhone-Kamera und öffne den Link in **Safari**. Es darf keine Zertifikatswarnung kommen, sonst Schritt 3 prüfen.
2. Wähle **Rückkamera/Frontkamera** und **1080p/720p**. Beides lässt sich auch während der Übertragung umschalten.
3. Tippe auf **Start** und erlaube den Kamerazugriff.
4. Halte das iPhone **quer**. Nur dann ist das Bild 16:9 wie bei einer Webcam.

Die Statuszeile oben zeigt *Server: verbunden*, *Empfänger: 1* und die tatsächliche Senderate (Auflösung, fps, Mbit/s). Steht dort *Limit: WLAN* oder *Limit: CPU/Hitze*, drosselt WebRTC gerade die Qualität.

Tipp: Unter *Einstellungen → Apps → Safari → Kamera* auf „Erlauben“ stellen, dann fragt Safari nicht jedes Mal.

### 5. OBS einrichten (einmalig)

1. Starte OBS Studio. Den Assistenten zur automatischen Konfiguration kannst du abbrechen.
2. Unter **Einstellungen → Video**:
   - Basis-Auflösung (Leinwand) **1920×1080**
   - Ausgabe-Auflösung **1920×1080** (oder 1280×720, wenn du 720p nutzt)
   - FPS-Wert **30**
3. Im Bereich **Quellen**: **+ → Browser**, Name z. B. „iPhone“:
   - **URL:** `http://localhost:8080/view`
   - **Breite:** 1920, **Höhe:** 1080
   - **Benutzerdefinierte Bildrate verwenden:** an, **30**
   - **Quelle herunterfahren, wenn nicht sichtbar:** **aus**
   - **Browser aktualisieren, wenn Szene aktiv wird:** aus
   - Das Feld *Benutzerdefiniertes CSS* kannst du so lassen.
4. Rechtsklick auf die Quelle → **Transformieren → An Bildschirm anpassen** (oder Strg+F).
5. Rechts unten auf **„Virtuelle Kamera starten“** klicken.

Jetzt taucht in Zoom, Teams, Discord, Chrome und Edge eine Kamera namens **„OBS Virtual Camera“** auf.

URL-Optionen für `/view`:

- `?fit=cover` füllt das Bild randlos und schneidet dafür statt schwarzer Balken ab, z. B. `http://localhost:8080/view?fit=cover`.
- `?debug=1` blendet Statistiken ein: Auflösung, fps, Codec, Bitrate und Jitter-Puffer.

#### OBS automatisch mit Virtual Camera starten

- **`obs-start.bat`** startet OBS minimiert mit laufender Virtual Camera (`obs64.exe --startvirtualcam --minimize-to-tray`).
- **`start-alles.bat`** startet zuerst den Server und dann OBS.

Für den Autostart legst du eine Verknüpfung zu `start-alles.bat` in `shell:startup` ab (Win+R → `shell:startup`).

### 6. In der Videokonferenz auswählen

| Programm | Einstellung |
|---|---|
| Zoom | Einstellungen → Video → Kamera: *OBS Virtual Camera* |
| Teams | Einstellungen → Geräte → Kamera: *OBS Virtual Camera* |
| Discord | Einstellungen → Sprache & Video → Kamera: *OBS Virtual Camera* |
| Browser (Meet, Jitsi …) | Kamera-Symbol in der Adressleiste → *OBS Virtual Camera* |

Zoom, Teams und Discord spiegeln die eigene Vorschau. Das Bild bei den anderen ist trotzdem richtig herum.

---

## Latenz

Was schon auf niedrige Latenz ausgelegt ist:

- direkte WebRTC-Verbindung im LAN (kein Relais)
- H.264 bevorzugt, auf iPhone und den meisten PCs in Hardware kodiert
- hohe Startbitrate: das Bild ist sofort scharf, statt erst hochzuregeln
- Jitter-Puffer beim Empfänger auf Minimum
- Bildrate hat Vorrang vor Auflösung

Die Gesamtverzögerung habe ich nicht am echten Gerät gemessen. Bei WebRTC im LAN plus OBS ist erfahrungsgemäß eine Verzögerung von etwa 100–250 ms zu erwarten. So bekommst du das Minimum:

- Beide Geräte ins **5-GHz-WLAN**, am besten den PC per LAN-Kabel an den Router.
- Stockt oder verzögert es, auf **720p** umschalten.
- In OBS unter *Einstellungen → Erweitert* ist *Browserquellen-Hardwarebeschleunigung aktivieren* standardmäßig an. Lass es an.
- Keine VPN-Software auf PC oder iPhone aktiv.

---

## Fehlerbehebung

### Zertifikat

| Symptom | Lösung |
|---|---|
| Safari zeigt „Diese Verbindung ist nicht privat“ | Schritt 3 vollständig machen. Meist fehlt der Schalter unter *Info → Zertifikatsvertrauenseinstellungen*. |
| Profil lässt sich nicht laden | Die Adresse muss mit **http://** und Port **8080** beginnen und in **Safari** geöffnet werden, nicht in Chrome oder einer In-App-Ansicht. |
| Warnung trotz installiertem Profil | Das kommt vor, wenn die PC-IP nicht im Zertifikat steht, z. B. wenn du eine Adresse eines VPN-Adapters benutzt. Nimm die Adresse, die `start.bat` anzeigt. Der Server stellt beim Start automatisch ein passendes Zertifikat aus. |
| Neues Zertifikat komplett neu erzeugen | Server beenden, Ordner `certs\` löschen, neu starten. Dann das alte Profil am iPhone löschen und das neue installieren und vertrauen. |
| Die Seite kann man „trotzdem besuchen“ | Nicht empfohlen: Safari lässt dann oft den WebSocket nicht zu, und die Verbindung bleibt auf „verbinde…“. Besser das Zertifikat richtig installieren. |

### iPhone erreicht den PC nicht (Seite lädt nicht)

1. Sind beide Geräte im **selben WLAN**? Achtung bei Gast-WLAN oder einem Mesh mit „Client-Isolation“ bzw. „AP-Isolation“: Dort können sich Geräte gegenseitig nicht sehen. Im Router ausschalten.
2. Führe `check.bat` aus:
   - Ist das Netzwerkprofil *Privat*?
   - Existiert die Firewall-Regel?
   - Gibt es **Blockier-Regeln für node.exe**? Die entstehen, wenn du die Windows-Firewall-Abfrage abgebrochen hast. Lösche sie unter `wf.msc` → *Eingehende Regeln* → nach „Node.js“ filtern.
3. Mehrere IPs im Terminal? Probiere die anderen angezeigten Adressen.
4. Test am PC selbst: Lädt `https://localhost:8443/send`? Dann läuft der Server, und es liegt an Netzwerk oder Firewall.
5. Das iPhone-Feature *Privates WLAN-Adresse* ist unproblematisch. Aber: Ist *iCloud Privat-Relay* oder ein VPN aktiv, zum Test ausschalten.

### iPhone sperrt den Bildschirm oder das Bild friert ein

- Die Seite hält das Display per **Wake Lock** wach, solange Safari im Vordergrund ist.
- iOS stoppt die Kamera **immer**, sobald Safari in den Hintergrund geht oder das iPhone gesperrt wird. Das ist eine Einschränkung von iOS, die sich per Webseite nicht umgehen lässt. Kommst du zurück zu Safari, startet die Kamera automatisch wieder, und der PC verbindet sich neu.
- Geht das Display trotzdem aus (z. B. mit aktivem Stromsparmodus): Stelle *Einstellungen → Anzeige & Helligkeit → Automatische Sperre → **Nie*** ein, solange du die Webcam nutzt. Den Stromsparmodus schaltest du aus.
- Lege das iPhone ans **Ladekabel**. Bei 1080p ist der Akku sonst schnell leer, und das iPhone kann warm werden. Steht in der Statuszeile *Limit: CPU/Hitze*, schalte auf 720p.
- Tipp: Mit *Einstellungen → Bedienungshilfen → Geführter Zugriff* kannst du Safari „festnageln“, damit niemand versehentlich die App wechselt.

### Schwarzes Bild in OBS

1. Öffne `http://localhost:8080/view?debug=1` im normalen PC-Browser (Chrome/Edge):
   - Kommt dort Bild, liegt es an OBS (weiter mit 2).
   - Kommt dort kein Bild: Steht am iPhone *Empfänger: 1*? Hast du *Start* gedrückt? Ist Safari im Vordergrund?
2. Prüfe die OBS-Browserquelle:
   - Steht die URL genau auf `http://localhost:8080/view`? Nicht `https://`, denn OBS kennt die eigene CA nicht.
   - Rechtsklick auf die Quelle → *Eigenschaften* → **„Cache der aktuellen Seite aktualisieren“**.
   - *Quelle herunterfahren, wenn nicht sichtbar* muss **aus** sein.
   - Ist die Quelle in der Szene sichtbar (Auge-Symbol) und nicht von einer anderen Quelle verdeckt?
3. Verschwindet das Bild nach dem Minimieren von OBS: *Einstellungen → Erweitert → Browserquellen-Hardwarebeschleunigung* testweise aus und dann wieder an, OBS neu starten.
4. Die Konferenz-App zeigt schwarz, aber OBS zeigt Bild:
   - Läuft die **Virtuelle Kamera** (Button rechts unten)?
   - Ist in der App *OBS Virtual Camera* gewählt?
   - Die App **nach** dem Starten der Virtual Camera öffnen.
5. Fragt die Windows-Firewall beim ersten Start nach **OBS**, erlaube es für private Netzwerke.
6. Die Windows-Kamera-App zeigt die OBS Virtual Camera je nach OBS-Version nicht an. Für Zoom, Teams, Discord und Browser spielt das keine Rolle.

### Sonstiges

- **„Port 8443 ist schon belegt“**: Der Server läuft schon in einem anderen Fenster. Oder du wählst andere Ports: `set HTTPS_PORT=9443` und `set HTTP_PORT=9080`, dann `node server.js`. Firewall-Regel und OBS-URL passt du entsprechend an.
- **Bild steht hochkant**: Halte das iPhone quer, oder sperre am iPhone die Ausrichtung nicht im Hochformat (Kontrollzentrum).
- **Zweites Gerät übernimmt**: Es kann immer nur ein iPhone senden. Startet ein zweites, wird das erste gestoppt.
- **Ton**: Übertragen wird nur Video. Nutze in der Konferenz-App das Mikrofon des PCs bzw. Headsets.
- **Privatsphäre**: Jeder in deinem WLAN, der die Adresse kennt, kann `/view` öffnen. Das passt für ein Heimnetz. In fremden Netzen den Server nicht laufen lassen.

---

## Wenn die Browser-Lösung nicht zuverlässig genug ist: fertige Alternativen

Stand meiner Kenntnis; Preise und Funktionsumfang ändern sich, bitte beim Anbieter prüfen. Alle brauchen eine **App auf dem iPhone**.

| Lösung | Vorteile | Nachteile |
|---|---|---|
| **Camo** (Reincubate) | Sehr gute Bildqualität, per USB (sehr stabil, geringe Latenz) oder WLAN, viele Bildeinstellungen (Objektivwahl, Belichtung, Porträt-Unschärfe), echter Windows-Kameratreiber ohne OBS | Die besten Funktionen und höhere Auflösungen brauchen ein Abo, Account nötig |
| **Iriun Webcam** | Einfach, kostenlos nutzbar, WLAN oder USB, eigener Windows-Treiber | Gratisversion mit Einschränkungen bzw. Wasserzeichen, weniger Bildeinstellungen |
| **DroidCam** (auch für iOS) | Leichtgewichtig, WLAN und USB, eigener Treiber und OBS-Plugin | Kostenlos nur niedrige Auflösung, HD kostet; iOS-Version weniger ausgereift als die Android-Version |
| **NDI HX Camera** + OBS-NDI-Plugin | Profi-Protokoll, sehr gute Qualität im LAN, viele Kameraeinstellungen | Bezahl-App, mehr Einrichtungsaufwand (NDI-Runtime + Plugin + OBS Virtual Camera) |

Hinweis: Apples **Continuity-Kamera** funktioniert nur mit einem Mac. Die Webcam-Funktion der Windows-11-App *Smartphone-Link* unterstützt (Stand meines Wissens) nur Android.

Grundsätzlicher Unterschied: Native Apps können die Kamera auch bei gesperrtem Bildschirm oder im Hintergrund weiter nutzen, per **USB** übertragen und alle Objektive gezielt ansteuern. Eine Webseite in Safari kann das nicht.

---

## Für Entwickler

```
server.js            Express + HTTPS/HTTP + WebSocket, Konsolen-Ausgabe mit QR-Code
lib/certs.js         lokale CA (mit Name Constraints) + automatisch erneuertes Server-Zertifikat
lib/signaling.js     WebRTC-Signalisierung (1 Sender, n Viewer), Heartbeat
public/send.*        Kameraseite fürs iPhone
public/view.*        Empfängerseite für OBS/Browser
test/e2e.js          End-to-End-Test mit Chromium (simulierte Kamera)
```

Tests (Linux/Windows mit Chromium): `npm install` und dann `npm test`. Den Browserpfad setzt du bei Bedarf über `CHROMIUM_PATH`.
