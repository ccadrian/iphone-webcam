// Gemeinsame Helfer für Dashboard, Sender und Viewer.
'use strict';

const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;

// 128 Bit Zufall als Raum-Code: nicht erratbar, dient zugleich als Zugangsschlüssel
function newRoomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Raum steht im #-Teil der URL (wird nie an den Server geschickt)
function roomFromHash() {
  const r = decodeURIComponent(location.hash.slice(1)).replace(/^r=/, '');
  return ROOM_RE.test(r) ? r : null;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// WebSocket mit automatischem Neuverbinden und Keepalive. Nachrichten werden
// strikt nacheinander verarbeitet (ICE-Kandidaten erst nach der SDP).
function createSignal({ room, role, onMessage, onState }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(room)}&role=${role}`;
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  let pingTimer = null;
  let lastPong = 0;
  let queue = Promise.resolve();

  function connect() {
    if (closed) return;
    onState?.('connecting');
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      lastPong = Date.now();
      onState?.('open');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        // tote Verbindung (z. B. WLAN-Wechsel) erkennen und neu aufbauen
        if (Date.now() - lastPong > 25000) return sock.close();
        try { sock.send('ping'); } catch {}
      }, 10000);
    };
    sock.onmessage = (ev) => {
      if (ev.data === 'pong') { lastPong = Date.now(); return; }
      lastPong = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      queue = queue.then(() => onMessage(msg)).catch((e) => console.error('Signal-Fehler', e));
    };
    sock.onclose = (ev) => {
      clearInterval(pingTimer);
      if (ws === sock) ws = null;
      if (closed) return;
      if (ev.code === 4000) { closed = true; onState?.('replaced'); return; }
      onState?.('closed');
      const delay = Math.min(500 * 2 ** retry++, 3000);
      timer = setTimeout(connect, delay);
    };
    sock.onerror = () => {};
  }
  connect();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(pingTimer);
      if (ws) ws.close();
    },
    // sofort neu verbinden (z. B. wenn die Seite wieder sichtbar wird)
    kick() {
      if (closed) return;
      if (!ws || ws.readyState > WebSocket.OPEN) { clearTimeout(timer); retry = 0; connect(); }
    },
  };
}

// H.264 bevorzugen (iPhone kodiert es in Hardware = beste Qualität bei wenig
// Last), innerhalb von H.264 das High-Profil (bessere Qualität pro Bit).
// Andere Codecs bleiben als Rückfallebene erhalten.
function preferH264(transceiver) {
  if (!transceiver.setCodecPreferences) return;
  const profileRank = (c) => {
    const p = (/profile-level-id=([0-9a-f]{2})/i.exec(c.sdpFmtpLine || '') || [])[1] || '';
    return { 64: 0, '4d': 1, 42: 2 }[p.toLowerCase()] ?? 3;
  };
  const isH264 = (c) => /h264/i.test(c.mimeType);
  // Browser prüfen die Liste gegen Empfänger- bzw. Sender-Fähigkeiten
  for (const Cls of [window.RTCRtpReceiver, window.RTCRtpSender]) {
    try {
      const caps = Cls?.getCapabilities?.('video');
      if (!caps) continue;
      const h264 = caps.codecs.filter(isH264).sort((a, b) => profileRank(a) - profileRank(b));
      if (!h264.length) return;
      transceiver.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !isH264(c))]);
      return;
    } catch (e) {
      console.warn('Codec-Präferenz nicht gesetzt', e);
    }
  }
}

// Art der Verbindung aus den WebRTC-Statistiken
function connectionKind(report) {
  let pair = null;
  report.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId);
  });
  if (!pair) report.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
  if (!pair) return '';
  const l = report.get(pair.localCandidateId);
  const r = report.get(pair.remoteCandidateId);
  const types = [l?.candidateType, r?.candidateType];
  if (types.includes('relay')) return 'über TURN-Server';
  if (types.every((t) => t === 'host')) return 'lokal (WLAN)';
  return 'direkt (Internet)';
}

// QR-Code als SVG (eigene Pfade, ohne Inline-Styles wegen CSP)
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="QR-Code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
