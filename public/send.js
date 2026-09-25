'use strict';
// Sender-Seite (iPhone / Safari): Kamera aufnehmen und per WebRTC an alle
// verbundenen Viewer schicken. Signalisierung über den WebSocket des Servers.

const RES = {
  1080: { width: 1920, height: 1080, maxBitrate: 8_000_000, startKbps: 5000 },
  720: { width: 1280, height: 720, maxBitrate: 4_000_000, startKbps: 2500 },
};
const FPS = 30;

const $ = (s) => document.querySelector(s);
const video = $('#preview');
const btn = $('#startStop');
const banner = $('#banner');

const state = {
  facing: 'environment',
  res: '1080',
  running: false,
  busy: false,
  stream: null,
  signal: null,
  pcs: new Map(), // viewerId -> RTCPeerConnection
  wakeLock: null,
};

function showBanner(text, isError = false) {
  banner.textContent = text;
  banner.classList.toggle('err', isError);
  banner.hidden = !text;
}

function setDot(el, cls) {
  el.className = 'dot' + (cls ? ' ' + cls : '');
}

function updatePeersUi() {
  const all = [...state.pcs.values()];
  const connected = all.filter((pc) => pc.connectionState === 'connected').length;
  $('#txtPeers').textContent = `Empfänger: ${connected}${all.length > connected ? ` (+${all.length - connected} verbinden…)` : ''}`;
  setDot($('#dotPeers'), connected ? 'ok' : all.length ? 'warn' : '');
}

// ---------------------------------------------------------------- Kamera

function stopStream() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
}

async function openCamera() {
  // iOS erlaubt nur eine aktive Kamera: alte Tracks vorher beenden
  stopStream();
  const r = RES[state.res];
  const video = {
    width: { ideal: r.width },
    height: { ideal: r.height },
    frameRate: { ideal: FPS, max: FPS },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, facingMode: { exact: state.facing } } });
  } catch (e) {
    if (e.name !== 'OverconstrainedError') throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, facingMode: state.facing } });
  }
  const track = stream.getVideoTracks()[0];
  // 'motion' = Bildrate hat Vorrang vor Schärfe (flüssiges Webcam-Bild)
  try { track.contentHint = 'motion'; } catch {}
  track.addEventListener('ended', onTrackEnded);
  state.stream = stream;
  showStream();
  return track;
}

function showStream() {
  video.srcObject = state.stream;
  video.classList.toggle('mirror', state.facing === 'user'); // nur die Vorschau gespiegelt
  video.play().catch(() => {});
}

async function onTrackEnded() {
  // passiert z. B. wenn iOS die Kamera im Hintergrund freigibt
  if (!state.running || document.visibilityState !== 'visible') return;
  await restartCamera();
}

async function restartCamera() {
  if (state.busy) return;
  state.busy = true;
  try {
    const track = await openCamera();
    await Promise.all([...state.pcs.values()].map((pc) => attachTrack(pc, track)));
    updateVideoInfo();
  } catch (e) {
    handleCameraError(e);
  } finally {
    state.busy = false;
  }
}

function handleCameraError(e) {
  console.error(e);
  const msg = {
    NotAllowedError: 'Kamerazugriff verweigert. Safari: „aA“ in der Adressleiste → Website-Einstellungen → Kamera → Erlauben, dann neu laden.',
    NotReadableError: 'Kamera ist belegt (andere App/Tab nutzt sie?). Andere Kamera-Apps schließen und erneut starten.',
    NotFoundError: 'Keine passende Kamera gefunden.',
  }[e.name] || `Kamera-Fehler: ${e.name || ''} ${e.message || e}`;
  showBanner(msg, true);
}

function updateVideoInfo() {
  const track = state.stream?.getVideoTracks()[0];
  if (!track) return ($('#txtVideo').textContent = '');
  const s = track.getSettings();
  const w = s.width || video.videoWidth;
  const h = s.height || video.videoHeight;
  $('#txtVideo').textContent = w ? `${w}×${h} @ ${Math.round(s.frameRate || FPS)} fps` : '';
  if (state.running && w && h > w) {
    showBanner('Tipp: iPhone quer halten, dann ist das Bild 16:9 wie bei einer Webcam.');
  } else if (banner.textContent.startsWith('Tipp:')) {
    showBanner('');
  }
}
video.addEventListener('resize', updateVideoInfo);
video.addEventListener('loadedmetadata', updateVideoInfo);

