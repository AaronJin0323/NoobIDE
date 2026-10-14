'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS module preloaded with -r */
// S27.2 offline acceptance: preloaded into the Electron MAIN process with `-r` (development binary only; the
// packaged app has the Node CLI fuses off). It turns the Node side of "network disabled" into a hard failure and
// records every attempt: any TCP connection or DNS lookup to a non-loopback host fails like an unplugged network.
// Chromium's side (workbench and preview renderers) is cut by command-line switches in tests/e2e/offline.spec.ts.
// Loopback stays reachable: the preview's static server is on 127.0.0.1 (PLAN §8), which is not "the network".
const net = require('node:net');
const dns = require('node:dns');

/** Hosts the app (or the test's own probes) tried to reach. Host names only, never payloads. */
const attempts = [];
globalThis.__noobideOfflineAttempts = attempts;

function isLoopback(host) {
  if (host === undefined || host === null || host === '') return true; // Node defaults to localhost
  const h = String(host)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h === '::ffff:127.0.0.1';
}

function offlineError(host) {
  const error = new Error(`getaddrinfo ENOTFOUND ${host} (network disabled for the offline test)`);
  error.code = 'ENOTFOUND';
  return error;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options =
    first !== null && typeof first === 'object'
      ? first
      : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (options.path === undefined && !isLoopback(options.host)) {
    attempts.push(String(options.host));
    process.nextTick(() => this.destroy(offlineError(options.host)));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalLookup = dns.lookup;
dns.lookup = function lookup(host, ...rest) {
  if (!isLoopback(host)) {
    attempts.push(String(host));
    const callback = rest.find((a) => typeof a === 'function');
    if (callback) process.nextTick(() => callback(offlineError(host)));
    return {};
  }
  return originalLookup.call(this, host, ...rest);
};

const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = function lookup(host, ...rest) {
  if (!isLoopback(host)) {
    attempts.push(String(host));
    return Promise.reject(offlineError(host));
  }
  return originalPromiseLookup.call(this, host, ...rest);
};
