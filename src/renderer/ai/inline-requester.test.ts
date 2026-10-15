import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineRequester, INLINE_MAX_RAW_CHARS, type CancelSignal, type InlineAiRequest } from './inline-requester';
import { INLINE_DEBOUNCE_MS, INLINE_TIMEOUT_MS } from './inline-context';
import { FakeAiBridge } from './fake-ai-bridge.test-util';

const REQUEST: InlineAiRequest = {
  kind: 'inline',
  projectId: 'p1',
  relPath: 'index.html',
  languageId: 'html',
  prefix: '<p>',
  suffix: '</p>',
};

/** A Monaco-like cancellation token the test can cancel. */
function token(): CancelSignal & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

let bridge: FakeAiBridge;
let requester: InlineRequester;
let statusErrors: string[];

beforeEach(() => {
  vi.useFakeTimers();
  bridge = new FakeAiBridge();
  statusErrors = [];
  requester = new InlineRequester(() => bridge, { onStatusError: (code) => statusErrors.push(code) });
});

afterEach(() => {
  requester.dispose();
  vi.useRealTimers();
});

/** Lets the debounce pass and request() answer. */
async function afterDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(INLINE_DEBOUNCE_MS);
}

describe('S32.1 inline requester', () => {
  it('waits for the debounce, then assembles the streamed text of its request', async () => {
    const result = requester.complete(REQUEST, 'k1');
    await vi.advanceTimersByTimeAsync(INLINE_DEBOUNCE_MS - 1);
    expect(bridge.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.requests).toEqual([REQUEST]);
    bridge.emit({ requestId: 'other', type: 'text', text: 'not mine' });
    bridge.stream('r1', ['Hel', 'lo']);
    await expect(result).resolves.toBe('Hello');
    expect(requester.stats).toMatchObject({ requests: 1, completed: 1, cancels: 0 });
  });

  it('typing during the debounce sends nothing for the earlier position (one request per pause)', async () => {
    const first = requester.complete(REQUEST, 'k1');
    await vi.advanceTimersByTimeAsync(100);
    const second = requester.complete({ ...REQUEST, prefix: '<p>H' }, 'k2');
    await expect(first).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    const third = requester.complete({ ...REQUEST, prefix: '<p>He' }, 'k3');
    await expect(second).resolves.toBeNull();
    await afterDebounce();
    expect(bridge.requests.map((r) => (r.kind === 'inline' ? r.prefix : ''))).toEqual(['<p>He']);
    expect(bridge.cancels).toEqual([]);
    expect(requester.stats.debounced).toBe(2);
    bridge.stream('r1', ['llo']);
    await expect(third).resolves.toBe('llo');
  });

  it('typing while a request runs cancels it in main', async () => {
    const first = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    bridge.emit({ requestId: 'r1', type: 'text', text: 'partial' });
    requester.cancelUnless('k2'); // the document or the cursor changed
    await expect(first).resolves.toBeNull();
    expect(bridge.cancels).toEqual(['r1']);
    expect(requester.stats.cancels).toBe(1);
    // Late events of the cancelled request are ignored.
    bridge.stream('r1', ['more']);
  });

  it('a change that leaves the document and cursor as requested keeps the request', async () => {
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    requester.cancelUnless('k1');
    bridge.stream('r1', ['ok']);
    await expect(result).resolves.toBe('ok');
    expect(bridge.cancels).toEqual([]);
  });

  it("Monaco's cancellation token cancels the running request", async () => {
    const signal = token();
    const result = requester.complete(REQUEST, 'k1', signal);
    await afterDebounce();
    signal.cancel();
    await expect(result).resolves.toBeNull();
    expect(bridge.cancels).toEqual(['r1']);
  });

  it('an already cancelled token sends nothing', async () => {
    const signal = token();
    signal.cancel();
    await expect(requester.complete(REQUEST, 'k1', signal)).resolves.toBeNull();
    await afterDebounce();
    expect(bridge.requests).toHaveLength(0);
  });

  it('a newer call supersedes a running one and cancels it', async () => {
    const first = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    const second = requester.complete(REQUEST, 'k2');
    await expect(first).resolves.toBeNull();
    expect(bridge.cancels).toEqual(['r1']);
    await afterDebounce();
    bridge.stream('r2', ['two']);
    await expect(second).resolves.toBe('two');
  });

  it('a request cancelled while main is still starting it is cancelled as soon as its id is known', async () => {
    let answer: (value: { ok: true; value: { requestId: string } }) => void = () => undefined;
    vi.spyOn(bridge, 'request').mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    requester.cancelAll();
    await expect(result).resolves.toBeNull();
    answer({ ok: true, value: { requestId: 'slow' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.cancels).toEqual(['slow']);
  });

  it('keeps events that arrive before request() answers', async () => {
    bridge.earlyEvents = (requestId) => [
      { requestId, type: 'text', text: 'fast ' },
      { requestId, type: 'text', text: 'answer' },
      { requestId, type: 'done' },
    ];
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    await expect(result).resolves.toBe('fast answer');
  });

  it('times out a request that does not finish, and cancels it', async () => {
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    bridge.emit({ requestId: 'r1', type: 'text', text: 'slow' });
    await vi.advanceTimersByTimeAsync(INLINE_TIMEOUT_MS);
    await expect(result).resolves.toBeNull();
    expect(bridge.cancels).toEqual(['r1']);
  });

  it('stops a runaway answer at the raw limit', async () => {
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    bridge.emit({ requestId: 'r1', type: 'text', text: 'x'.repeat(INLINE_MAX_RAW_CHARS + 10) });
    await expect(result).resolves.toHaveLength(INLINE_MAX_RAW_CHARS);
    expect(bridge.cancels).toEqual(['r1']);
  });

  it('an error event ends the call without text; key and consent errors refresh the status', async () => {
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    bridge.emit({ requestId: 'r1', type: 'error', code: 'unauthorized', message: 'bad key' });
    await expect(result).resolves.toBeNull();
    expect(statusErrors).toEqual(['unauthorized']);
    expect(requester.stats.lastError).toBe('unauthorized');
  });

  it('a refused request (no consent) ends without text and refreshes the status', async () => {
    bridge.refuse = 'no-consent';
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    await expect(result).resolves.toBeNull();
    expect(statusErrors).toEqual(['no-consent']);
    expect(requester.stats.requests).toBe(0);
  });

  it('a provider error does not refresh the status', async () => {
    const result = requester.complete(REQUEST, 'k1');
    await afterDebounce();
    bridge.emit({ requestId: 'r1', type: 'error', code: 'offline', message: '' });
    await expect(result).resolves.toBeNull();
    expect(statusErrors).toEqual([]);
  });

  it('without a bridge nothing is sent', async () => {
    const none = new InlineRequester(() => null);
    const result = none.complete(REQUEST, 'k1');
    await afterDebounce();
    await expect(result).resolves.toBeNull();
  });
});
