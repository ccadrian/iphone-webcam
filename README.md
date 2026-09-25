# iPhone-Webcam: webcam.schlitt.co

Die iPhone-Kamera wird ohne App, nur mit Safari, zur Webcam am PC. Alles läuft als Web-App auf **Cloudflare Workers**, es gibt keinen eigenen Server, und HTTPS kommt automatisch.

```
iPhone (Safari)  ─── WebRTC, direkt oder über TURN ───▶  PC: Browser/OBS  ──▶  OBS Virtual Camera  ──▶  Zoom/Teams/Discord
webcam.schlitt.co/send#CODE                              webcam.schlitt.co/view#CODE
        └──────────── Signalisierung (WebSocket) ─── Cloudflare Worker + Durable Object ───┘
```

- **Das Video läuft nie über den Worker.** Im selben WLAN geht es direkt von Gerät zu Gerät. Unterwegs (Mobilfunk, anderes Netz) geht es direkt über das Internet oder, falls das nicht klappt, über einen TURN-Server.
- **Kopplung per Code:** Der PC erzeugt einen zufälligen 128-Bit-Code. Das iPhone bekommt ihn per QR-Code, OBS per URL. Wer den Code nicht kennt, sieht nichts. Der Code steht im `#`-Teil der URL, der nicht an Server geschickt wird.

---

## Benutzen

1. **Am PC** https://webcam.schlitt.co öffnen.
2. **Mit dem iPhone** den QR-Code scannen, in **Safari** öffnen, auf **Start** tippen und die Kamera erlauben. Das iPhone **quer** halten. Beim nächsten Mal reicht `webcam.schlitt.co/send`, denn das iPhone merkt sich die Kopplung.
3. **OBS** (einmalig):
   - *Quellen → + → Browser*
   - URL aus dem Dashboard kopieren (`https://webcam.schlitt.co/view#…`)
   - **Breite 1920, Höhe 1080** (bei 4K: 3840×2160)
   - *Benutzerdefinierte Bildrate* **30**
   - *Quelle herunterfahren, wenn nicht sichtbar* **aus**
   - Quelle markieren und **Strg+F** drücken
   - rechts unten **„Virtuelle Kamera starten“** klicken
4. In **Zoom/Teams/Discord/Browser** als Kamera **„OBS Virtual Camera“** wählen.

`obs-start.bat` startet OBS direkt mit laufender Virtual Camera (`obs64.exe --startvirtualcam --minimize-to-tray`).

Das Dashboard zeigt eine Live-Vorschau und darunter, was wirklich ankommt: Auflösung, fps, Mbit/s, Codec und Verbindungsart. Läuft OBS, schaltest du die Vorschau aus, denn jede Vorschau muss das iPhone zusätzlich kodieren. Ist der Tab im Hintergrund, pausiert die Vorschau automatisch.

---

## Bildqualität: warum es am PC schlechter aussehen kann als am iPhone

Die Vorschau am iPhone ist das **rohe Kamerabild**. Zum PC geht ein **live komprimierter** Videostrom. Diese Stellschrauben bestimmen die Qualität:

| Einstellung | Wirkung |
|---|---|
| **Auflösung** 4K / 1080p / 720p | Bitratenlimit 30 / 15 / 6 Mbit/s. 4K lohnt sich nur mit gutem WLAN und in OBS mit 4K-Leinwand. |
| **Schärfe** (Standard) | Bei Engpässen sinkt eher die Bildrate, die Auflösung bleibt. |
| **Flüssig** | Bei Engpässen sinkt eher die Auflösung, die Bildrate bleibt. Besser bei schwachem Netz. |
| Codec | Bevorzugt wird **H.264 High** (auf dem iPhone in Hardware kodiert). Steht in der Anzeige **VP8**, kann der Empfänger kein H.264 und das iPhone kodiert in Software, was sichtbar schlechter ist. |

Die Statuszeile am iPhone zeigt, was gesendet wird, zum Beispiel `1920×1080 · 30 fps · 12.4 Mbit/s · H264 · lokal (WLAN)`. Steht dort **Limit: Netz**, ist das WLAN oder der Upload der Engpass. **Limit: CPU/Hitze** heißt: iPhone kühlen und ans Ladekabel hängen, oder 720p wählen.

Häufige Qualitätsbremsen außerhalb der App:

- **Größe der OBS-Browserquelle:** Der Standard ist 800×600. Dann rechnet OBS 1080p auf 800×600 herunter und wieder hoch, und das Bild wird matschig. Stell Breite und Höhe auf die echte Auflösung.
- **OBS-Leinwand:** Unter *Einstellungen → Video* Basis- und Ausgabeauflösung auf 1920×1080 stellen.
- **Zoom:** *Einstellungen → Video → HD* aktivieren, sonst sendet Zoom nur etwa 360p.
- **Teams/Discord** komprimieren selbst stark, Discord in HD nur mit Nitro. Was die anderen sehen, ist immer schlechter als das, was OBS bekommt.
- **2,4-GHz-WLAN** schafft oft keine 15 Mbit/s stabil. Nutze 5 GHz oder 6 GHz, am PC besser ein Kabel.

---

## Deployment (einmalig)

Die Domain `schlitt.co` liegt bei Cloudflare. `wrangler deploy` legt `webcam.schlitt.co` automatisch als *Custom Domain* an, inklusive DNS-Eintrag und Zertifikat (siehe `wrangler.toml`).

