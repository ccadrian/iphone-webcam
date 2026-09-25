// Cloudflare Worker: liefert die Web-App aus (statische Dateien aus ./public)
// und vermittelt WebRTC-Verbindungen. Jeder Raum (= Kopplung iPhone <-> PC)
// ist ein eigenes Durable Object. Das Video selbst läuft direkt zwischen
// iPhone und PC (oder über TURN), nie über den Worker.

import { DurableObject } from 'cloudflare:workers';

const ROOM_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_VIEWERS = 6;
const MAX_MESSAGE = 64 * 1024;
const ICE_CACHE_MS = 6 * 60 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const room = url.searchParams.get('room') || '';
      const role = url.searchParams.get('role');
      if (!ROOM_RE.test(room) || (role !== 'sender' && role !== 'viewer')) {
        return new Response('Ungültiger Raum oder Rolle', { status: 400 });
      }
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        console.log('kein WebSocket-Upgrade', JSON.stringify({
          upgrade: request.headers.get('Upgrade'),
          connection: request.headers.get('Connection'),
          proto: request.cf?.httpProtocol,
          ua: request.headers.get('User-Agent'),
        }));
        return new Response('WebSocket erwartet', { status: 426 });
      }
      // nur Seiten von dieser Domain dürfen sich verbinden
      const origin = request.headers.get('Origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch {}
        if (host !== url.host) return new Response('Fremder Origin', { status: 403 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      return stub.fetch(request);
    }

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, turn: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) || !!env.ICE_SERVERS_JSON });
    }

    return env.ASSETS.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive der Clients beantworten, ohne das Objekt aufzuwecken
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.ice = null;
  }

  // ---------------------------------------------------------------- Helfer

  info(ws) {
    return ws.deserializeAttachment() || {};
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  sockets(role) {
    return this.ctx.getWebSockets(role).filter((ws) => !this.info(ws).gone);
  }

  sender() {
    return this.sockets('sender')[0] || null;
  }

  byId(id) {
    return this.sockets().find((ws) => this.info(ws).id === id) || null;
  }

  async iceServers() {
    if (this.ice && this.ice.expires > Date.now()) return this.ice.servers;
    let servers = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

    if (this.env.ICE_SERVERS_JSON) {
      // eigener TURN-Server (z. B. coturn), als JSON-Liste im Secret
      try { servers = JSON.parse(this.env.ICE_SERVERS_JSON); } catch {}
    } else if (this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN) {
      // Cloudflare Realtime TURN: kurzlebige Zugangsdaten erzeugen
      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: 24 * 60 * 60 }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          const list = (Array.isArray(data.iceServers) ? data.iceServers : [data.iceServers])
            .filter(Boolean)
            // Port 53 wird von Browsern oft blockiert und verzögert nur den Aufbau
            .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
            .filter((s) => s.urls.length);
          if (list.length) servers = list;
        } else {
          console.log('TURN-API Fehler', res.status, await res.text());
        }
      } catch (e) {
        console.log('TURN-API nicht erreichbar', e);
      }
    }
    this.ice = { servers, expires: Date.now() + ICE_CACHE_MS };
    return servers;
  }

  // ---------------------------------------------------------------- Verbindungsaufbau

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    if (role === 'viewer' && this.sockets('viewer').length >= MAX_VIEWERS) {
      return new Response('Zu viele Empfänger in diesem Raum', { status: 429 });
    }

    const iceServers = await this.iceServers();
    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);

    if (role === 'sender') {
      // es sendet immer nur ein iPhone; ein neues ersetzt das alte
      for (const old of this.sockets('sender')) {
        old.serializeAttachment({ ...this.info(old), gone: true });
        this.send(old, { type: 'replaced' });
        try { old.close(4000, 'replaced'); } catch {}
      }
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ id, role });

    if (role === 'sender') {
      const viewers = this.sockets('viewer').map((ws) => this.info(ws).id);
      this.send(server, { type: 'welcome', id, viewers, iceServers });
      for (const v of this.sockets('viewer')) this.send(v, { type: 'sender-joined' });
    } else {
      const sender = this.sender();
      this.send(server, { type: 'welcome', id, senderOnline: !!sender, iceServers });
      if (sender) this.send(sender, { type: 'viewer-joined', id });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- Nachrichten

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const me = this.info(ws);
    if (me.gone) return;

    switch (msg.type) {
      case 'request-offer': {
        // Viewer möchte eine neue Verbindung (z. B. nach Abbruch)
        const sender = this.sender();
        if (me.role === 'viewer' && sender) this.send(sender, { type: 'viewer-joined', id: me.id });
        break;
      }
      case 'offer':
      case 'answer':
      case 'candidate': {
        const target = this.byId(String(msg.to));
        if (!target) return;
        const t = this.info(target);
        // Sender spricht nur mit Viewern, Viewer nur mit dem Sender
        const allowed = (me.role === 'sender' && t.role === 'viewer') || (me.role === 'viewer' && t.role === 'sender');
        if (!allowed) return;
        this.send(target, { type: msg.type, from: me.id, sdp: msg.sdp, candidate: msg.candidate });
        break;
      }
    }
  }

  async webSocketClose(ws, code) {
    this.left(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const me = this.info(ws);
    if (me.gone) return; // ersetzter Sender: nichts melden
    ws.serializeAttachment({ ...me, gone: true });
    if (me.role === 'sender') {
      for (const v of this.sockets('viewer')) this.send(v, { type: 'sender-left' });
    } else if (me.role === 'viewer') {
      const sender = this.sender();
      if (sender) this.send(sender, { type: 'viewer-left', id: me.id });
    }
  }
}
