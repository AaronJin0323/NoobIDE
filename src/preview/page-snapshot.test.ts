import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_LIMITS,
  SNAPSHOT_WORLD,
  captureOutline,
  captureScreenshot,
  formatOutline,
  outlineScript,
  pagePathOf,
  pngSize,
  parseOutline,
  scaledSize,
  takeSnapshot,
  type SnapshotContents,
} from './page-snapshot';

const FAST = { ...SNAPSHOT_LIMITS, outlineTimeoutMs: 50, screenshotTimeoutMs: 50 };

/** A buffer with a PNG signature and IHDR of the given size, padded to `bytes`. */
function fakePng(width: number, height: number, bytes = 1000): Buffer {
  const png = Buffer.alloc(Math.max(bytes, 24));
  png.writeUInt32BE(0x89504e47, 0);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

/** `density` > 1: a HiDPI capture whose bitmap has more pixels than its DIP size. */
function fakeImage(width: number, height: number, bytes = 1000, density = 1): NativeImageFake {
  return {
    isEmpty: () => width === 0,
    getSize: () => ({ width, height }),
    resize: (o: { width: number; height: number }) => fakeImage(o.width, o.height, bytes, density),
    toPNG: () => fakePng(width * density, height * density, bytes),
  };
}
interface NativeImageFake {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(o: { width: number; height: number }): NativeImageFake;
  toPNG(): Buffer;
}

function fakeContents(
  options: {
    attached?: boolean;
    answer?: (method: string, params?: object) => Promise<unknown>;
    image?: () => Promise<NativeImageFake>;
    url?: string;
    title?: string;
  } = {},
): SnapshotContents & { calls: { method: string; params?: object }[] } {
  const calls: { method: string; params?: object }[] = [];
  return {
    calls,
    isDestroyed: () => false,
    getURL: () => options.url ?? 'http://127.0.0.1:5000/pages/%E9%A6%96%E9%A1%B5.html?x=1',
    getTitle: () => options.title ?? 'My page',
    debugger: {
      isAttached: () => options.attached ?? true,
      sendCommand: (method: string, params?: object) => {
        calls.push({ method, ...(params ? { params } : {}) });
        if (options.answer) return options.answer(method, params);
        if (method === 'Target.getTargetInfo') return Promise.resolve({ targetInfo: { targetId: 'FRAME1' } });
        if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
        if (method === 'Runtime.evaluate')
          return Promise.resolve({
            result: { value: { items: [{ kind: 'heading', level: 1, text: 'Hello' }], truncated: false } },
          });
        return Promise.reject(new Error('unknown'));
      },
    },
    capturePage: options.image ?? (() => Promise.resolve(fakeImage(800, 600))),
  };
}

describe('outline script (S38.1)', () => {
  it('is one self-contained expression with the limits as literals', () => {
    const source = outlineScript();
    expect(() => new Function(`return ${source}`)).not.toThrow();
    expect(source).not.toContain('${');
    expect(source).toContain(`"visit":${SNAPSHOT_LIMITS.visitElements}`);
    expect(source).toContain(`"budget":${SNAPSHOT_LIMITS.scriptBudgetMs}`);
    // It only reads: no writes to the DOM, no events, no network, no storage.
    for (const word of [
      'appendChild',
      'innerHTML',
      'dispatchEvent',
      'fetch(',
      'XMLHttpRequest',
      'localStorage',
      'postMessage',
      'setAttribute',
    ]) {
      expect(source).not.toContain(word);
    }
  });
});

describe('parseOutline', () => {
  it('keeps known items, drops the rest and caps every string', () => {
    const long = 'x'.repeat(5000);
    const parsed = parseOutline({
      items: [
        { kind: 'heading', level: 2, text: '  Hello\n  world ' },
        { kind: 'link', text: 'About', href: 'about.html' },
        { kind: 'button', text: long, id: 'send' },
        { kind: 'field', tag: 'input', type: 'email', name: 'email', label: 'Your email', hidden: true },
        { kind: 'image', alt: 'Logo', src: 'logo.png' },
        { kind: 'script', text: 'evil' },
        'not an object',
        { kind: 'heading', level: 99, text: 7 },
      ],
      truncated: false,
    });
    expect(parsed?.items).toHaveLength(6);
    expect(parsed?.items[0]).toEqual({ kind: 'heading', level: 2, text: 'Hello world' });
    const button = parsed?.items[2];
    expect(button?.kind === 'button' && button.text.length).toBe(SNAPSHOT_LIMITS.itemChars + 1);
    expect(parsed?.items[5]).toEqual({ kind: 'heading', level: 1, text: '' });
  });

  it('refuses a result without items and bounds the number of items', () => {
    expect(parseOutline(null)).toBeNull();
    expect(parseOutline({ items: 'x' })).toBeNull();
    const many = parseOutline({
      items: Array.from({ length: 5000 }, () => ({ kind: 'heading', level: 1, text: 'a' })),
    });
    expect(many?.items).toHaveLength(SNAPSHOT_LIMITS.items);
    expect(many?.truncated).toBe(true);
  });
});

describe('formatOutline', () => {
  it('writes one line per item and stops at the character cap', () => {
    const { text } = formatOutline({
      items: [
        { kind: 'heading', level: 1, text: '欢迎' },
        { kind: 'button', text: 'Send', id: 'send' },
        { kind: 'field', tag: 'input', type: 'email', name: 'email', label: 'Your email' },
        { kind: 'image', alt: '', src: 'a.png', hidden: true },
      ],
      truncated: false,
    });
    expect(text.split('\n')).toEqual([
      'h1 "欢迎"',
      'button "Send" id="send"',
      'field input[type=email] name="email" label="Your email"',
      'image alt="" src="a.png" (hidden)',
    ]);
    const huge = formatOutline({
      items: Array.from({ length: 300 }, () => ({ kind: 'heading' as const, level: 1, text: 'y'.repeat(160) })),
      truncated: false,
    });
    expect(huge.text.length).toBeLessThanOrEqual(SNAPSHOT_LIMITS.outlineChars);
    expect(huge.truncated).toBe(true);
  });
});

describe('pagePathOf / scaledSize', () => {
  it('gives the decoded path inside the project only for the preview origin', () => {
    expect(pagePathOf('http://127.0.0.1:5000/pages/%E9%A6%96%E9%A1%B5.html?q=1', 'http://127.0.0.1:5000')).toBe(
      'pages/首页.html',
    );
    expect(pagePathOf('http://127.0.0.1:5000/', 'http://127.0.0.1:5000')).toBe('');
    expect(pagePathOf('https://example.com/x', 'http://127.0.0.1:5000')).toBeNull();
    expect(pagePathOf('about:blank', 'http://127.0.0.1:5000')).toBeNull();
  });
  it('scales the longest side down, never up', () => {
    expect(scaledSize(2048, 1024, 1024)).toEqual({ width: 1024, height: 512 });
    expect(scaledSize(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });
});

describe('captureOutline', () => {
  it('evaluates in an isolated world of the main frame, never in the page world', async () => {
    const contents = fakeContents();
    const outline = await captureOutline(contents);
    expect(outline.ok).toBe(true);
    expect(contents.calls.map((c) => c.method)).toEqual([
      'Target.getTargetInfo',
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    expect(contents.calls[1]?.params).toEqual({
      frameId: 'FRAME1',
      worldName: SNAPSHOT_WORLD,
      grantUniveralAccess: false,
    });
    expect(contents.calls[2]?.params).toMatchObject({ contextId: 7, returnByValue: true, silent: true });
  });

  it('is not available without the protocol session, on errors, and after its time budget', async () => {
    expect(await captureOutline(fakeContents({ attached: false }))).toEqual({ ok: false, reason: 'no-protocol' });
    expect(await captureOutline(fakeContents({ answer: () => Promise.reject(new Error('x')) }))).toEqual({
      ok: false,
      reason: 'failed',
    });
    const started = Date.now();
    const hung = await captureOutline(fakeContents({ answer: () => new Promise(() => undefined) }), FAST);
    expect(hung).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1_000);
    const queued = fakeContents({ answer: () => new Promise(() => undefined) });
    await captureOutline(queued, FAST);
    // The timed-out evaluation is still queued in the page: a retry does not queue another one.
    expect(await captureOutline(queued, FAST)).toEqual({ ok: false, reason: 'busy' });
    expect(queued.calls).toHaveLength(1);
  });

  it('refuses a script exception', async () => {
    const contents = fakeContents({
      answer: (method) =>
        method === 'Runtime.evaluate'
          ? Promise.resolve({ exceptionDetails: { text: 'x' } })
          : method === 'Target.getTargetInfo'
            ? Promise.resolve({ targetInfo: { targetId: 'F' } })
            : Promise.resolve({ executionContextId: 1 }),
    });
    expect((await captureOutline(contents)).ok).toBe(false);
  });
});

describe('captureScreenshot', () => {
  it('scales to the longest side and refuses empty or too large images', async () => {
    const big = await captureScreenshot(fakeContents({ image: () => Promise.resolve(fakeImage(3000, 1500)) }));
    expect(big.ok && { width: big.value.width, height: big.value.height }).toEqual({ width: 1024, height: 512 });
    expect(await captureScreenshot(fakeContents({ image: () => Promise.resolve(fakeImage(0, 0)) }))).toEqual({
      ok: false,
      reason: 'hidden',
    });
    const heavy = fakeContents({
      image: () => Promise.resolve(fakeImage(800, 600, SNAPSHOT_LIMITS.screenshotMaxBytes + 1)),
    });
    expect(await captureScreenshot(heavy)).toEqual({ ok: false, reason: 'too-large' });
    const hung = fakeContents({ image: () => new Promise(() => undefined) });
    expect(await captureScreenshot(hung, FAST)).toEqual({ ok: false, reason: 'timeout' });
    // The same capture is still pending: no second capture is queued behind it.
    expect(await captureScreenshot(hung, FAST)).toEqual({ ok: false, reason: 'busy' });
  });

  it('checks the real pixel size of a HiDPI capture and scales it down to the limit', async () => {
    const retina = await captureScreenshot(
      fakeContents({ image: () => Promise.resolve(fakeImage(1600, 1000, 1000, 2)) }),
    );
    expect(retina.ok && { width: retina.value.width, height: retina.value.height }).toEqual({
      width: 1024,
      height: 640,
    });
    expect(retina.ok && pngSize(retina.value.png)).toEqual({ width: 1024, height: 640 });
    expect(
      await captureScreenshot(
        fakeContents({ image: () => Promise.resolve({ ...fakeImage(10, 10), toPNG: () => Buffer.alloc(30) }) }),
      ),
    ).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('takeSnapshot', () => {
  it('combines path, title, outline and screenshot; reports what was not available', async () => {
    const snapshot = await takeSnapshot(fakeContents({ title: 't'.repeat(1000) }), {
      origin: 'http://127.0.0.1:5000',
      screenshot: true,
    });
    expect(snapshot.path).toBe('pages/首页.html');
    expect(snapshot.title.length).toBe(SNAPSHOT_LIMITS.titleChars + 1);
    expect(snapshot.outline?.items).toHaveLength(1);
    expect(snapshot.screenshot?.width).toBe(800);

    const busy = await takeSnapshot(
      fakeContents({ answer: () => new Promise(() => undefined), image: () => new Promise(() => undefined) }),
      { origin: 'http://127.0.0.1:5000', screenshot: true },
      FAST,
    );
    expect(busy.outline).toBeNull();
    expect(busy.outlineUnavailable).toBe('timeout');
    expect(busy.screenshotUnavailable).toBe('timeout');
  });
});
