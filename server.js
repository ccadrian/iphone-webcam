'use strict';
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const QRCode = require('qrcode');
const { ensureCertificates, getLanAddresses, isPermittedIp } = require('./lib/certs');
const { createSignaling } = require('./lib/signaling');

const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, 'certs');
const QUIET = process.env.QUIET === '1';

const certs = ensureCertificates(CERT_DIR);
// nur private Adressen (Heimnetz); nur für diese gilt das Zertifikat
const allAddrs = getLanAddresses();
const lan = allAddrs.filter((a) => isPermittedIp(a.address));
const mainIp = lan[0]?.address || '127.0.0.1';
const sendUrl = `https://${mainIp}:${HTTPS_PORT}/send`;
const caUrl = `http://${mainIp}:${HTTP_PORT}/ca.crt`;
const viewUrl = `http://localhost:${HTTP_PORT}/view`;

const ts = () => new Date().toLocaleTimeString('de-DE');
const log = (...a) => console.log(`[${ts()}]`, ...a);

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const isHttps = (req) => req.socket.encrypted === true;
const hostOnly = (req) => (req.headers.host || mainIp).replace(/:\d+$/, '');

// Die Kamera-Seite braucht HTTPS (sonst kein getUserMedia in Safari)
app.get('/send', (req, res, next) => {
  if (!isHttps(req)) return res.redirect(`https://${hostOnly(req)}:${HTTPS_PORT}/send`);
  next();
});
app.get('/send', (req, res) => res.sendFile(path.join(__dirname, 'public', 'send.html')));
app.get('/view', (req, res) => res.sendFile(path.join(__dirname, 'public', 'view.html')));

// CA-Zertifikat zum Installieren auf dem iPhone
app.get('/ca.crt', (req, res) => {
  res.set('Content-Type', 'application/x-x509-ca-cert');
  res.set('Content-Disposition', 'attachment; filename="iphone-webcam-ca.crt"');
  res.send(Buffer.from(certs.caCertPem));
});

app.get('/', async (req, res) => {
  const qr = await QRCode.toString(sendUrl, { type: 'svg', margin: 1, width: 260 });
  const qrCa = await QRCode.toString(caUrl, { type: 'svg', margin: 1, width: 180 });
  res.type('html').send(`<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iPhone-Webcam</title><link rel="stylesheet" href="/style.css"></head>
<body class="page">
<main class="card">
  <h1>iPhone-Webcam</h1>
  <p>Server läuft. Alles bleibt in deinem Heimnetz.</p>
  <ol>
    <li><b>Einmalig:</b> Zertifikat aufs iPhone laden:<br>
      <a href="${caUrl}">${caUrl}</a><div class="qr small">${qrCa}</div>
      danach: Einstellungen &rarr; Profil geladen &rarr; Installieren, und<br>
      Einstellungen &rarr; Allgemein &rarr; Info &rarr; Zertifikatsvertrauenseinstellungen &rarr; Schalter an.</li>
    <li>Auf dem iPhone in Safari öffnen:<br><a href="${sendUrl}">${sendUrl}</a><div class="qr">${qr}</div></li>
    <li>In OBS als Browserquelle: <code>${viewUrl}</code> &nbsp;(<a href="/view">Vorschau</a>)</li>
  </ol>
  ${lan.length > 1 ? `<p class="hint">Weitere Adressen dieses PCs: ${lan.slice(1).map((a) => `${a.address} (${a.name})`).join(', ')}</p>` : ''}
</main></body></html>`);
});

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const signaling = createSignaling({ log });
const httpsServer = https.createServer({ cert: certs.cert, key: certs.key }, app);
const httpServer = http.createServer(app);

for (const [srv, port, name] of [
  [httpsServer, HTTPS_PORT, 'HTTPS'],
  [httpServer, HTTP_PORT, 'HTTP'],
]) {
  srv.on('upgrade', signaling.handleUpgrade);
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nFEHLER: Port ${port} (${name}) ist schon belegt. Läuft der Server bereits in einem anderen Fenster?`);
      console.error(`Anderen Port wählen: set ${name}_PORT=...  und neu starten.\n`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

let listening = 0;
const onListening = async () => {
  if (++listening < 2) return;
  if (QUIET) return console.log(`listening ${HTTPS_PORT} ${HTTP_PORT}`);
  const qr = await QRCode.toString(sendUrl, { type: 'terminal', small: true });
  console.log('');
  console.log('=====================================================================');
  console.log('  iPhone-Webcam läuft (nur lokal, keine Cloud)');
  console.log('=====================================================================');
  if (certs.renewed) console.log(`  Server-Zertifikat erstellt (${certs.renewed}).`);
  console.log('');
  console.log('  1) Einmalig: Zertifikat aufs iPhone (in Safari öffnen):');
  console.log(`       ${caUrl}`);
  console.log('');
  console.log('  2) Kamera-Seite auf dem iPhone (Safari) - QR-Code scannen:');
  console.log(`       ${sendUrl}`);
  console.log('');
  console.log(qr);
  console.log('  3) OBS Browserquelle / Vorschau am PC:');
  console.log(`       ${viewUrl}`);
  console.log('');
  console.log(`  Übersicht mit QR-Codes im PC-Browser: http://localhost:${HTTP_PORT}/`);
  if (lan.length > 1) {
    console.log('');
    console.log('  Falls die Adresse oben nicht passt, weitere IPs dieses PCs:');
    for (const a of lan.slice(1)) console.log(`       https://${a.address}:${HTTPS_PORT}/send   (${a.name})`);
  }
  if (!lan.length) {
    console.log('\n  WARNUNG: Keine private LAN-IP (192.168.x.x / 10.x.x.x / 172.16-31.x.x) gefunden.');
    console.log('  Ist der PC mit dem Heimnetz verbunden?');
    if (allAddrs.length) console.log(`  Gefundene Adressen: ${allAddrs.map((a) => a.address).join(', ')}`);
  }
  console.log('');
  console.log('  Beenden: Strg+C');
  console.log('=====================================================================');
};

httpsServer.listen(HTTPS_PORT, '0.0.0.0', onListening);
httpServer.listen(HTTP_PORT, '0.0.0.0', onListening);

const shutdown = () => {
  signaling.wss.close();
  httpsServer.close();
  httpServer.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
