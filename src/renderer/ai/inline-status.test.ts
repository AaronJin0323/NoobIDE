import { beforeEach, describe, expect, it } from 'vitest';
import { AiStatusCache, INLINE_STATUS_TTL_MS, aiBridge } from './inline-status';
import { FakeAiBridge, STATUS } from './fake-ai-bridge.test-util';

let bridge: FakeAiBridge;
let clock: number;
let cache: AiStatusCache;

beforeEach(() => {
  bridge = new FakeAiBridge();
  clock = 0;
  cache = new AiStatusCache(
    () => bridge,
    () => clock,
  );
});

describe('S32.1 AI status cache', () => {
  it('asks once while the status is fresh, again after the TTL', async () => {
    expect(await cache.get('p1')).toEqual(STATUS);
    clock += INLINE_STATUS_TTL_MS - 1;
    await cache.get('p1');
    expect(bridge.statusCalls).toEqual(['p1']);
    clock += 1;
    await cache.get('p1');
    expect(bridge.statusCalls).toEqual(['p1', 'p1']);
  });

  it('shares one call between concurrent readers', async () => {
    await Promise.all([cache.get('p1'), cache.get('p1')]);
    expect(bridge.statusCalls).toEqual(['p1']);
  });

  it('asks again for another project and after invalidate', async () => {
    await cache.get('p1');
    await cache.get('p2');
    cache.invalidate();
    await cache.get('p2');
    expect(bridge.statusCalls).toEqual(['p1', 'p2', 'p2']);
    expect(cache.peek('p2')).toEqual(STATUS);
    expect(cache.peek('p1')).toBeNull();
  });

  it('sees a change made elsewhere (Settings) once refreshed, and tells subscribers', async () => {
    let changes = 0;
    cache.subscribe(() => (changes += 1));
    await cache.get('p1');
    bridge.current = { ...STATUS, projectConsent: false };
    await cache.get('p1');
    expect(cache.peek('p1')?.projectConsent).toBe(true); // still fresh
    clock += INLINE_STATUS_TTL_MS;
    expect((await cache.get('p1'))?.projectConsent).toBe(false);
    expect(changes).toBe(2);
  });

  it('toggles inline suggestions through setConfig, keeping the rest of the config', async () => {
    expect(await cache.toggleInline('p1')).toBe(false);
    expect(bridge.configs).toEqual([{ ...STATUS.config, inlineCompletions: false }]);
    expect(cache.peek('p1')?.config.inlineCompletions).toBe(false);
    expect(await cache.toggleInline('p1')).toBe(true);
    expect(bridge.configs[1]?.inlineCompletions).toBe(true);
  });

  it('without a bridge: no status, no toggle', async () => {
    const none = new AiStatusCache(() => null);
    expect(await none.get('p1')).toBeNull();
    expect(await none.toggleInline('p1')).toBeNull();
    expect(aiBridge()).toBeNull(); // unit tests run without a window
  });
});
