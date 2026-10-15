import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROBLEMS_CHANNELS, PROBLEMS_EVENT_CHANNEL } from '../shared/ipc/problems-contract';
import type { ProblemRecord } from '../shared/problem';
import { ProblemsBridge, registerProblemsIpcHandlers } from './problems-bridge';

const ORIGIN = 'noobide://app';
const PREVIEW = 'http://127.0.0.1:51734';
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

const eventFrom = (url: string | null, topLevel = true) =>
  ({ senderFrame: url === null ? null : { url, parent: topLevel ? null : {} } }) as unknown as IpcMainInvokeEvent;
const workbench = eventFrom(`${ORIGIN}/index.html`);

let handlers: Map<string, Handler>;
let bridge: ProblemsBridge;
let sent: { channel: string; records: readonly ProblemRecord[] }[];
let timers: (() => void)[];
let destroyed: boolean;

const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(event, ...args);
};
const runTimers = () => {
  for (const t of timers.splice(0)) t();
};

beforeEach(() => {
  handlers = new Map();
  sent = [];
  timers = [];
  destroyed = false;
  bridge = new ProblemsBridge({ setTimer: (cb) => timers.push(cb), clearTimer: () => undefined });
  registerProblemsIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, {
    allowedOrigin: ORIGIN,
    bridge,
  });
  bridge.sessionStarted(
    { projectId: ID, origin: PREVIEW },
    { isDestroyed: () => destroyed, send: (channel, records) => sent.push({ channel, records }) },
  );
  bridge.navigationStarted(1);
  bridge.navigationCommitted(1);
  bridge.entry({
    source: 'exception',
    level: 'error',
    message: 'Uncaught ReferenceError: userNmae is not defined',
    url: `${PREVIEW}/%E8%84%9A%E6%9C%AC/app.js`,
    line: 3,
    at: 1,
  });
});

describe('runtime problems bridge (S16.2)', () => {
  it.each([
    ['a preview page on the loopback server', eventFrom(`${PREVIEW}/index.html`)],
    ['another origin', eventFrom('https://example.com/')],
    ['an iframe in the workbench', eventFrom(`${ORIGIN}/index.html`, false)],
    ['a destroyed frame', eventFrom(null)],
  ])('rejects %s on every problems channel', async (_name, event) => {
    for (const channel of Object.values(PROBLEMS_CHANNELS)) {
      expect(await call(channel, event)).toMatchObject({ ok: false, code: 'forbidden-sender' });
    }
    expect(bridge.capture.list()).toHaveLength(1); // nothing was cleared
  });

  it('rejects payloads: both calls take none', async () => {
    for (const channel of Object.values(PROBLEMS_CHANNELS)) {
      expect(await call(channel, workbench, { all: true })).toMatchObject({ ok: false, code: 'invalid-request' });
      expect(await call(channel, workbench, undefined, 1)).toMatchObject({ ok: false, code: 'invalid-request' });
    }
  });

  it('lists the records with project paths and notifies the workbench that started the preview', async () => {
    const listed = (await call(PROBLEMS_CHANNELS.list, workbench)) as { ok: true; value: ProblemRecord[] };
    expect(listed.ok).toBe(true);
    expect(listed.value).toEqual([
      expect.objectContaining({ source: 'runtime', code: 'ReferenceError', file: '脚本/app.js', line: 3 }),
    ]);
    runTimers();
    expect(sent.at(-1)?.channel).toBe(PROBLEMS_EVENT_CHANNEL);
    expect(sent.at(-1)?.records).toEqual(listed.value);
  });

  it('clearResolved removes problems not seen since the refresh and publishes at once', async () => {
    bridge.navigationStarted(2);
    bridge.navigationCommitted(2);
    expect(await call(PROBLEMS_CHANNELS.clearResolved, workbench)).toEqual({ ok: true, value: 1 });
    expect(sent.at(-1)?.records).toEqual([]);
  });

  it('does not send to a destroyed workbench', () => {
    destroyed = true;
    runTimers();
    expect(sent).toEqual([]);
  });
});
