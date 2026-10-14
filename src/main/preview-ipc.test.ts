import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_CHANNELS, parsePreviewBounds, parsePreviewStart } from '../shared/ipc/preview-contract';
import { ok } from '../shared/result';
import { registerPreviewIpcHandlers, type PreviewIpcDeps } from './preview-ipc';

const ORIGIN = 'noobide://app';
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

const eventFrom = (url: string | null, topLevel = true) =>
  ({ senderFrame: url === null ? null : { url, parent: topLevel ? null : {} } }) as unknown as IpcMainInvokeEvent;
const workbench = eventFrom(`${ORIGIN}/index.html`);
const fakeWindow = {} as BrowserWindow;

let handlers: Map<string, Handler>;
let preview: { [K in keyof PreviewIpcDeps['preview']]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  handlers = new Map();
  preview = {
    start: vi.fn(async () => ok({ state: 'starting' as const, projectId: ID })),
    stop: vi.fn(async () => ({ state: 'stopped' as const, projectId: null })),
    reload: vi.fn(() => ({ state: 'refreshing' as const, projectId: ID })),
    setBounds: vi.fn(),
  };
  registerPreviewIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, {
    allowedOrigin: ORIGIN,
    windowOf: () => fakeWindow,
    preview: preview as unknown as PreviewIpcDeps['preview'],
  });
});

const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(event, ...args);
};

describe('preview IPC (S04.3)', () => {
  it.each([
    ['a preview page on the loopback server', eventFrom('http://127.0.0.1:51734/index.html')],
    ['another origin', eventFrom('https://example.com/')],
    ['an iframe in the workbench', eventFrom(`${ORIGIN}/index.html`, false)],
    ['a destroyed frame', eventFrom(null)],
  ])('rejects %s on every preview channel', async (_name, event) => {
    for (const channel of Object.values(PREVIEW_CHANNELS)) {
      expect(await call(channel, event, { projectId: ID })).toMatchObject({ ok: false, code: 'forbidden-sender' });
    }
    for (const fn of Object.values(preview)) expect(fn).not.toHaveBeenCalled();
  });

  it('starts, reloads, stops and moves the preview for the workbench', async () => {
    expect(await call(PREVIEW_CHANNELS.start, workbench, { projectId: ID })).toEqual({
      ok: true,
      value: { state: 'starting', projectId: ID },
    });
    expect(preview.start).toHaveBeenCalledWith(ID, fakeWindow);
    expect(await call(PREVIEW_CHANNELS.reload, workbench)).toMatchObject({ ok: true });
    expect(await call(PREVIEW_CHANNELS.stop, workbench)).toMatchObject({ ok: true, value: { state: 'stopped' } });
    const bounds = { x: 10, y: 20.5, width: 300, height: 200, visible: true };
    expect(await call(PREVIEW_CHANNELS.setBounds, workbench, bounds)).toEqual({ ok: true, value: null });
    expect(preview.setBounds).toHaveBeenCalledWith(bounds);
  });

  it('rejects malformed payloads without touching the preview', async () => {
    for (const payload of [undefined, {}, { projectId: 'x' }, { projectId: ID, extra: 1 }, [ID]]) {
      expect(await call(PREVIEW_CHANNELS.start, workbench, payload)).toMatchObject({ code: 'invalid-request' });
    }
    expect(await call(PREVIEW_CHANNELS.stop, workbench, { projectId: ID })).toMatchObject({ code: 'invalid-request' });
    expect(await call(PREVIEW_CHANNELS.reload, workbench, 1, 2)).toMatchObject({ code: 'invalid-request' });
    expect(await call(PREVIEW_CHANNELS.setBounds, workbench, { x: 1 })).toMatchObject({ code: 'invalid-request' });
    expect(preview.start).not.toHaveBeenCalled();
    expect(preview.setBounds).not.toHaveBeenCalled();
  });
});

describe('preview payload parsers', () => {
  it('start needs exactly a project id', () => {
    expect(parsePreviewStart({ projectId: ID })).toEqual({ projectId: ID });
    expect(parsePreviewStart({ projectId: ID, root: 'C:\\' })).toBeNull();
    expect(parsePreviewStart({ projectId: '../x' })).toBeNull();
    expect(parsePreviewStart(null)).toBeNull();
  });

  it('bounds must be finite, bounded numbers and a visibility flag', () => {
    const good = { x: 0, y: 0, width: 10, height: 10, visible: false };
    expect(parsePreviewBounds(good)).toEqual(good);
    for (const bad of [
      { ...good, width: -1 },
      { ...good, x: Number.NaN },
      { ...good, height: Number.POSITIVE_INFINITY },
      { ...good, y: 1e9 },
      { ...good, visible: 'yes' },
      { ...good, extra: 1 },
      { x: 0, y: 0, width: 10, height: 10 },
      [0, 0, 10, 10, true],
      null,
    ]) {
      expect(parsePreviewBounds(bad)).toBeNull();
    }
  });
});
