import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { SEARCH_CHANNELS, parseSearchRequest, type SearchResults } from '../shared/ipc/search-contract';
import { SearchCoordinator, registerSearchHandlers, type SearchRunner } from './search-ipc';

const PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ORIGIN = 'noobide://app';
const query = { text: 'card', regex: false, caseSensitive: false, wholeWord: false };
const request = (searchId: number, extra: Record<string, unknown> = {}) => ({
  searchId,
  projectId: PROJECT,
  query,
  openBuffers: [],
  ...extra,
});
const results = (searchId: number): SearchResults => ({
  searchId,
  files: [],
  totalMatches: 0,
  truncated: false,
  filesSearched: 0,
  skippedBinary: 0,
  skippedLarge: 0,
  durationMs: 0,
});

function fakeIpc() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  return {
    ipc: { handle: (channel: string, fn: never) => handlers.set(channel, fn) },
    call: (channel: string, event: unknown, ...args: unknown[]) =>
      (handlers.get(channel) as (event: unknown, ...args: unknown[]) => Promise<unknown>)(event, ...args),
  };
}

const event = (senderId = 1, url = `${ORIGIN}/index.html`, parent: unknown = null) => ({
  sender: { id: senderId },
  senderFrame: { url, parent },
});

describe('search request validation (S51.2)', () => {
  it('accepts exactly the contract', () => {
    expect(parseSearchRequest(request(1))).toEqual(request(1));
    expect(
      parseSearchRequest(request(2, { openBuffers: [{ relPath: '子 文件夹/页面 二.html', text: '<p>card</p>' }] })),
    ).not.toBeNull();
  });

  it('refuses malformed payloads', () => {
    expect(parseSearchRequest(null)).toBeNull();
    expect(parseSearchRequest(request(0))).toBeNull();
    expect(parseSearchRequest(request(1.5))).toBeNull();
    expect(parseSearchRequest(request(1, { projectId: 'nope' }))).toBeNull();
    expect(parseSearchRequest(request(1, { extra: true }))).toBeNull();
    expect(parseSearchRequest(request(1, { query: { ...query, text: '' } }))).toBeNull();
    expect(parseSearchRequest(request(1, { query: { ...query, text: 'x'.repeat(1001) } }))).toBeNull();
    expect(parseSearchRequest(request(1, { query: { ...query, regex: 'yes' } }))).toBeNull();
    expect(parseSearchRequest(request(1, { query: { ...query, flags: 'g' } }))).toBeNull();
    expect(parseSearchRequest(request(1, { openBuffers: [{ relPath: '../x.html', text: '' }] }))).toBeNull();
    expect(parseSearchRequest(request(1, { openBuffers: [{ relPath: 'C:/x.html', text: '' }] }))).toBeNull();
    expect(
      parseSearchRequest(
        request(1, {
          openBuffers: [
            { relPath: 'a.html', text: '' },
            { relPath: 'a.html', text: '' },
          ],
        }),
      ),
    ).toBeNull();
    expect(parseSearchRequest(request(1, { openBuffers: [{ relPath: 'a.html', text: 1 }] }))).toBeNull();
  });
});

