'use strict';
// Empfänger-Seite (PC / OBS-Browserquelle): zeigt das iPhone-Bild randlos,
// ohne UI, und verbindet sich bei Abbrüchen selbstständig neu.
// Optionen per URL: ?fit=cover (Bild füllen statt einpassen), ?debug=1 (Statistik)

const params = new URLSearchParams(location.search);
const video = document.getElementById('v');
if (params.get('fit') === 'cover') document.body.classList.add('cover');
const debug = params.has('debug');

let pc = null;
let senderId = null;
let senderOnline = false;
let signal = null;
let lastFrames = 0;
let stalledSince = 0;
let lastRequest = 0;
const stats = { fps: 0, w: 0, h: 0, kbps: 0, codec: '', jitterMs: 0, lastBytes: 0, lastTs: 0 };

function closePeer() {
  if (!pc) return;
  pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
  pc.close();
  pc = null;
  lastFrames = 0;
}

function requestOffer(reason) {
  // nicht öfter als alle 2 s nachfragen
  if (Date.now() - lastRequest < 2000) return;
  lastRequest = Date.now();
  console.log('Neue Verbindung angefordert:', reason);
  signal.send({ type: 'request-offer' });
}

function lowLatency(receiver) {
  // Jitter-Puffer so klein wie möglich (Chromium/OBS). Kostet bei schlechtem
  // WLAN evtl. Ruckler, bringt aber die geringste Verzögerung.
  try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0; } catch {}
  try { if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0; } catch {}
}

async function onOffer(msg) {
  closePeer();
  senderId = msg.from;
  pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  const myPc = pc;

  pc.ontrack = (e) => {
    lowLatency(e.receiver);
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(() => {});
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) signal.send({ type: 'candidate', to: msg.from, candidate: e.candidate.toJSON() });
  };
  let discTimer = null;
  pc.onconnectionstatechange = () => {
    if (pc !== myPc) return;
    const s = pc.connectionState;
    clearTimeout(discTimer);
    if (s === 'failed' || s === 'closed') {
      // schwarz statt eingefrorenem Bild, dann neu verbinden
      closePeer();
      video.srcObject = null;
      requestOffer(s);
    } else if (s === 'disconnected') {
      // kurze WLAN-Aussetzer überbrücken, danach neu aufbauen
      discTimer = setTimeout(() => {
        if (pc === myPc && pc.connectionState === 'disconnected') {
          closePeer();
          video.srcObject = null;
          requestOffer('disconnected');
        }
      }, 3000);
    }
  };

  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  for (const r of pc.getReceivers()) lowLatency(r);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signal.send({ type: 'answer', to: msg.from, sdp: pc.localDescription.sdp });
}

async function onSignal(msg) {
  switch (msg.type) {
    case 'welcome':
      senderOnline = msg.senderOnline;
      break;
    case 'offer':
      senderOnline = true;
      await onOffer(msg);
      break;
    case 'candidate':
      if (pc && msg.from === senderId && msg.candidate) await pc.addIceCandidate(msg.candidate).catch((e) => console.warn('ICE', e));
      break;
    case 'sender-left':
      senderOnline = false;
      // letztes Bild stehen lassen wäre verwirrend: schwarz anzeigen
      closePeer();
      video.srcObject = null;
      break;
  }
}

signal = createSignal({ role: 'viewer', onMessage: onSignal });

// Watchdog: kommen trotz Verbindung keine Bilder mehr an, Verbindung neu aufbauen
setInterval(async () => {
  if (!pc) {
    if (senderOnline) requestOffer('keine Verbindung');
    return;
  }
  let frames = 0;
  try {
    const report = await pc.getStats();
    report.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        frames = r.framesDecoded || 0;
        stats.fps = r.framesPerSecond || 0;
        stats.w = r.frameWidth || 0;
        stats.h = r.frameHeight || 0;
        if (r.jitterBufferEmittedCount) stats.jitterMs = Math.round((1000 * r.jitterBufferDelay) / r.jitterBufferEmittedCount);
        if (stats.lastTs) stats.kbps = Math.round(((r.bytesReceived - stats.lastBytes) * 8) / (r.timestamp - stats.lastTs));
        stats.lastBytes = r.bytesReceived;
        stats.lastTs = r.timestamp;
        const c = r.codecId && report.get(r.codecId);
        if (c) stats.codec = c.mimeType;
      }
    });
  } catch {
    return;
  }
  if (frames > lastFrames) {
    lastFrames = frames;
    stalledSince = 0;
  } else if (senderOnline) {
    stalledSince ||= Date.now();
    if (Date.now() - stalledSince > 6000) {
      stalledSince = 0;
      requestOffer('keine Bilder');
    }
  }
  if (debug) renderStats();
}, 1000);

function renderStats() {
  let el = document.getElementById('stats');
  if (!el) {
    el = document.createElement('div');
    el.id = 'stats';
    document.body.appendChild(el);
  }
  el.textContent =
    `Verbindung: ${pc ? pc.connectionState : '–'}\n` +
    `Bild: ${stats.w}×${stats.h} @ ${stats.fps} fps\n` +
    `Codec: ${stats.codec}\n` +
    `Bitrate: ${(stats.kbps / 1000).toFixed(1)} Mbit/s\n` +
    `Jitter-Puffer: ${stats.jitterMs} ms`;
}

// Autoplay kann in normalen Browsern blockiert sein; beim Klick erneut starten
document.addEventListener('click', () => video.play().catch(() => {}));
