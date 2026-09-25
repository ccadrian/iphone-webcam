'use strict';
// End-to-End-Test gegen `wrangler dev` (lokale Cloudflare-Simulation):
// Dashboard -> Kopplung -> Sender (simulierte Kamera) -> Vorschau/OBS-Viewer.
// Aufruf: npm install && npm test   (Chromium-Pfad ggf. über CHROMIUM_PATH)

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');

function startWorker() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_PROXY: '*' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const onData = (d) => {
      if (process.env.VERBOSE) process.stdout.write('    [wrangler] ' + d);
      if (String(d).includes('Ready on')) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error('wrangler beendet: ' + code)));
  });
}
const stopWorker = (proc) =>
  new Promise((r) => {
    proc.removeAllListeners('exit');
    proc.on('exit', r);
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { r(); }
  });

let failed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    const info = await fn();
    console.log(`  OK   ${name} (${Date.now() - t} ms)${info ? ' – ' + info : ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e.message.split('\n')[0]}`);
  }
}

// wartet, bis ein Video laufend neue Bilder (optional in bestimmter Breite) zeigt
async function waitForVideo(page, { selector = 'video', width, timeout = 20000 } = {}) {
  await page.waitForFunction(
    ([sel, w]) => {
      const v = document.querySelector(sel);
      return v && v.videoWidth > 0 && (!w || v.videoWidth === w) && v.readyState >= 2;
    },
    [selector, width],
    { timeout, polling: 200 }
  );
  const frames = () => page.evaluate((sel) => document.querySelector(sel).getVideoPlaybackQuality().totalVideoFrames, selector);
  // mehrfach messen: bei einem Neuaufbau beginnt der Zähler wieder bei 0
  let fps = 0;
  for (let i = 0; i < 5 && fps < 10; i++) {
    const f1 = await frames();
    await page.waitForTimeout(1000);
    fps = (await frames()) - f1;
  }
  const size = await page.evaluate((sel) => `${document.querySelector(sel).videoWidth}×${document.querySelector(sel).videoHeight}`, selector);
  if (fps < 10) throw new Error(`zu wenige Bilder: ${fps}/s`);
  return `${size}, ~${fps} fps`;
}

const isBlack = (page) => page.waitForFunction(() => document.querySelector('video').srcObject === null, null, { timeout: 15000 });

