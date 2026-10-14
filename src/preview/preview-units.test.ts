import { describe, expect, it } from 'vitest';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import { LogBuffer } from './log-buffer';
import {
  REQUIRED_PREVIEW_PREFERENCES,
  createPreviewWebPreferences,
  insecurePreviewPreferences,
  partitionForProject,
} from './preview-options';
import { decidePreviewRequest, isAllowedNavigation, isLoopbackHost } from './request-policy';

const ORIGIN = 'http://127.0.0.1:51234';

describe('preview webPreferences (S04.3)', () => {
  it('have no preload, no Node, context isolation, sandbox and a per-project partition', () => {
    const prefs = createPreviewWebPreferences(partitionForProject('/p'));
    expect(prefs.preload).toBeUndefined();
    expect(prefs).toMatchObject(REQUIRED_PREVIEW_PREFERENCES);
    expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    expect(insecurePreviewPreferences(prefs)).toEqual([]);
  });

  it('reports every weakened value, a preload and a missing partition', () => {
    const prefs = createPreviewWebPreferences(partitionForProject('/p'));
    expect(insecurePreviewPreferences({ ...prefs, sandbox: false, nodeIntegration: true })).toEqual([
      'nodeIntegration',
      'sandbox',
    ]);
    expect(insecurePreviewPreferences({ ...prefs, preload: '/x/preload.cjs' })).toEqual(['preload']);
    expect(insecurePreviewPreferences({ ...prefs, partition: 'persist:shared' })).toEqual(['partition']);
    const { partition: _omit, ...noPartition } = prefs;
    expect(insecurePreviewPreferences(noPartition)).toEqual(['partition']);
  });

  it('gives each project folder its own stable, persistent partition without path text', () => {
    const a = partitionForProject('C:\\Users\\林\\网页 练习\\项目 A');
    const b = partitionForProject('C:\\Users\\林\\网页 练习\\项目 B');
    expect(a).toMatch(/^persist:noobide-preview-[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(partitionForProject('C:\\Users\\林\\网页 练习\\项目 A')).toBe(a);
  });
});

describe('preview request policy (S04.3, S05.5)', () => {
  it.each([
    `${ORIGIN}/index.html`,
    `${ORIGIN}/js/main.js?x=1`,
    'https://cdn.example.com/lib.js',
    'http://example.com/a.png',
    'wss://example.com/socket',
    'data:image/png;base64,AAAA',
    'blob:http://127.0.0.1:51234/1f2e',
  ])('allows %s', (url) => {
    expect(decidePreviewRequest(url, ORIGIN)).toBe('allow');
  });

  it.each([
    'file:///C:/Windows/win.ini',
    'file:///etc/passwd',
    'http://127.0.0.1:51235/',
    'http://127.0.0.1/',
    'http://127.1.2.3:8080/',
    'http://localhost:51234/index.html',
    'http://localhost.:6000/',
    'http://x.localhost.:6000/',
    'http://0.0.0.1:6000/',
    'http://app.localhost/',
    'http://[::1]:51234/',
    'http://0.0.0.0:51234/',
    'http://2130706433:8080/',
    'http://0x7f.1:8080/',
    'http://[::ffff:127.0.0.1]:51234/',
    'ws://127.0.0.1:9229/',
    'https://127.0.0.1:51234/',
    'noobide://app/index.html',
    'ftp://example.com/x',
    'not a url',
  ])('blocks %s', (url) => {
    expect(decidePreviewRequest(url, ORIGIN)).toBe('block');
  });

  it('treats numeric spellings of the server address as the server itself', () => {
    expect(decidePreviewRequest('http://2130706433:51234/', ORIGIN)).toBe('allow');
  });

  it('recognises loopback hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', 'x.localhost', '127.0.0.1', '127.255.0.1', '[::1]', '0.0.0.0']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['example.com', '10.0.0.1', '192.168.1.1', 'localhost.example.com', '128.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('allows top-level navigation only within the project server', () => {
    expect(isAllowedNavigation(`${ORIGIN}/page.html`, ORIGIN)).toBe(true);
    expect(isAllowedNavigation('https://example.com/', ORIGIN)).toBe(false);
    expect(isAllowedNavigation('http://127.0.0.1:1/', ORIGIN)).toBe(false);
    expect(isAllowedNavigation('file:///C:/x.html', ORIGIN)).toBe(false);
    expect(isAllowedNavigation('noobide://app/index.html', ORIGIN)).toBe(false);
    expect(isAllowedNavigation('about:blank', ORIGIN)).toBe(false);
  });
});

describe('log buffer (S05.3)', () => {
  const entry = (n: number): PreviewLogEntry => ({ source: 'console', level: 'info', message: `m${n}`, at: n });

  it('caps a burst and counts what it dropped', () => {
    const buffer = new LogBuffer({ maxBatch: 3, maxMessageLength: 100 });
    for (let i = 0; i < 100_000; i += 1) buffer.push(entry(i));
    expect(buffer.pending).toBe(100_000);
    const batch = buffer.take();
    expect(batch?.entries.map((e) => e.message)).toEqual(['m0', 'm1', 'm2']);
    expect(batch?.dropped).toBe(99_997);
    expect(buffer.take()).toBeNull();
  });

  it('starts a fresh batch after take and truncates long messages', () => {
    const buffer = new LogBuffer({ maxBatch: 2, maxMessageLength: 5 });
    buffer.push({ ...entry(1), message: 'abcdefghij' });
    expect(buffer.take()).toEqual({ entries: [{ ...entry(1), message: 'abcde…' }], dropped: 0, throttled: false });
    buffer.push(entry(2));
    expect(buffer.take()?.entries).toHaveLength(1);
  });

  it('reports a throttled interval even when nothing was counted', () => {
    const buffer = new LogBuffer({ maxBatch: 2, maxMessageLength: 5 });
    buffer.markThrottled();
    expect(buffer.take()).toEqual({ entries: [], dropped: 0, throttled: true });
    expect(buffer.take()).toBeNull();
  });

  it('clear forgets pending records', () => {
    const buffer = new LogBuffer({ maxBatch: 1, maxMessageLength: 5 });
    buffer.push(entry(1));
    buffer.push(entry(2));
    buffer.clear();
    expect(buffer.take()).toBeNull();
  });
});
