// Gemeinsame Helfer für Sender und Viewer.
'use strict';

// WebSocket mit automatischem Neuverbinden. Nachrichten werden strikt
// nacheinander verarbeitet (wichtig: ICE-Kandidaten erst nach der SDP).
function createSignal({ role, onMessage, onState }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let ws = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  let queue = Promise.resolve();

  function connect() {
    if (closed) return;
    onState?.('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      onState?.('open');
      ws.send(JSON.stringify({ type: 'hello', role }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      queue = queue.then(() => onMessage(msg)).catch((e) => console.error('Signal-Fehler', e));
    };
    ws.onclose = (ev) => {
      ws = null;
      if (closed) return;
      if (ev.code === 4000) { closed = true; onState?.('replaced'); return; }
      onState?.('closed');
      const delay = Math.min(500 * 2 ** retry++, 2000);
      timer = setTimeout(connect, delay);
    };
    ws.onerror = () => {};
  }
  connect();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      clearTimeout(timer);
      if (ws) ws.close();
    },
    // sofort neu verbinden (z. B. wenn die Seite wieder sichtbar wird)
    kick() {
      if (closed) return;
      if (!ws || ws.readyState > WebSocket.OPEN) { clearTimeout(timer); retry = 0; connect(); }
    },
  };
}

// H.264 bevorzugen: auf dem iPhone und den meisten PCs hardwarebeschleunigt,
// das senkt Latenz und Akkuverbrauch. Andere Codecs bleiben als Fallback.
function preferH264(transceiver) {
  if (!transceiver.setCodecPreferences) return;
  // Browser prüfen die Liste unterschiedlich (Empfänger- bzw. Sender-Fähigkeiten),
  // daher beide Varianten probieren.
  for (const Cls of [window.RTCRtpReceiver, window.RTCRtpSender]) {
    try {
      const caps = Cls?.getCapabilities?.('video');
      if (!caps) continue;
      const isH264 = (c) => /h264/i.test(c.mimeType);
      const cb = (c) => (/profile-level-id=42e0/i.test(c.sdpFmtpLine || '') ? 0 : 1);
      // Constrained Baseline zuerst: am breitesten (auch in Hardware) dekodierbar
      const h264 = caps.codecs.filter(isH264).sort((a, b) => cb(a) - cb(b));
      if (!h264.length) return;
      transceiver.setCodecPreferences([...h264, ...caps.codecs.filter((c) => !isH264(c))]);
      return;
    } catch (e) {
      console.warn('Codec-Präferenz nicht gesetzt', e);
    }
  }
}