describe('search IPC handlers (S51.2)', () => {
  it('checks the sender frame and the payload before searching', async () => {
    const { ipc, call } = fakeIpc();
    let runs = 0;
    registerSearchHandlers(ipc, {
      allowedOrigin: ORIGIN,
      rootOf: () => '/root',
      runner: async (r) => {
        runs += 1;
        return { ok: true, value: results(r.searchId) };
      },
    });
    expect(await call(SEARCH_CHANNELS.run, event(1, 'https://evil.example/'), request(1))).toMatchObject({
      code: 'forbidden-sender',
    });
    expect(await call(SEARCH_CHANNELS.run, event(1, `${ORIGIN}/`, {}), request(1))).toMatchObject({
      code: 'forbidden-sender',
    });
    expect(await call(SEARCH_CHANNELS.run, { sender: { id: 1 }, senderFrame: null }, request(1))).toMatchObject({
      code: 'forbidden-sender',
    });
    expect(await call(SEARCH_CHANNELS.run, event(), { searchId: 1 })).toMatchObject({ code: 'invalid-request' });
    expect(await call(SEARCH_CHANNELS.run, event(), request(1), 'extra')).toMatchObject({ code: 'invalid-request' });
    expect(runs).toBe(0);
    expect(await call(SEARCH_CHANNELS.run, event(), request(1))).toEqual({ ok: true, value: results(1) });
  });

  it('answers an invalid regular expression with a typed error, and an unknown project too', async () => {
    const { ipc, call } = fakeIpc();
    registerSearchHandlers(ipc, { allowedOrigin: ORIGIN, rootOf: () => undefined });
    expect(await call(SEARCH_CHANNELS.run, event(), request(1))).toMatchObject({
      ok: false,
      code: 'unknown-project',
    });
    const { ipc: ipc2, call: call2 } = fakeIpc();
    registerSearchHandlers(ipc2, { allowedOrigin: ORIGIN, rootOf: () => process.cwd() });
    const answer = (await call2(
      SEARCH_CHANNELS.run,
      event(),
      request(2, { query: { ...query, text: '(oops', regex: true } }),
    )) as { ok: boolean; code: string; message: string };
    expect(answer).toMatchObject({ ok: false, code: 'invalid-regex' });
    expect(answer.message).toMatch(/Invalid regular expression/);
  });
});

/** A runner whose searches finish only when the test releases them. */
function controlledRunner() {
  const pending = new Map<number, () => void>();
  const runner: SearchRunner = (r, signal) =>
    new Promise((resolve) => {
      pending.set(r.searchId, () => resolve({ ok: true, value: results(r.searchId) }));
      signal.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled', message: 'aborted' }));
    });
  return { runner, finish: (id: number) => pending.get(id)?.() };
}

describe('search cancellation (S51.2)', () => {
  it('a new search cancels the previous one, which never delivers results', async () => {
    const { runner, finish } = controlledRunner();
    const coordinator = new SearchCoordinator(runner);
    const first = coordinator.run(7, parseSearchRequest(request(1))!);
    const second = coordinator.run(7, parseSearchRequest(request(2))!);
    finish(1); // the old scan completing late must not matter
    finish(2);
    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await second).toEqual({ ok: true, value: results(2) });
  });

  it('a runner that ignores the signal still cannot deliver stale results', async () => {
    const releases: (() => void)[] = [];
    const coordinator = new SearchCoordinator(
      (r) => new Promise((resolve) => releases.push(() => resolve({ ok: true, value: results(r.searchId) }))),
    );
    const first = coordinator.run(1, parseSearchRequest(request(1))!);
    const second = coordinator.run(1, parseSearchRequest(request(2))!);
    releases.forEach((release) => release());
    expect(await first).toMatchObject({ code: 'cancelled' });
    expect(await second).toMatchObject({ ok: true, value: { searchId: 2 } });
  });

  it('cancel stops only the named search of that window; other windows are independent', async () => {
    const { runner, finish } = controlledRunner();
    const coordinator = new SearchCoordinator(runner);
    const mine = coordinator.run(1, parseSearchRequest(request(5))!);
    const other = coordinator.run(2, parseSearchRequest(request(6))!);
    coordinator.cancel(1, 4); // an older id: nothing happens
    coordinator.cancel(1, 5);
    finish(6);
    expect(await mine).toMatchObject({ code: 'cancelled' });
    expect(await other).toMatchObject({ ok: true });
  });

  it('the cancel channel goes through the same checks', async () => {
    const { ipc, call } = fakeIpc();
    const { runner } = controlledRunner();
    registerSearchHandlers(ipc, { allowedOrigin: ORIGIN, rootOf: () => '/root', runner });
    const running = call(SEARCH_CHANNELS.run, event(3), request(9));
    expect(await call(SEARCH_CHANNELS.cancel, event(3), { searchId: 'x' })).toMatchObject({ code: 'invalid-request' });
    expect(await call(SEARCH_CHANNELS.cancel, event(3, 'https://evil.example/'), { searchId: 9 })).toMatchObject({
      code: 'forbidden-sender',
    });
    expect(await call(SEARCH_CHANNELS.cancel, event(3), { searchId: 9 })).toEqual({ ok: true, value: null });
    expect(await running).toMatchObject({ code: 'cancelled' });
  });
});
