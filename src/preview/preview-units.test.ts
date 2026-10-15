import { describe, expect, it } from 'vitest';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import { LogBuffer, MAX_LOG_URL_LENGTH, sanitizeLogUrl } from './log-buffer';
import {
  DISABLED_CHROMIUM_FEATURES,
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
    // S25.4: no Web Bluetooth (on macOS it made the system end the whole IDE).
    expect(prefs.disableBlinkFeatures).toBe('WebBluetooth');
    expect(insecurePreviewPreferences({ ...prefs, disableBlinkFeatures: '' })).toEqual(['disableBlinkFeatures']);
  });

  it('keeps sandboxed iframes in the page process, where the console limit reaches them (decision 0016)', () => {
    expect(DISABLED_CHROMIUM_FEATURES.split(',')).toContain('IsolateSandboxedIframes');
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

  it('adds the count suppressed by the in-page rate limit to dropped (S05.7)', () => {
    const buffer = new LogBuffer({ maxBatch: 2, maxMessageLength: 5 });
    buffer.push(entry(1));
    buffer.addDropped(1234);
    buffer.addDropped(-5);
    buffer.addDropped(Number.NaN);
    expect(buffer.take()).toEqual({ entries: [entry(1)], dropped: 1234, throttled: false });
  });

  it('keeps IDE notices about the page even when the batch is full', () => {
    const buffer = new LogBuffer({ maxBatch: 2, maxMessageLength: 5 });
    for (let i = 0; i < 10; i += 1) buffer.push(entry(i));
    const notice: PreviewLogEntry = {
      source: 'page-load',
      level: 'warning',
      message: 'console flood: the running script was stopped',
      notice: { kind: 'console-flood-stopped' },
      at: 11,
    };
    buffer.pushNotice(notice);
    const batch = buffer.take();
    expect(batch?.entries.at(-1)).toBe(notice); // not truncated, not dropped
    expect(batch?.dropped).toBe(8);
  });

  it('keeps blocked-link notices under the batch cap (a page can open windows in a loop)', () => {
    const buffer = new LogBuffer({ maxBatch: 3, maxMessageLength: 100 });
    for (let i = 0; i < 50; i += 1) {
      buffer.pushNotice({
        source: 'page-load',
        level: 'warning',
        message: 'window.open blocked',
        notice: { kind: 'link-blocked', how: 'new-window' },
        at: i,
      });
    }
    const batch = buffer.take();
    expect(batch?.entries).toHaveLength(3);
    expect(batch?.dropped).toBe(47);
  });

  it('clear forgets pending records', () => {
    const buffer = new LogBuffer({ maxBatch: 1, maxMessageLength: 5 });
    buffer.push(entry(1));
    buffer.push(entry(2));
    buffer.clear();
    expect(buffer.take()).toBeNull();
  });
});

describe('log URL sanitising (S05.5: logs never contain source code)', () => {
  it('keeps ordinary project and web URLs unchanged', () => {
    for (const url of [
      `${ORIGIN}/js/main.js`,
      `${ORIGIN}/%E4%B8%AD%E6%96%87/a.js?v=2#x`,
      'https://cdn.example.com/lib.js',
      'blob:http://127.0.0.1:51234/1f2e',
      '',
    ]) {
      expect(sanitizeLogUrl(url)).toBe(url);
    }
  });

  it('reduces data: and javascript: URLs, which carry content, to their type and length', () => {
    const code = 'data:text/html,<script>const secret = "source code";</script>';
    expect(sanitizeLogUrl(code)).toBe(`data:text/html,… (${code.length})`);
    expect(sanitizeLogUrl('DATA:;base64,QUJD')).toBe('data:,… (17)');
    expect(sanitizeLogUrl('javascript:alert(document.cookie)')).toBe('javascript:… (33)');
  });

  it('removes credentials and control characters and truncates long URLs', () => {
    expect(sanitizeLogUrl('https://user:pa55@example.com/x')).toBe('https://example.com/x');
    expect(sanitizeLogUrl('http://a.test/\nfake')).toBe('http://a.test/fake');
    const long = `${ORIGIN}/a?q=${'x'.repeat(5_000)}`;
    const out = sanitizeLogUrl(long);
    expect(out).toHaveLength(MAX_LOG_URL_LENGTH + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith(`${ORIGIN}/a?q=`)).toBe(true);
  });
});
