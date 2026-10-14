import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '../shared/ipc/contract';
import { ok } from '../shared/result';
import { isTrustedSender, registerIpcHandlers, type IpcDeps } from './ipc';

const ORIGIN = 'noobide://app';
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function frame(url: string, topLevel = true) {
  return { url, parent: topLevel ? null : {} };
}
function eventFrom(senderFrame: ReturnType<typeof frame> | null): IpcMainInvokeEvent {
  return { senderFrame } as unknown as IpcMainInvokeEvent;
}
const workbench = eventFrom(frame(`${ORIGIN}/index.html`));

let handlers: Map<string, Handler>;
let deps: IpcDeps & {
  projects: {
    open: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    listDir: ReturnType<typeof vi.fn>;
  };
};

beforeEach(() => {
  handlers = new Map();
  deps = {
    allowedOrigin: ORIGIN,
    projects: {
      open: vi.fn(async () => ok({ projectId: ID, name: 'p', rootPath: '/p', files: [], truncated: false })),
      read: vi.fn(async () => ok({ text: 'x', eol: '\n' as const, bom: false, uri: 'file:///p/x' })),
      write: vi.fn(async () => ok({ savedAt: 1 })),
      rootOf: vi.fn((id: string) => (id === ID ? '/p' : undefined)),
      listDir: vi.fn(async () => ok({ relPath: '', entries: [], truncated: false })),
    },
    chooseFolder: vi.fn(async () => '/p'),
    revealFolder: vi.fn(),
  };
  registerIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, deps);
});

const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(event, ...args);
};

describe('sender check (S03.1)', () => {
  it('accepts only the top-level workbench frame on the app origin', () => {
    expect(isTrustedSender({ url: `${ORIGIN}/index.html`, isTopLevel: true }, ORIGIN)).toBe(true);
    expect(isTrustedSender({ url: `${ORIGIN}/index.html`, isTopLevel: false }, ORIGIN)).toBe(false);
    expect(isTrustedSender({ url: 'http://127.0.0.1:5173/', isTopLevel: true }, ORIGIN)).toBe(false);
    expect(isTrustedSender({ url: 'noobide://evil/index.html', isTopLevel: true }, ORIGIN)).toBe(false);
    expect(isTrustedSender({ url: 'file:///C:/x.html', isTopLevel: true }, ORIGIN)).toBe(false);
    expect(isTrustedSender({ url: 'not a url', isTopLevel: true }, ORIGIN)).toBe(false);
    expect(isTrustedSender(null, ORIGIN)).toBe(false);
  });

  it.each([
    ['another origin', eventFrom(frame('https://example.com/'))],
    ['a preview page on the loopback server', eventFrom(frame('http://127.0.0.1:51734/index.html'))],
    ['an iframe inside the workbench', eventFrom(frame(`${ORIGIN}/index.html`, false))],
    ['a destroyed frame', eventFrom(null)],
  ])('rejects %s on every channel without calling a service', async (_name, event) => {
    for (const channel of Object.values(CHANNELS)) {
      expect(await call(channel, event, { projectId: ID, relPath: 'a.html', text: '', bom: false })).toMatchObject({
        ok: false,
        code: 'forbidden-sender',
      });
    }
    expect(deps.chooseFolder).not.toHaveBeenCalled();
    expect(deps.projects.read).not.toHaveBeenCalled();
    expect(deps.projects.write).not.toHaveBeenCalled();
    expect(deps.revealFolder).not.toHaveBeenCalled();
  });
});

describe('payload validation (S03.1)', () => {
  it.each([
    ['an absolute path', CHANNELS.readFile, { projectId: ID, relPath: 'C:/Windows/win.ini' }],
    ['a parent segment', CHANNELS.readFile, { projectId: ID, relPath: '../x' }],
    ['a missing field', CHANNELS.writeFile, { projectId: ID, relPath: 'a.html', text: 'x' }],
    ['a wrong type', CHANNELS.writeFile, { projectId: ID, relPath: 'a.html', text: 1, bom: false }],
    ['an extra field', CHANNELS.readFile, { projectId: ID, relPath: 'a.html', root: '/' }],
    ['a payload on a no-payload channel', CHANNELS.openFolder, { path: '/etc' }],
    ['a bad project id', CHANNELS.revealProject, { projectId: '../../' }],
  ])('rejects %s', async (_name, channel, payload) => {
    expect(await call(channel, workbench, payload)).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(deps.projects.read).not.toHaveBeenCalled();
    expect(deps.projects.write).not.toHaveBeenCalled();
    expect(deps.chooseFolder).not.toHaveBeenCalled();
  });

  it('rejects extra arguments', async () => {
    expect(await call(CHANNELS.readFile, workbench, { projectId: ID, relPath: 'a.html' }, 'extra')).toMatchObject({
      code: 'invalid-request',
    });
  });
});

