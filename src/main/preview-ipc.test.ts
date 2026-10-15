import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_CHANNELS, parsePreviewBounds, parsePreviewStart } from '../shared/ipc/preview-contract';
import { ok } from '../shared/result';
import { registerPreviewIpcHandlers, type PreviewIpcDeps } from './preview-ipc';

const ORIGIN = 'noobide://app';
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

const eventFrom = (url: string | null, topLevel = true, windowId = 1) =>
  ({
    senderFrame: url === null ? null : { url, parent: topLevel ? null : {} },
    sender: { id: windowId },
  }) as unknown as IpcMainInvokeEvent;
const workbench = eventFrom(`${ORIGIN}/index.html`);
const otherWindow = eventFrom(`${ORIGIN}/index.html`, true, 2);
const OTHER_ID = '9a1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
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
    // S14.6: window 1 started the preview of project ID.
    isOwner: vi.fn(
      ({ windowId, projectId }: { windowId: number; projectId?: string }) => windowId === 1 && (projectId ?? ID) === ID,
    ),
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
    expect(await call(PREVIEW_CHANNELS.stop, workbench, { projectId: 'x' })).toMatchObject({ code: 'invalid-request' });
    expect(await call(PREVIEW_CHANNELS.stop, workbench, { projectId: ID, extra: 1 })).toMatchObject({
      code: 'invalid-request',
    });
    expect(await call(PREVIEW_CHANNELS.reload, workbench, 1, 2)).toMatchObject({ code: 'invalid-request' });
    expect(await call(PREVIEW_CHANNELS.setBounds, workbench, { x: 1 })).toMatchObject({ code: 'invalid-request' });
    expect(preview.start).not.toHaveBeenCalled();
    expect(preview.setBounds).not.toHaveBeenCalled();
  });
});

describe('preview ownership (S14.6)', () => {
  it('stop, reload and bounds from another window are refused and change nothing', async () => {
    expect(await call(PREVIEW_CHANNELS.stop, otherWindow)).toMatchObject({ ok: false, code: 'not-owner' });
    expect(await call(PREVIEW_CHANNELS.reload, otherWindow)).toMatchObject({ ok: false, code: 'not-owner' });
    const bounds = { x: 0, y: 0, width: 1, height: 1, visible: true };
    expect(await call(PREVIEW_CHANNELS.setBounds, otherWindow, bounds)).toMatchObject({ code: 'not-owner' });
    expect(preview.stop).not.toHaveBeenCalled();
    expect(preview.reload).not.toHaveBeenCalled();
    expect(preview.setBounds).not.toHaveBeenCalled();
  });

  it('a request naming another project (a late click after a switch) is refused', async () => {
    expect(await call(PREVIEW_CHANNELS.stop, workbench, { projectId: OTHER_ID })).toMatchObject({
      code: 'not-owner',
    });
    expect(await call(PREVIEW_CHANNELS.reload, workbench, { projectId: OTHER_ID })).toMatchObject({
      code: 'not-owner',
    });
    expect(preview.stop).not.toHaveBeenCalled();
    expect(preview.reload).not.toHaveBeenCalled();
  });

  it('the owner names its project and is served', async () => {
    expect(await call(PREVIEW_CHANNELS.reload, workbench, { projectId: ID })).toMatchObject({ ok: true });
    expect(await call(PREVIEW_CHANNELS.stop, workbench, { projectId: ID })).toMatchObject({ ok: true });
    expect(preview.isOwner).toHaveBeenCalledWith({ windowId: 1, projectId: ID });
  });
});

describe('start-preview consent (S14.4)', () => {
  function withTrust(trusted: Set<string>) {
    const local = new Map<string, Handler>();
    const start = vi.fn(async () => ok({ state: 'starting' as const, projectId: ID }));
    const trust = {
      isTrusted: vi.fn(async (id: string) => trusted.has(id)),
      trust: vi.fn(async (id: string) => void trusted.add(id)),
    };
    registerPreviewIpcHandlers({ handle: (channel: string, h: Handler) => void local.set(channel, h) } as never, {
      allowedOrigin: ORIGIN,
      windowOf: () => fakeWindow,
      preview: { ...preview, start } as unknown as PreviewIpcDeps['preview'],
      trust,
    });
    const startFn = local.get(PREVIEW_CHANNELS.start);
    if (!startFn) throw new Error('no start handler');
    return { start, trust, call: (payload: unknown) => startFn(workbench, payload) };
  }

  it('an automatic start of a folder never started before is refused and runs nothing', async () => {
    const { start, trust, call } = withTrust(new Set());
    expect(await call({ projectId: ID, trigger: 'auto' })).toMatchObject({ ok: false, code: 'not-trusted' });
    expect(start).not.toHaveBeenCalled();
    expect(trust.trust).not.toHaveBeenCalled();
  });

  it('pressing Start once is the consent: it is remembered and later automatic starts run', async () => {
    const trusted = new Set<string>();
    const { start, trust, call } = withTrust(trusted);
    expect(await call({ projectId: ID })).toMatchObject({ ok: true });
    expect(trust.trust).toHaveBeenCalledWith(ID);
    expect(await call({ projectId: ID, trigger: 'auto' })).toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a trusted folder (e.g. created from a built-in template) starts automatically', async () => {
    const { start, call } = withTrust(new Set([ID]));
    expect(await call({ projectId: ID, trigger: 'auto' })).toMatchObject({ ok: true });
    expect(start).toHaveBeenCalledWith(ID, fakeWindow);
  });
});

describe('preview payload parsers', () => {
  it('start needs exactly a project id', () => {
    expect(parsePreviewStart({ projectId: ID })).toEqual({ projectId: ID, trigger: 'user' });
    expect(parsePreviewStart({ projectId: ID, trigger: 'auto' })).toEqual({ projectId: ID, trigger: 'auto' });
    expect(parsePreviewStart({ projectId: ID, trigger: 'sneaky' })).toBeNull();
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