// ---------------------------------------------------------------- WebRTC

async function applyEncoding(sender) {
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = RES[state.res].maxBitrate;
  params.encodings[0].maxFramerate = FPS;
  // bei Engpässen lieber Auflösung als Bildrate reduzieren
  params.degradationPreference = 'maintain-framerate';
  try {
    await sender.setParameters(params);
  } catch {
    delete params.degradationPreference; // nicht jeder Browser kennt das Feld
    try { await sender.setParameters(params); } catch (e) { console.warn('setParameters', e); }
  }
}

// WebRTC startet normalerweise mit ~300 kbit/s und tastet sich hoch; im LAN ist
// sofort viel Bandbreite da. Höhere Startbitrate = sofort scharfes Bild.
function withStartBitrate(sdp) {
  const kbps = RES[state.res].startKbps;
  const lines = sdp.split('\r\n');
  const videoPts = new Set();
  const withFmtp = new Set();
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(l);
    if (m) videoPts.add(m[1]);
    const f = /^a=fmtp:(\d+) /.exec(l);
    if (f) withFmtp.add(f[1]);
  }
  const out = [];
  for (const l of lines) {
    const f = /^a=fmtp:(\d+) /.exec(l);
    if (f && videoPts.has(f[1]) && !l.includes('x-google-start-bitrate')) {
      out.push(`${l};x-google-start-bitrate=${kbps}`);
      continue;
    }
    out.push(l);
    // Codecs ohne fmtp-Zeile (z. B. VP8) bekommen eine eigene
    const r = /^a=rtpmap:(\d+) /.exec(l);
    if (r && videoPts.has(r[1]) && !withFmtp.has(r[1])) out.push(`a=fmtp:${r[1]} x-google-start-bitrate=${kbps}`);
  }
  return out.join('\r\n');
}

async function attachTrack(pc, track) {
  const sender = pc.getSenders()[0];
  if (!sender) return;
  await sender.replaceTrack(track);
  await applyEncoding(sender);
}

function closePeer(id) {
  const pc = state.pcs.get(id);
  if (!pc) return;
  pc.onconnectionstatechange = pc.onicecandidate = null;
  pc.close();
  state.pcs.delete(id);
  updatePeersUi();
}

function closeAllPeers() {
  for (const id of [...state.pcs.keys()]) closePeer(id);
}

