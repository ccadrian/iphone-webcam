'use strict';
// /view#<raum> – Empfänger für OBS: randlos, ohne UI, schwarzer Hintergrund.
// Optionen: /view?fit=cover#<raum> (füllen statt einpassen), ?debug=1 (Statistik)

const params = new URLSearchParams(location.search);
const video = document.getElementById('v');
if (params.get('fit') === 'cover') document.body.classList.add('cover');
const debugEl = params.has('debug') ? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'stats' })) : null;

let viewer = null;
function start() {
  viewer?.stop();
  const room = roomFromHash();
  if (!room) {
    if (debugEl) debugEl.textContent = 'Kein Raum-Code in der URL (…/view#CODE)';
    return;
  }
  viewer = createViewer({
    room,
    video,
    onStatus(s) {
      if (!debugEl) return;
      debugEl.textContent =
        `iPhone: ${s.senderOnline ? 'online' : 'offline'}\n` +
        `Verbindung: ${s.state || s.signal || '–'} ${s.kind || ''}\n` +
        `Bild: ${s.w}×${s.h} @ ${s.fps} fps\n` +
        `Codec: ${s.codec}\n` +
        `Bitrate: ${(s.kbps / 1000).toFixed(1)} Mbit/s\n` +
        `Jitter-Puffer: ${s.jitterMs} ms`;
    },
  });
}
window.addEventListener('hashchange', start);
start();

// Autoplay kann in normalen Browsern blockiert sein; beim Klick erneut starten
document.addEventListener('click', () => video.play().catch(() => {}));