(async () => {
  let worker = await startWorker();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const pcCtx = await browser.newContext();
  const phoneCtx = await browser.newContext({
    permissions: ['camera'],
    viewport: { width: 852, height: 393 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  });
  const cspErrors = [];
  const watch = (p, name) => {
    p.on('pageerror', (e) => console.log(`    [${name}] ${e.message}`));
    p.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && cspErrors.push(`${name}: ${m.text()}`));
  };

  const dash = await pcCtx.newPage();
  watch(dash, 'dashboard');
  const phone = await phoneCtx.newPage();
  watch(phone, 'iphone');
  let room;

  console.log('E2E-Test iPhone-Webcam (Cloudflare Worker lokal)');

  await step('Dashboard erzeugt Raum, QR-Code und OBS-URL', async () => {
    await dash.goto(BASE + '/');
    room = await dash.evaluate(() => localStorage.getItem('pcRoom'));
    if (!/^[A-Za-z0-9_-]{22}$/.test(room)) throw new Error('Raum ' + room);
    const url = await dash.inputValue('#viewUrl');
    if (url !== `${BASE}/view#${room}`) throw new Error(url);
    if (!(await dash.$('#qr svg path'))) throw new Error('kein QR-Code');
    await dash.reload();
    if ((await dash.evaluate(() => localStorage.getItem('pcRoom'))) !== room) throw new Error('Raum nicht stabil');
    return `Raum ${room.slice(0, 4)}…`;
  });

  await step('Server lehnt ungültige Räume und fremde Origins ab', async () => {
    const upgrade = (query, origin) =>
      new Promise((resolve, reject) => {
        const req = http.request(`${BASE}/ws?${query}`, {
          headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(origin ? { Origin: origin } : {}) },
        });
        req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
        req.on('error', reject);
        req.end();
      });
    const bad = await upgrade('room=kurz&role=viewer');
    const foreign = await upgrade(`room=${room}&role=viewer`, 'https://evil.example');
    const ok = await upgrade(`room=${room}&role=viewer`, BASE);
    if (bad !== 400 || foreign !== 403 || ok !== 101) throw new Error(`${bad}/${foreign}/${ok}`);
    return 'ungültig 400, fremd 403, gültig 101';
  });

  await step('iPhone öffnet / → Hinweis statt Dashboard', async () => {
    await phone.goto(BASE + '/');
    if (!(await phone.isVisible('#mobile')) || (await phone.isVisible('#desktop'))) throw new Error('falsche Ansicht');
  });

  await step('iPhone startet per QR-Link (1080p) → Vorschau am PC', async () => {
    await phone.goto(`${BASE}/send#${room}`);
    await phone.click('#startStop');
    const r = await waitForVideo(dash, { selector: '#preview', width: 1920 });
    await dash.waitForFunction(() => document.querySelector('#phoneState').textContent.includes('verbunden'));
    await dash.waitForTimeout(2500);
    return `${r}; PC-Anzeige: ${await dash.textContent('#stats')}`;
  });

  await step('iPhone-Statuszeile zeigt Sendedaten', async () => {
    await phone.waitForFunction(() => /Mbit\/s/.test(document.querySelector('#txtVideo').textContent));
    return phone.textContent('#txtVideo');
  });

  const obs = await pcCtx.newPage();
  watch(obs, 'obs');
  await step('OBS-Viewer (/view#raum) bekommt Bild parallel zur Vorschau', async () => {
    await obs.goto(`${BASE}/view#${room}`);
    return waitForVideo(obs);
  });

  await step('Anderer Raum bekommt kein Bild (Isolation)', async () => {
    const other = await pcCtx.newPage();
    await other.goto(`${BASE}/view#AAAAAAAAAAAAAAAAAAAAAA`);
    await other.waitForTimeout(5000);
    const w = await other.evaluate(() => document.querySelector('video').videoWidth);
    await other.close();
    if (w) throw new Error('fremder Raum sieht Bild');
  });

  await step('4K anfordern', async () => {
    await phone.click('button[data-val="2160"]');
    await phone.waitForTimeout(3000);
    const cap = await phone.evaluate(() => document.querySelector('video').srcObject.getVideoTracks()[0].getSettings());
    const r = await waitForVideo(obs);
    return `Kamera liefert ${cap.width}×${cap.height}, OBS: ${r}`;
  });

  await step('720p + Priorität „Flüssig“ (schnell hintereinander getippt)', async () => {
    await phone.click('button[data-val="720"]');
    await phone.click('button[data-val="smooth"]');
    const r = await waitForVideo(obs, { width: 1280 });
    const hint = await phone.evaluate(() => document.querySelector('video').srcObject.getVideoTracks()[0].contentHint);
    if (hint !== 'motion') throw new Error('contentHint ' + hint);
    return r;
  });

  await step('Zurück auf 1080p „Schärfe“, Kamerawechsel', async () => {
    await phone.click('button[data-val="1080"]');
    await phone.click('button[data-val="quality"]');
    await phone.click('button[data-val="user"]');
    return waitForVideo(obs, { width: 1920 });
  });

  await step('Encoder: 1080p-Bitratenlimit 15 Mbit/s, Auflösung halten', async () => {
    await phone.waitForTimeout(500);
    const p = await phone.evaluate(() => {
      const pc = [...state.pcs.values()][0];
      const prm = pc.getSenders()[0].getParameters();
      return { max: prm.encodings[0].maxBitrate, deg: prm.degradationPreference, sdp: /x-google-max-bitrate=15000/.test(pc.remoteDescription.sdp) };
    });
    if (p.max !== 15_000_000 || !p.sdp) throw new Error(JSON.stringify(p));
    return `maxBitrate ${p.max / 1e6} Mbit/s, degradationPreference ${p.deg || '(nicht unterstützt)'}, SDP-Limits gesetzt`;
  });

  await step('Einstellungen am iPhone bleiben gespeichert', async () => {
    const s = await phone.evaluate(() => [localStorage.getItem('res'), localStorage.getItem('prio'), localStorage.getItem('facing')].join('/'));
    if (s !== '1080/quality/user') throw new Error(s);
  });

  await step('Vorschau aus → iPhone sendet nur noch an OBS', async () => {
    await dash.uncheck('#previewOn');
    await phone.waitForFunction(() => document.querySelector('#txtPeers').textContent.startsWith('PC: 1'), null, { timeout: 10000 });
    await dash.check('#previewOn');
    await phone.waitForFunction(() => document.querySelector('#txtPeers').textContent.startsWith('PC: 2'), null, { timeout: 15000 });
  });

  await step('OBS-Viewer neu laden → Bild kommt wieder', async () => {
    await obs.reload();
    return waitForVideo(obs);
  });

  await step('Worker-Neustart → alle verbinden sich automatisch neu', async () => {
    await stopWorker(worker);
    await isBlack(obs).catch(() => {}); // P2P kann kurz weiterlaufen
    worker = await startWorker();
    await phone.waitForFunction(() => document.querySelector('#txtServer').textContent === 'Server: verbunden', null, { timeout: 20000 });
    return waitForVideo(obs, { timeout: 30000 });
  });

  await step('Zweites iPhone übernimmt, erstes wird gestoppt', async () => {
    const phone2 = await phoneCtx.newPage();
    watch(phone2, 'iphone2');
    await phone2.goto(`${BASE}/send#${room}`);
    await phone2.click('#startStop');
    await phone.waitForFunction(() => document.querySelector('#startStop').textContent === 'Start', null, { timeout: 10000 });
    const r = await waitForVideo(obs);
    await phone2.click('#startStop');
    await phone2.close();
    return r;
  });

  await step('iPhone ohne # öffnet den gemerkten Raum', async () => {
    await phone.goto(`${BASE}/send`);
    await phone.waitForFunction((r) => location.hash === '#' + r, room);
    if (await phone.isVisible('#noRoom')) throw new Error('Hinweis statt Kamera');
  });

  await step('Start → Stopp → Viewer schwarz', async () => {
    await phone.click('#startStop');
    await waitForVideo(obs);
    await phone.click('#startStop');
    await isBlack(obs);
    await dash.waitForFunction(() => document.querySelector('#phoneState').textContent.includes('offline'));
  });

  await step('Keine CSP-Verletzungen', async () => {
    if (cspErrors.length) throw new Error(cspErrors.join(' | '));
  });

  await browser.close();
  await stopWorker(worker);
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