### Variante A: automatisch per GitHub Actions (empfohlen)

1. Cloudflare-Dashboard → *My Profile → API Tokens → Create Token*:
   - Vorlage **„Edit Cloudflare Workers“**
   - bei *Zone Resources* die Zone `schlitt.co` wählen
   - zusätzlich die Berechtigung **Zone → DNS → Edit** hinzufügen (für die Custom Domain)
2. Die **Account ID** steht im Cloudflare-Dashboard rechts auf der Übersichtsseite der Domain.
3. GitHub → Repository → *Settings → Secrets and variables → Actions → New repository secret*:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - optional für TURN (siehe unten): `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`
4. Jeder Push auf `main` testet und deployt. Manuell geht es unter *Actions → Test & Deploy → Run workflow*.

### Variante B: vom eigenen PC

```bash
npm install
npx wrangler login          # öffnet den Browser, bei Cloudflare anmelden
npx wrangler deploy
```

### TURN-Server (empfohlen für unterwegs)

Im selben WLAN braucht es keinen TURN. Hängt das iPhone aber im **Mobilfunk** (Carrier-NAT) oder in einem Firmen- oder Hotel-WLAN, klappt eine direkte Verbindung oft nicht. Dann springt der TURN-Server ein.

1. Cloudflare-Dashboard → **Realtime → TURN Server → Create**. Notiere **Key ID** und **API Token**.
2. Hinterlege die Werte als GitHub-Secrets `TURN_KEY_ID` und `TURN_KEY_API_TOKEN` (Variante A). Alternativ:
   ```bash
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```
3. Prüfen kannst du es unter https://webcam.schlitt.co/api/health. Dort muss `"turn": true` stehen.

Der Worker erzeugt pro Raum kurzlebige TURN-Zugangsdaten, der API-Token verlässt Cloudflare nie. Die Anzeige „über TURN-Server“ im Dashboard zeigt, wann das Video darüber läuft. TURN-Traffic ist bei Cloudflare ab einem Freikontingent kostenpflichtig; aktuelle Preise stehen in der Cloudflare-Dokumentation. Alternativ trägst du einen eigenen TURN-Server (z. B. coturn) als Secret `ICE_SERVERS_JSON` ein, im Format `[{"urls":["turn:…"],"username":"…","credential":"…"}]`.

### Kosten

Worker und Durable Objects laufen im **kostenlosen Workers-Plan**. Signalisierung und Keepalive sind wenige Nachrichten pro Minute, und das Video läuft nicht über Cloudflare, außer über TURN.

---

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| iPhone: „Kamerazugriff verweigert“ | Safari → „aA“ in der Adressleiste → *Website-Einstellungen → Kamera → Erlauben*. Dauerhaft: *Einstellungen → Apps → Safari → Kamera → Erlauben*. |
| Dashboard zeigt „iPhone: verbunden“, aber kein Bild | Das Netz blockiert die direkte Verbindung. TURN einrichten (siehe oben). |
| Bild friert ein oder das iPhone sperrt | iOS stoppt die Kamera, sobald Safari im Hintergrund ist oder gesperrt wird. Die Seite hält das Display per Wake Lock wach. Falls es trotzdem ausgeht: *Anzeige & Helligkeit → Automatische Sperre → Nie*, Stromsparmodus aus. Nach der Rückkehr zu Safari verbindet sich alles von selbst. |
| Schwarzes Bild in OBS | Die URL muss den `#CODE` enthalten, am besten aus dem Dashboard kopieren. In den Eigenschaften der Browserquelle *Cache der aktuellen Seite aktualisieren* klicken. *Quelle herunterfahren, wenn nicht sichtbar* ausschalten. Zum Test `https://webcam.schlitt.co/view?debug=1#CODE` im Browser öffnen. |
| Konferenz-App zeigt schwarz, OBS zeigt Bild | Virtuelle Kamera in OBS starten und die App **danach** öffnen. |
| „Ein anderes Gerät sendet jetzt“ | Pro Code sendet immer nur ein iPhone. Das zuletzt gestartete gewinnt. |
| Code geleakt | Im Dashboard **„Neuen Code erzeugen“** klicken, dann das iPhone neu koppeln und die OBS-URL ersetzen. |

---

## Entwicklung

```
worker/index.js      Cloudflare Worker + Durable Object „Room“ (Signalisierung, TURN-Zugangsdaten)
public/index.html    Dashboard am PC (QR-Code, OBS-URL, Vorschau)       → public/app.js
public/send.html     Kamera-Seite fürs iPhone                          → public/send.js
public/view.html     Empfänger für OBS (randlos, ohne UI)              → public/view.js
public/viewer.js     Empfangslogik (für Dashboard und /view)
public/common.js     WebSocket mit Reconnect, Codec-Wahl, QR-Code
public/_headers      Sicherheits-Header (CSP usw.)
test/e2e.js          End-to-End-Test gegen `wrangler dev` mit simulierter Kamera
```

```bash
npm install
npm run dev     # http://localhost:8787 (Kamera am echten iPhone braucht HTTPS → deployte Version nutzen)
npm test        # startet wrangler dev + Chromium (CHROMIUM_PATH=… setzen, falls nötig)
```

Die frühere rein lokale Variante (Node.js-Server im Heimnetz mit eigener CA) steht in der Git-History (Commit `4e67b8e`).
