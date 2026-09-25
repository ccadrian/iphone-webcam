'use strict';
// Erzeugt eine lokale Root-CA und ein davon signiertes Server-Zertifikat.
// Die CA wird einmalig auf dem iPhone installiert und vertraut. Das Server-
// Zertifikat wird automatisch neu ausgestellt, wenn sich die LAN-IP ändert
// oder es bald abläuft; das iPhone muss dafür nichts neu installieren.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');

const DAY = 24 * 60 * 60 * 1000;
// iOS akzeptiert TLS-Serverzertifikate nur mit max. 825 Tagen Laufzeit
// (öffentlich vertraute sogar nur 398). 397 Tage liegen sicher darunter.
const LEAF_DAYS = 397;
const CA_DAYS = 3650;
const RENEW_BEFORE_DAYS = 30;

const VIRTUAL_IF = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|docker|vpn|tailscale|zerotier|hamachi|bluetooth/i;

// Liefert alle IPv4-Adressen, die "echten" LAN-Adaptern bevorzugt vorne.
function getLanAddresses() {
  const result = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      result.push({ name, address: a.address, virtual: VIRTUAL_IF.test(name) });
    }
  }
  const score = (e) => (e.virtual ? 2 : 0) + (isPermittedIp(e.address) ? 0 : 4);
  result.sort((x, y) => score(x) - score(y));
  return result;
}

function ipToInt(ip) {
  return ip.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

function isPermittedIp(ip) {
  const n = ipToInt(ip);
  return PERMITTED_IP_RANGES.some(([base, mask]) => ((n & ipToInt(mask)) >>> 0) === ipToInt(base));
}

function randomSerial() {
  // positive Seriennummer (erstes Byte < 0x80)
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  return b.toString('hex');
}

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    publicKey: forge.pki.publicKeyFromPem(publicKey),
    privatePem: privateKey,
  };
}

// Name Constraints: die CA darf nur Zertifikate für private IPs, localhost und
// *.local ausstellen. Selbst wenn jemand den CA-Schlüssel stiehlt, kann er
// damit keine echten Websites (Bank, Mail, ...) fälschen.
const PERMITTED_IP_RANGES = [
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['169.254.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'],
];
const PERMITTED_DNS = ['localhost', 'local'];

function nameConstraintsDer() {
  const { asn1 } = forge;
  const ipBytes = (ip) => String.fromCharCode(...ip.split('.').map(Number));
  const subtree = (generalName) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName]);
  const permitted = [
    ...PERMITTED_DNS.map((d) => subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, d))),
    ...PERMITTED_IP_RANGES.map(([ip, mask]) => subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, ipBytes(ip) + ipBytes(mask)))),
  ];
  const nc = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, permitted),
  ]);
  return asn1.toDer(nc).getBytes();
}

function createCA() {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * DAY);
  const attrs = [
    { name: 'commonName', value: `iPhone-Webcam lokale CA (${os.hostname()})` },
    { name: 'organizationName', value: 'iPhone-Webcam (nur lokal)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    { id: '2.5.29.30', critical: true, value: nameConstraintsDer() },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

function createLeaf(ca, ips, dnsNames) {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * DAY);
  cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
    {
      name: 'subjectAltName',
      altNames: [
        ...dnsNames.map((value) => ({ type: 2, value })),
        ...ips.map((ip) => ({ type: 7, ip })),
      ],
    },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

function ensureCertificates(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = (f) => path.join(dir, f);

  let ca;
  if (fs.existsSync(p('ca.crt')) && fs.existsSync(p('ca.key'))) {
    ca = { certPem: fs.readFileSync(p('ca.crt'), 'utf8'), keyPem: fs.readFileSync(p('ca.key'), 'utf8') };
  } else {
    ca = createCA();
    fs.writeFileSync(p('ca.crt'), ca.certPem);
    fs.writeFileSync(p('ca.key'), ca.keyPem, { mode: 0o600 });
    // alte Server-Zertifikate passen nicht mehr zur neuen CA
    for (const f of ['server.crt', 'server.key', 'server.json']) fs.rmSync(p(f), { force: true });
  }

  // nur Adressen, die die Name Constraints der CA erlauben
  const ips = ['127.0.0.1', ...getLanAddresses().map((a) => a.address).filter(isPermittedIp)];
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const dnsNames = ['localhost', ...(host ? [`${host}.local`] : [])];

  let reason = null;
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(p('server.json'), 'utf8'));
  } catch {
    reason = 'neu';
  }
  if (!reason && !fs.existsSync(p('server.crt'))) reason = 'fehlt';
  if (!reason && ips.some((ip) => !meta.ips.includes(ip))) reason = 'neue IP-Adresse';
  if (!reason && meta.notAfter - Date.now() < RENEW_BEFORE_DAYS * DAY) reason = 'läuft bald ab';

  if (reason) {
    const leaf = createLeaf(ca, ips, dnsNames);
    fs.writeFileSync(p('server.crt'), leaf.certPem);
    fs.writeFileSync(p('server.key'), leaf.keyPem, { mode: 0o600 });
    fs.writeFileSync(p('server.json'), JSON.stringify({ ips, dnsNames, notAfter: Date.now() + LEAF_DAYS * DAY }, null, 2));
  }

  return {
    // Zertifikatskette mitschicken, damit der Client die CA zuordnen kann
    cert: fs.readFileSync(p('server.crt'), 'utf8') + ca.certPem,
    key: fs.readFileSync(p('server.key'), 'utf8'),
    caCertPem: ca.certPem,
    renewed: reason,
  };
}

module.exports = { ensureCertificates, getLanAddresses, isPermittedIp };
