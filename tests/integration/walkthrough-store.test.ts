import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalkthroughStore } from '../../src/main/walkthrough-store';
import { registerWalkthroughIpcHandlers } from '../../src/main/walkthrough-ipc';
import { WALKTHROUGH_CHANNELS } from '../../src/shared/ipc/walkthrough-contract';
import { DEFAULT_WALKTHROUGH, type WalkthroughState } from '../../src/shared/walkthrough';

/** S23.1: walkthrough progress persisted in app data, and its IPC channels (sender + payload checked first). */
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-walkthrough-'));
  file = path.join(dir, '应用 数据', 'walkthrough.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STATE: WalkthroughState = {
  ...DEFAULT_WALKTHROUGH,
  status: 'active',
  step: 'reopen',
  completed: ['create', 'files', 'heading', 'style', 'interaction', 'error', 'restore'],
};

describe('WalkthroughStore', () => {
  it('starts from the defaults and survives a restart (a new store on the same file)', async () => {
    const first = new WalkthroughStore({ file });
    expect(await first.get()).toEqual(DEFAULT_WALKTHROUGH);
    await first.save(STATE);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(STATE);
    const second = new WalkthroughStore({ file });
    expect(await second.get()).toEqual(STATE);
  });

  it('serves calls in order: a save made before the first load finished is not lost', async () => {
    const store = new WalkthroughStore({ file });
    const saved = store.save(STATE);
    expect(await store.get()).toEqual(STATE);
    await saved;
  });

  it('moves a corrupt file aside instead of overwriting it, then starts from the defaults', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    const store = new WalkthroughStore({ file });
    expect(await store.get()).toEqual(DEFAULT_WALKTHROUGH);
    const names = await readdir(path.dirname(file));
    const backup = names.find((name) => name.startsWith('walkthrough.corrupt-'));
    expect(backup).toBeDefined();
    expect(await readFile(path.join(path.dirname(file), backup ?? ''), 'utf8')).toBe('{ not json');
    await store.save(STATE);
    expect(await new WalkthroughStore({ file }).get()).toEqual(STATE);
  });

  it('keeps valid fields of a damaged file', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...STATE, step: 'nonsense' }));
    expect(await new WalkthroughStore({ file }).get()).toEqual({ ...STATE, step: 'create' });
  });
});

describe('walkthrough IPC', () => {
  const ORIGIN = 'noobide://app';
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const eventFrom = (url: string | null, topLevel = true) =>
    ({ senderFrame: url === null ? null : { url, parent: topLevel ? null : {} } }) as unknown as IpcMainInvokeEvent;
  const workbench = eventFrom(`${ORIGIN}/index.html`);

  const setup = () => {
    const handlers = new Map<string, Handler>();
    const store = new WalkthroughStore({ file });
    registerWalkthroughIpcHandlers(
      { handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never,
      { allowedOrigin: ORIGIN, store },
    );
    const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
      (handlers.get(channel) as Handler)(event, ...args);
    return { call, store };
  };

  it('saves and reads the state for the workbench', async () => {
    const { call } = setup();
    expect(await call(WALKTHROUGH_CHANNELS.save, workbench, STATE)).toEqual({ ok: true, value: null });
    expect(await call(WALKTHROUGH_CHANNELS.get, workbench)).toEqual({ ok: true, value: STATE });
  });

  it('refuses other senders and invalid payloads before the store is touched', async () => {
    const { call, store } = setup();
    for (const stranger of [eventFrom('https://evil.example/'), eventFrom(`${ORIGIN}/x`, false), eventFrom(null)]) {
      expect(await call(WALKTHROUGH_CHANNELS.save, stranger, STATE)).toMatchObject({ code: 'forbidden-sender' });
      expect(await call(WALKTHROUGH_CHANNELS.get, stranger)).toMatchObject({ code: 'forbidden-sender' });
    }
    for (const bad of [{ ...STATE, extra: 1 }, { ...STATE, step: '../../etc' }, null, 'state']) {
      expect(await call(WALKTHROUGH_CHANNELS.save, workbench, bad)).toMatchObject({ code: 'invalid-request' });
    }
    expect(await call(WALKTHROUGH_CHANNELS.save, workbench, STATE, STATE)).toMatchObject({ code: 'invalid-request' });
    expect(await call(WALKTHROUGH_CHANNELS.get, workbench, {})).toMatchObject({ code: 'invalid-request' });
    expect(await store.get()).toEqual(DEFAULT_WALKTHROUGH);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
