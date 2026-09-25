'use strict';
// WebRTC-Signalisierung: genau ein Sender (iPhone), beliebig viele Viewer
// (OBS-Browserquelle, Browser-Tab). Der Server leitet nur SDP/ICE weiter,
// das Video selbst fließt direkt per WebRTC im LAN.

const { WebSocketServer } = require('ws');

function createSignaling({ log = () => {} } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const clients = new Map(); // id -> { id, ws, role }
  let senderId = null;
  let nextId = 1;

  const send = (client, msg) => {
    if (client && client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
  };
  const viewers = () => [...clients.values()].filter((c) => c.role === 'viewer');

  wss.on('connection', (ws, req) => {
    const client = { id: String(nextId++), ws, role: null, addr: req.socket.remoteAddress };
    clients.set(client.id, client);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'hello': {
          if (msg.role === 'sender') {
            if (senderId && senderId !== client.id) {
              const old = clients.get(senderId);
              send(old, { type: 'replaced' });
              old?.ws.close(4000, 'replaced');
            }
            client.role = 'sender';
            senderId = client.id;
            log(`Sender verbunden (${client.addr})`);
            send(client, { type: 'welcome', id: client.id, viewers: viewers().map((v) => v.id) });
          } else if (msg.role === 'viewer') {
            client.role = 'viewer';
            log(`Viewer verbunden (${client.addr})`);
            send(client, { type: 'welcome', id: client.id, senderOnline: !!senderId });
            send(clients.get(senderId), { type: 'viewer-joined', id: client.id });
          }
          break;
        }
        case 'request-offer': {
          // Viewer möchte eine neue Verbindung (z. B. nach Verbindungsabbruch)
          if (client.role === 'viewer') send(clients.get(senderId), { type: 'viewer-joined', id: client.id });
          break;
        }
        case 'offer':
        case 'answer':
        case 'candidate': {
          const target = clients.get(String(msg.to));
          if (!target || !client.role) return;
          // Sender spricht nur mit Viewern, Viewer nur mit dem aktuellen Sender
          const allowed =
            (client.role === 'sender' && client.id === senderId && target.role === 'viewer') ||
            (client.role === 'viewer' && target.id === senderId);
          if (!allowed) return;
          send(target, { type: msg.type, from: client.id, sdp: msg.sdp, candidate: msg.candidate });
          break;
        }
      }
    });

    ws.on('close', () => {
      clients.delete(client.id);
      if (client.role === 'sender' && senderId === client.id) {
        senderId = null;
        log('Sender getrennt');
        for (const v of viewers()) send(v, { type: 'sender-left' });
      } else if (client.role === 'viewer') {
        log('Viewer getrennt');
        send(clients.get(senderId), { type: 'viewer-left', id: client.id });
      }
    });
  });

  // Tote Verbindungen erkennen (z. B. iPhone gesperrt, WLAN weg)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 5000);
  wss.on('close', () => clearInterval(heartbeat));

  function handleUpgrade(req, socket, head) {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  return { wss, handleUpgrade };
}

module.exports = { createSignaling };
