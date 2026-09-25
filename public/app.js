'use strict';
// Dashboard: am PC Kopplung (QR-Code), OBS-URL und Live-Vorschau;
// am iPhone ein Hinweis bzw. Sprung zur Kamera-Seite.

const $ = (s) => document.querySelector(s);
const isPhone = /iPhone|iPod|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

for (const el of document.querySelectorAll('.host')) el.textContent = location.host;

if (isPhone) {
  $('#mobile').hidden = false;
  $('#phoneState').hidden = true;
  const last = store.get('room');
  if (last && ROOM_RE.test(last)) {
    const a = $('#resume');
    a.href = `/send#${last}`;
    a.hidden = false;
  }
} else {
  initDesktop();
}

function initDesktop() {
  $('#desktop').hidden = false;
  let room = store.get('pcRoom');
  if (!room || !ROOM_RE.test(room)) {
    room = newRoomId();
    store.set('pcRoom', room);
  }

  const sendUrl = `${location.origin}/send#${room}`;
  const viewUrl = `${location.origin}/view#${room}`;
  $('#qr').innerHTML = qrSvg(sendUrl);
  $('#sendLink').href = sendUrl;
  $('#sendLink').textContent = sendUrl.replace(/#.*/, '#…');
  $('#viewUrl').value = viewUrl;
  $('#openView').href = viewUrl;

  $('#copyView').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(viewUrl);
    } catch {
      $('#viewUrl').select();
      document.execCommand('copy');
    }
    $('#copyView').textContent = 'Kopiert ✓';
    setTimeout(() => ($('#copyView').textContent = 'Kopieren'), 1500);
  });

  $('#newRoom').addEventListener('click', () => {
    if (!confirm('Neuen Code erzeugen? Das iPhone muss danach neu gekoppelt und die OBS-URL ersetzt werden.')) return;
    store.set('pcRoom', newRoomId());
    location.reload();
  });

  // Vorschau: nur aktiv, wenn gewünscht und der Tab sichtbar ist
  const video = $('#preview');
  const toggle = $('#previewOn');
  toggle.checked = store.get('preview') !== 'off';
  let viewer = null;
  let senderOnline = false;

  function setPhone(online) {
    senderOnline = online;
    const chip = $('#phoneState');
    chip.querySelector('.dot').className = 'dot' + (online ? ' ok' : '');
    chip.querySelector('span:last-child').textContent = online ? 'iPhone: verbunden' : 'iPhone: offline';
  }

  function onStatus(s) {
    if ('senderOnline' in s) setPhone(!!s.senderOnline);
    $('#stats').textContent = formatStats(s);
    $('#previewHint').textContent = !senderOnline ? 'Warte auf iPhone …' : s.connected ? '' : 'Verbinde …';
    $('#previewHint').hidden = !!s.connected;
  }

  function update() {
    const want = toggle.checked && document.visibilityState === 'visible';
    if (want && !viewer) {
      viewer = createViewer({ room, video, onStatus });
    } else if (!want && viewer) {
      viewer.stop();
      viewer = null;
      setPhone(false);
      $('#phoneState span:last-child').textContent = 'iPhone: –';
      $('#stats').textContent = '';
      $('#previewHint').hidden = false;
      $('#previewHint').textContent = toggle.checked ? 'Vorschau pausiert' : 'Vorschau aus';
    }
  }
  toggle.addEventListener('change', () => {
    store.set('preview', toggle.checked ? 'on' : 'off');
    update();
  });
  document.addEventListener('visibilitychange', update);
  update();
}