describe('valid calls reach the services', () => {
  it('open folder: cancel returns null, a choice opens the project', async () => {
    deps.chooseFolder = vi.fn(async () => null);
    handlers.clear();
    registerIpcHandlers({ handle: (c: string, h: Handler) => void handlers.set(c, h) } as never, deps);
    expect(await call(CHANNELS.openFolder, workbench)).toEqual({ ok: true, value: null });
    expect(deps.projects.open).not.toHaveBeenCalled();
  });

  it('read, write and reveal pass the parsed request through', async () => {
    expect(await call(CHANNELS.openFolder, workbench)).toMatchObject({ ok: true, value: { projectId: ID } });
    expect(deps.projects.open).toHaveBeenCalledWith('/p');
    expect(await call(CHANNELS.readFile, workbench, { projectId: ID, relPath: '中文 路径/a.html' })).toMatchObject({
      ok: true,
    });
    expect(deps.projects.read).toHaveBeenCalledWith({ projectId: ID, relPath: '中文 路径/a.html' });
    const write = { projectId: ID, relPath: 'a.html', text: '<p>你好</p>', bom: false };
    expect(await call(CHANNELS.writeFile, workbench, write)).toEqual({ ok: true, value: { savedAt: 1 } });
    expect(deps.projects.write).toHaveBeenCalledWith(write);
    expect(await call(CHANNELS.revealProject, workbench, { projectId: ID })).toEqual({ ok: true, value: null });
    expect(deps.revealFolder).toHaveBeenCalledWith('/p');
  });

  it('reveal of an unknown project is refused', async () => {
    const other = '00000000-0000-4000-8000-000000000000';
    expect(await call(CHANNELS.revealProject, workbench, { projectId: other })).toMatchObject({
      ok: false,
      code: 'unknown-project',
    });
    expect(deps.revealFolder).not.toHaveBeenCalled();
  });
});

// ── S07/S08: file tree, watcher and file operations ──
describe('file tree channel (S07.2)', () => {
  it('passes the root ("") and nested folders through', async () => {
    expect(await call(CHANNELS.listDir, workbench, { projectId: ID, relPath: '' })).toMatchObject({ ok: true });
    expect(await call(CHANNELS.listDir, workbench, { projectId: ID, relPath: '子 文件夹' })).toMatchObject({
      ok: true,
    });
    expect(deps.projects.listDir).toHaveBeenCalledWith({ projectId: ID, relPath: '子 文件夹' });
  });

  it.each([
    ['a parent segment', { projectId: ID, relPath: '..' }],
    ['an absolute path', { projectId: ID, relPath: '/etc' }],
    ['an NTFS stream', { projectId: ID, relPath: 'css:x' }],
    ['a missing relPath', { projectId: ID }],
  ])('rejects %s', async (_name, payload) => {
    expect(await call(CHANNELS.listDir, workbench, payload)).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(deps.projects.listDir).not.toHaveBeenCalled();
  });
});

describe('project watching (S07.3)', () => {
  it('starts watching a project the user opened, for the window that asked', async () => {
    const projectOpened = vi.fn();
    handlers.clear();
    registerIpcHandlers({ handle: (c: string, h: Handler) => void handlers.set(c, h) } as never, {
      ...deps,
      projectOpened,
    });
    const sender = { id: 1 };
    await call(CHANNELS.openFolder, { senderFrame: frame(`${ORIGIN}/index.html`), sender } as never);
    expect(projectOpened).toHaveBeenCalledWith(ID, '/p', sender);
  });
});
