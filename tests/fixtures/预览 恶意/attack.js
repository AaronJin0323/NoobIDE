// S05.5: a hostile page tries every way out of the project. config.json is written by the e2e test:
// { "secretFileUrl": "file:///…/secret.txt", "otherPortUrl": "http://127.0.0.1:<port>/", "otherPort": <port>,
//   "lanUrl": "http://<this machine's LAN address>:<port>/" | null, "machineName": "<os.hostname()>" }
// The e2e run maps rebind.test to 127.0.0.1 in Chromium's resolver (--host-resolver-rules), like a public DNS name
// that points at loopback (localtest.me, *.nip.io) or a DNS-rebinding attack.
const config = await (await fetch('config.json')).json();
const results = {};

async function readText(response) {
  if (!response.ok) throw new Error(`status ${response.status}`);
  return response.text();
}

async function attempt(name, run) {
  try {
    const text = await run();
    results[name] = `READ ${String(text).slice(0, 40)}`;
  } catch {
    results[name] = 'failed';
  }
}

function xhr(url) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.onload = () => (request.status === 200 ? resolve(request.responseText) : reject(new Error('status')));
    request.onerror = () => reject(new Error('network'));
    request.send();
  });
}

await attempt('file-fetch', () => fetch(config.secretFileUrl).then(readText));
await attempt('file-xhr', () => xhr(config.secretFileUrl));
await attempt('traversal', () => fetch('/../secret.txt').then(readText));
await attempt('encoded-traversal', () => fetch('/%2e%2e/secret.txt').then(readText));
await attempt('double-encoded-traversal', () => fetch('/%252e%252e/secret.txt').then(readText));
await attempt('encoded-backslash', () => fetch('/..%5csecret.txt').then(readText));
await attempt('symlink-escape', () => fetch('/jump/secret.txt').then(readText));
await attempt('dotfile', () => fetch('/.env').then(readText));
await attempt('other-loopback-port', () => fetch(config.otherPortUrl).then(readText));
await attempt('other-loopback-port-no-cors', () =>
  fetch(config.otherPortUrl, { mode: 'no-cors' }).then(() => 'opaque response'),
);
await attempt('localhost-alias', () => fetch(`http://localhost:${location.port}/index.html`).then(readText));
await attempt('ipv6-loopback', () => fetch(`http://[::1]:${location.port}/index.html`).then(readText));
await attempt('websocket-other-port', () =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(config.otherPortUrl.replace('http', 'ws'));
    socket.onopen = () => resolve('open');
    socket.onerror = () => reject(new Error('ws'));
  }),
);
await attempt('dns-name-to-loopback', () => fetch(`http://rebind.test:${config.otherPort}/`).then(readText));
await attempt('dns-name-to-loopback-no-cors', () =>
  fetch(`http://rebind.test:${config.otherPort}/`, { mode: 'no-cors' }).then(() => 'opaque response'),
);
await attempt('dns-name-to-server', () => fetch(`http://rebind.test:${location.port}/index.html`).then(readText));
await attempt('websocket-dns-name', () =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://rebind.test:${config.otherPort}/`);
    socket.onopen = () => resolve('open');
    socket.onerror = () => reject(new Error('ws'));
  }),
);
await attempt('public-dns-name-to-loopback', () =>
  fetch(`http://localtest.me:${config.otherPort}/`, { mode: 'no-cors' }).then(() => 'opaque response'),
);
await attempt('machine-name', () =>
  fetch(`http://${config.machineName}:${config.otherPort}/`, { mode: 'no-cors' }).then(() => 'opaque response'),
);
await attempt('lan-ip', () => {
  if (!config.lanUrl) throw new Error('no LAN address on this machine');
  return fetch(config.lanUrl, { mode: 'no-cors' }).then(() => 'opaque response');
});
await attempt('zero-address', () =>
  fetch(`http://0.0.0.0:${config.otherPort}/`, { mode: 'no-cors' }).then(() => 'opaque response'),
);
await attempt('image-dns-name', () =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve('loaded');
    img.onerror = () => reject(new Error('img'));
    img.src = `http://rebind.test:${config.otherPort}/pixel.png`;
  }),
);
await attempt('service-worker', async () => {
  const registration = await navigator.serviceWorker.register('sw.js');
  return `registered ${registration.scope}`;
});
// The "Open in browser" grant (S15.4) can only be redeemed by a top-level visit the user started; a page cannot
// guess one, and redeeming from the page (Sec-Fetch-Site: same-origin) is refused even with a valid token.
await attempt('external-browser-grant', () => fetch(`/.noobide-grant/${'0'.repeat(64)}`).then(readText));
await attempt('ide-bridge', () => {
  if (typeof window.noobide === 'undefined' && typeof require === 'undefined') throw new Error('none');
  return 'bridge present';
});

document.body.dataset.results = JSON.stringify(results);
