'use strict';
// Empfänger-Logik (für /view in OBS und die Vorschau im Dashboard).
// Verbindet sich bei Abbrüchen selbstständig neu.

function createViewer({ room, video, onStatus }) {
  let pc = null;
  let senderId = null;
  let senderOnline = false;
  let iceServers = [];
  let lastFrames = 0;
  let stalledSince = 0;
  let lastRequest = 0;
  let stopped = false;
  const stats = { connected: false, fps: 0, w: 0, h: 0, kbps: 0, codec: '', jitterMs: 0, kind: '', lastBytes: 0, lastTs: 0 };

  const status = () => onStatus?.({ senderOnline, ...stats, state: pc ? pc.connectionState : 'none' });

  function closePeer(black) {
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    lastFrames = 0;
    stats.connected = false;
    // schwarz statt eingefrorenem Bild
    if (black) video.srcObject = null;
  }

  function requestOffer(reason) {
    if (Date.now() - lastRequest < 3000) return; // nicht öfter als alle 3 s
    lastRequest = Date.now();
    console.log('Neue Verbindung angefordert:', reason);
    signal.send({ type: 'request-offer' });
  }

  function lowLatency(receiver) {
    // Jitter-Puffer klein halten (Chromium/OBS). Über das Internet etwas Puffer
    // lassen, sonst ruckelt es bei Paketverlust.
    try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = stats.kind.startsWith('lokal') ? 0 : 40; } catch {}
  }

  async function onOffer(msg) {
    closePeer(false);
    senderId = msg.from;
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
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
      stats.connected = s === 'connected';
      if (s === 'failed' || s === 'closed') {
        closePeer(true);
        requestOffer(s);
      } else if (s === 'disconnected') {
        // kurze Aussetzer überbrücken, danach neu aufbauen
        discTimer = setTimeout(() => {
          if (pc === myPc && pc.connectionState === 'disconnected') {
            closePeer(true);
            requestOffer('disconnected');
          }
        }, 4000);
      }
      status();
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal.send({ type: 'answer', to: msg.from, sdp: pc.localDescription.sdp });
  }

  async function onSignal(msg) {
    switch (msg.type) {
      case 'welcome':
        iceServers = msg.iceServers || [];
        senderOnline = msg.senderOnline;
        break;
      case 'sender-joined':
        senderOnline = true;
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
        closePeer(true);
        break;
    }
    status();
  }

  const signal = createSignal({ room, role: 'viewer', onMessage: onSignal, onState: (s) => onStatus?.({ signal: s, senderOnline, ...stats }) });

  // Statistik + Watchdog: kommen trotz Verbindung keine Bilder, neu aufbauen
  const timer = setInterval(async () => {
    if (stopped) return;
    if (!pc) {
      if (senderOnline) requestOffer('keine Verbindung');
      return status();
    }
    let frames = 0;
    try {
      const report = await pc.getStats();
      stats.kind = connectionKind(report);
      report.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        frames = r.framesDecoded || 0;
        stats.fps = Math.round(r.framesPerSecond || 0);
        stats.w = r.frameWidth || 0;
        stats.h = r.frameHeight || 0;
        if (r.jitterBufferEmittedCount) stats.jitterMs = Math.round((1000 * r.jitterBufferDelay) / r.jitterBufferEmittedCount);
        if (stats.lastTs && r.timestamp > stats.lastTs) stats.kbps = Math.round(((r.bytesReceived - stats.lastBytes) * 8) / (r.timestamp - stats.lastTs));
        stats.lastBytes = r.bytesReceived;
        stats.lastTs = r.timestamp;
        const c = r.codecId && report.get(r.codecId);
        if (c) stats.codec = c.mimeType.replace('video/', '');
      });
      for (const r of pc.getReceivers()) lowLatency(r);
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
    status();
  }, 1000);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      signal.close();
      closePeer(true);
    },
  };
}

function formatStats(s) {
  if (!s.connected) return '';
  return `${s.w}×${s.h} · ${s.fps} fps · ${(s.kbps / 1000).toFixed(1)} Mbit/s · ${s.codec}${s.kind ? ' · ' + s.kind : ''}`;
}