async function createPeer(viewerId) {
  closePeer(viewerId);
  const track = state.stream?.getVideoTracks()[0];
  if (!track) return;

  // Keine STUN/TURN-Server: nur lokale Verbindung im Heimnetz
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  state.pcs.set(viewerId, pc);

  const tx = pc.addTransceiver(track, {
    direction: 'sendonly',
    streams: [state.stream],
    sendEncodings: [{ maxBitrate: RES[state.res].maxBitrate, maxFramerate: FPS }],
  });
  preferH264(tx);

  pc.onicecandidate = (e) => {
    if (e.candidate) state.signal?.send({ type: 'candidate', to: viewerId, candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    updatePeersUi();
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(viewerId);
    // Der Viewer fordert bei Bedarf selbst eine neue Verbindung an.
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await applyEncoding(tx.sender);
  state.signal?.send({ type: 'offer', to: viewerId, sdp: pc.localDescription.sdp });
  updatePeersUi();
}

async function onSignal(msg) {
  switch (msg.type) {
    case 'welcome':
      // (Neu-)Verbindung zum Server: alle bekannten Viewer neu versorgen
      closeAllPeers();
      for (const id of msg.viewers) await createPeer(id);
      break;
    case 'viewer-joined':
      await createPeer(msg.id);
      break;
    case 'viewer-left':
      closePeer(msg.id);
      break;
    case 'answer': {
      const pc = state.pcs.get(msg.from);
      if (pc && pc.signalingState === 'have-local-offer') await pc.setRemoteDescription({ type: 'answer', sdp: withStartBitrate(msg.sdp) });
      break;
    }
    case 'candidate': {
      const pc = state.pcs.get(msg.from);
      if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch((e) => console.warn('ICE', e));
      break;
    }
    case 'replaced':
      showBanner('Ein anderes Gerät sendet jetzt. Dieses iPhone wurde gestoppt.', true);
      await stop();
      break;
  }
}

function onSignalState(s) {
  const map = {
    open: ['ok', 'Server: verbunden'],
    connecting: ['warn', 'Server: verbinde…'],
    closed: ['err', 'Server: getrennt – neuer Versuch…'],
    replaced: ['err', 'Server: ersetzt'],
  };
  const [cls, txt] = map[s] || ['', `Server: ${s}`];
  setDot($('#dotServer'), cls);
  $('#txtServer').textContent = txt;
}

// Sende-Statistik in der Statuszeile (hilft bei der Fehlersuche)
let lastOut = null;
setInterval(async () => {
  const pc = [...state.pcs.values()].find((p) => p.connectionState === 'connected');
  if (!pc || !state.running) return updateVideoInfo();
  const report = await pc.getStats().catch(() => null);
  report?.forEach((r) => {
    if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
    const mbps = lastOut ? ((r.bytesSent - lastOut.bytesSent) * 8) / (r.timestamp - lastOut.timestamp) / 1000 : 0;
    lastOut = r;
    const limit = { cpu: ' · Limit: CPU/Hitze', bandwidth: ' · Limit: WLAN' }[r.qualityLimitationReason] || '';
    $('#txtVideo').textContent =
      `Senden: ${r.frameWidth || '?'}×${r.frameHeight || '?'} · ${Math.round(r.framesPerSecond || 0)} fps · ${mbps.toFixed(1)} Mbit/s${limit}`;
  });
}, 1000);

// ---------------------------------------------------------------- Wake Lock

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    showBanner('Dieses iOS kennt keinen Wake Lock. Bitte Einstellungen → Anzeige & Helligkeit → Automatische Sperre → Nie.');
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => (state.wakeLock = null));
  } catch (e) {
    console.warn('Wake Lock', e);
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.running) return;
  // nach Sperren/App-Wechsel: Wake Lock, Kamera und Server-Verbindung wiederherstellen
  if (!state.wakeLock) requestWakeLock();
  const track = state.stream?.getVideoTracks()[0];
  if (!track || track.readyState === 'ended') await restartCamera();
  else video.play().catch(() => {});
  state.signal?.kick();
});

// ---------------------------------------------------------------- Start/Stopp

async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showBanner('Kein sicherer Kontext: Seite muss per https:// geöffnet werden und das Zertifikat muss vertraut sein (siehe README).', true);
    return;
  }
  btn.disabled = true;
  showBanner('');
  try {
    await openCamera();
  } catch (e) {
    handleCameraError(e);
    btn.disabled = false;
    return;
  }
  state.running = true;
  await requestWakeLock();
  state.signal = createSignal({ role: 'sender', onMessage: onSignal, onState: onSignalState });
  btn.textContent = 'Stopp';
  btn.classList.add('running');
  btn.disabled = false;
  updateVideoInfo();
}

async function stop() {
  state.running = false;
  state.signal?.close();
  state.signal = null;
  closeAllPeers();
  stopStream();
  video.srcObject = null;
  releaseWakeLock();
  btn.textContent = 'Start';
  btn.classList.remove('running');
  setDot($('#dotServer'), '');
  $('#txtServer').textContent = 'Server: –';
  updatePeersUi();
  updateVideoInfo();
}

btn.addEventListener('click', () => (state.running ? stop() : start()));

// Umschalter Kamera / Auflösung (auch während der Übertragung)
for (const group of document.querySelectorAll('.seg')) {
  group.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.getAttribute('aria-pressed') === 'true' || state.busy) return;
    for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    if (b.dataset.facing) state.facing = b.dataset.facing;
    if (b.dataset.res) state.res = b.dataset.res;
    if (state.running) await restartCamera();
  });
}

// Doppeltipp-Zoom auf iOS verhindern
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

if (!window.isSecureContext) {
  showBanner('Achtung: Diese Seite muss über https:// geöffnet werden, sonst gibt Safari die Kamera nicht frei.', true);
}
updatePeersUi();
