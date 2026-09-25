'use strict';
// End-to-End-Test: Sender (simulierte Kamera) -> Server -> Viewer in Chromium.
// Aufruf: npm install && npm test
// Chromium-Pfad ggf. über CHROMIUM_PATH setzen.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const HTTPS_PORT = 18443;
const HTTP_PORT = 18080;
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iphone-webcam-test-'));
const root = path.join(__dirname, '..');

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, HTTPS_PORT, HTTP_PORT, CERT_DIR: certDir, QUIET: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    proc.stdout.on('data', (d) => {
      if (process.env.VERBOSE) process.stdout.write('    [server] ' + d);
      if (d.toString().includes('listening')) resolve(proc);
    });
    proc.on('exit', (code) => reject(new Error('Server beendet: ' + code)));
  });
}
const stopServer = (proc) => new Promise((r) => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); });

let failed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    const info = await fn();
    console.log(`  OK   ${name} (${Date.now() - t} ms)${info ? ' – ' + info : ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

// wartet, bis der Viewer laufend neue Bilder mit der erwarteten Größe dekodiert
async function waitForVideo(view, { width, timeout = 15000 } = {}) {
  await view.waitForFunction(
    (w) => {
      const v = document.querySelector('video');
      return v.videoWidth > 0 && (!w || v.videoWidth === w) && v.readyState >= 2;
    },
    width,
    { timeout, polling: 200 }
  );
  const f1 = await view.evaluate(() => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames);
  await view.waitForTimeout(1000);
  const q = await view.evaluate(() => {
    const v = document.querySelector('video');
    return { frames: v.getVideoPlaybackQuality().totalVideoFrames, w: v.videoWidth, h: v.videoHeight };
  });
  const fps = q.frames - f1;
  if (fps < 10) throw new Error(`zu wenige Bilder: ${fps}/s`);
  return `${q.w}×${q.h}, ~${fps} fps`;
}

(async () => {
  let server = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['camera'] });
  const sendPage = await ctx.newPage();
  const view = await ctx.newPage();
  sendPage.on('pageerror', (e) => console.log('    [send] ' + e.message));
  view.on('pageerror', (e) => console.log('    [view] ' + e.message));

  console.log('E2E-Test iPhone-Webcam');

  await step('HTTP /send leitet auf HTTPS um', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/send`, { redirect: 'manual' });
    if (res.status !== 302 || !res.headers.get('location').startsWith('https://')) throw new Error(res.status);
  });

  await step('Viewer lädt ohne Sender (schwarz, keine UI)', async () => {
    await view.goto(`http://localhost:${HTTP_PORT}/view?debug=1`);
    const bg = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (bg !== 'rgb(0, 0, 0)') throw new Error('Hintergrund ' + bg);
  });

  await step('Sender startet (1080p) und Viewer bekommt Bild', async () => {
    await sendPage.goto(`https://127.0.0.1:${HTTPS_PORT}/send`);
    await sendPage.click('#startStop');
    await sendPage.waitForFunction(() => document.querySelector('#startStop').textContent === 'Stopp');
    const cap = await sendPage.evaluate(() => document.querySelector('video').srcObject.getVideoTracks()[0].getSettings());
    if (cap.width !== 1920 || cap.height !== 1080) throw new Error(`Kamera liefert ${cap.width}×${cap.height}`);
    const r = await waitForVideo(view);
    await view.waitForTimeout(3000);
    return `${r}; Sender: ${await sendPage.textContent('#txtVideo')}`;
  });

  await step('Statistik: Codec und Jitter-Puffer', async () => {
    await view.waitForTimeout(1500);
    const txt = await view.textContent('#stats');
    if (!/connected/.test(txt)) throw new Error(txt);
    return txt.replace(/\n/g, ' | ');
  });

  await step('Umschalten auf 720p während der Übertragung', async () => {
    await sendPage.click('button[data-res="720"]');
    return waitForVideo(view, { width: 1280 });
  });

  await step('Kamerawechsel (Front) während der Übertragung', async () => {
    await sendPage.click('button[data-facing="user"]');
    await sendPage.waitForTimeout(500);
    const mirrored = await sendPage.evaluate(() => document.querySelector('video').classList.contains('mirror'));
    if (!mirrored) throw new Error('Vorschau nicht gespiegelt');
    return waitForVideo(view, { width: 1280 });
  });

  await step('Viewer neu laden -> Bild kommt wieder', async () => {
    await view.reload();
    return waitForVideo(view);
  });

  await step('Zweiter Viewer gleichzeitig (z. B. OBS + Browser)', async () => {
    const v2 = await ctx.newPage();
    await v2.goto(`http://localhost:${HTTP_PORT}/view`);
    const r = await waitForVideo(v2);
    await v2.close();
    return r;
  });

  await step('Server-Neustart -> Sender und Viewer verbinden sich automatisch neu', async () => {
    await stopServer(server);
    await view.waitForTimeout(1500);
    server = await startServer();
    await sendPage.waitForFunction(() => document.querySelector('#txtServer').textContent === 'Server: verbunden', null, { timeout: 10000 });
    await view.waitForFunction(() => document.querySelector('#stats')?.textContent.includes('connected'), null, { timeout: 20000 });
    return waitForVideo(view, { timeout: 20000 });
  });

  await step('Stopp ohne Server-Verbindung -> Viewer wird trotzdem schwarz', async () => {
    await stopServer(server);
    await sendPage.click('#startStop');
    await view.waitForFunction(() => document.querySelector('video').srcObject === null, null, { timeout: 15000 });
    server = await startServer();
    await sendPage.click('#startStop');
    return waitForVideo(view, { timeout: 20000 });
  });

  await step('Stopp -> Viewer wird schwarz', async () => {
    await sendPage.click('#startStop');
    await view.waitForFunction(() => document.querySelector('video').srcObject === null, null, { timeout: 5000 });
  });

  await step('Erneuter Start nach Stopp', async () => {
    await sendPage.click('#startStop');
    return waitForVideo(view);
  });

  await browser.close();
  await stopServer(server);
  fs.rmSync(certDir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} Test(s) fehlgeschlagen` : '\nAlle Tests bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
