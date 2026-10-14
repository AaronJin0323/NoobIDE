// S05.5: a hostile page tries every way out of the project. config.json is written by the e2e test:
// { "secretFileUrl": "file:///…/secret.txt", "otherPortUrl": "http://127.0.0.1:<port>/" }
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
await attempt('ide-bridge', () => {
  if (typeof window.noobide === 'undefined' && typeof require === 'undefined') throw new Error('none');
  return 'bridge present';
});

document.body.dataset.results = JSON.stringify(results);
