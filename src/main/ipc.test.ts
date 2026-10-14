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
const BUF = '9b2f6c1e-4d3a-4b8c-8e7f-0a1b2c3d4e5f';
const KEY = '0123456789abcdef0123456789abcdef';
type Fake = ReturnType<typeof vi.fn>;
let deps: IpcDeps & {
  projects: {
    open: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    listDir: ReturnType<typeof vi.fn>;
    createEntry: ReturnType<typeof vi.fn>;
    renameEntry: ReturnType<typeof vi.fn>;
    trashEntry: ReturnType<typeof vi.fn>;
    revealPath: ReturnType<typeof vi.fn>;
  };
  trashItem: ReturnType<typeof vi.fn>;
  revealItem: ReturnType<typeof vi.fn>;
  journal: Record<
    'record' | 'discardSaved' | 'discard' | 'listPending' | 'rootOfPending' | 'read' | 'usage' | 'clearAll',
    Fake
  >;
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
      createEntry: vi.fn(async (r: { relPath: string }) => ok({ relPath: r.relPath })),
      renameEntry: vi.fn(async (r: { from: string; to: string }) => ok({ from: r.from, to: r.to })),
      trashEntry: vi.fn(async () => ok(null)),
      revealPath: vi.fn(async (r: { relPath: string }) => ok(r.relPath === '' ? '/p' : `/p/${r.relPath}`)),
    },
    trashItem: vi.fn(async () => undefined),
    revealItem: vi.fn((_fullPath: string) => undefined),
    chooseFolder: vi.fn(async () => '/p'),
    revealFolder: vi.fn(),
    journal: {
      record: vi.fn(async () => ok({ written: true })),
      discardSaved: vi.fn(async () => ok({ removed: true })),
      discard: vi.fn(async () => ok({ removed: true })),
      listPending: vi.fn(async () => [
        { key: KEY, rootPath: '/p', files: [{ relPath: 'a.html', bufferId: BUF, revision: 3, updatedAt: 5 }] },
      ]),
      rootOfPending: vi.fn(async (key: string) => (key === KEY ? '/p' : undefined)),
      read: vi.fn(async () =>
        ok({ rootPath: '/p', relPath: 'a.html', bufferId: BUF, revision: 3, updatedAt: 5, text: 'r', bom: false }),
      ),
      usage: vi.fn(async () => ({
        bytes: 10,
        entries: 1,
        limits: { maxEntryBytes: 50, maxTotalBytes: 100, maxEntries: 5, maxQuarantined: 1 },
      })),
      clearAll: vi.fn(async () => ok(null)),
    },
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
    for (const fn of Object.values(deps.journal)) expect(fn).not.toHaveBeenCalled();
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
    // S12 recovery channels
    [
      'a journal write without a buffer id',
      CHANNELS.recoveryRecord,
      { projectId: ID, relPath: 'a.html', text: '', bom: false, revision: 1 },
    ],
    [
      'a journal write with a bad buffer id',
      CHANNELS.recoveryRecord,
      { projectId: ID, relPath: 'a.html', bufferId: '../x', text: '', bom: false, revision: 1 },
    ],
    [
      'a negative revision',
      CHANNELS.recoveryRecord,
      { projectId: ID, relPath: 'a.html', bufferId: BUF, text: '', bom: false, revision: -1 },
    ],
    [
      'a fractional revision',
      CHANNELS.recoveryDiscardSaved,
      { projectId: ID, relPath: 'a.html', bufferId: BUF, revision: 1.5 },
    ],
    ['a journal read of an absolute path', CHANNELS.recoveryRead, { projectId: ID, relPath: 'C:/x', bufferId: BUF }],
    ['a recovery key that is a path', CHANNELS.recoveryOpenProject, { key: 'C:/Users' }],
    ['a payload on the clear channel', CHANNELS.recoveryClear, { all: true }],
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

  it('also watches a project reopened by crash recovery (review finding 6)', async () => {
    const projectOpened = vi.fn();
    handlers.clear();
    registerIpcHandlers({ handle: (c: string, h: Handler) => void handlers.set(c, h) } as never, {
      ...deps,
      projectOpened,
    });
    const sender = { id: 2 };
    const event = { senderFrame: frame(`${ORIGIN}/index.html`), sender } as never;
    expect(await call(CHANNELS.recoveryOpenProject, event, { key: KEY })).toMatchObject({ ok: true });
    expect(projectOpened).toHaveBeenCalledWith(ID, '/p', sender);
    projectOpened.mockClear();
    await call(CHANNELS.recoveryOpenProject, event, { key: 'f'.repeat(32) });
    expect(projectOpened).not.toHaveBeenCalled();
  });
});

describe('entries with non-portable names (review finding 9)', () => {
  it('rename source, trash and reveal accept a listed non-portable last segment', async () => {
    expect(
      await call(CHANNELS.renameEntry, workbench, { projectId: ID, from: 'css/page.', to: 'css/page.html' }),
    ).toMatchObject({ ok: true });
    expect(await call(CHANNELS.trashEntry, workbench, { projectId: ID, relPath: 'CON' })).toMatchObject({ ok: true });
    expect(await call(CHANNELS.revealEntry, workbench, { projectId: ID, relPath: 'a:b' })).toMatchObject({ ok: true });
  });

  it.each([
    ['as a rename target', CHANNELS.renameEntry, { projectId: ID, from: 'a.html', to: 'page.' }],
    ['in a parent folder', CHANNELS.trashEntry, { projectId: ID, relPath: 'CON/a.html' }],
    ['for reading', CHANNELS.readFile, { projectId: ID, relPath: 'page.' }],
    ['as a parent segment', CHANNELS.trashEntry, { projectId: ID, relPath: '../x' }],
    ['as a dot name', CHANNELS.trashEntry, { projectId: ID, relPath: 'a/..' }],
  ])('still rejects a non-portable name %s', async (_name, channel, payload) => {
    expect(await call(channel, workbench, payload)).toMatchObject({ ok: false, code: 'invalid-request' });
  });
});

describe('file operation channels (S08.2–S08.5)', () => {
  it('create, rename, trash and reveal pass parsed requests through', async () => {
    const create = { projectId: ID, relPath: '新 文件夹/页面.html', kind: 'file' };
    expect(await call(CHANNELS.createEntry, workbench, create)).toEqual({
      ok: true,
      value: { relPath: '新 文件夹/页面.html' },
    });
    expect(deps.projects.createEntry).toHaveBeenCalledWith(create);
    const move = { projectId: ID, from: 'a.html', to: 'pages/A.html' };
    expect(await call(CHANNELS.renameEntry, workbench, move)).toMatchObject({ ok: true });
    expect(deps.projects.renameEntry).toHaveBeenCalledWith(move);
    expect(await call(CHANNELS.trashEntry, workbench, { projectId: ID, relPath: 'a.html' })).toEqual({
      ok: true,
      value: null,
    });
    expect(deps.projects.trashEntry).toHaveBeenCalledWith({ projectId: ID, relPath: 'a.html' }, deps.trashItem);
    expect(await call(CHANNELS.revealEntry, workbench, { projectId: ID, relPath: 'css' })).toEqual({
      ok: true,
      value: null,
    });
    expect(deps.revealItem).toHaveBeenCalledWith('/p/css');
  });

  it.each([
    ['an unknown kind', CHANNELS.createEntry, { projectId: ID, relPath: 'a', kind: 'symlink' }],
    ['a parent segment in a rename target', CHANNELS.renameEntry, { projectId: ID, from: 'a', to: '../a' }],
    ['an absolute rename source', CHANNELS.renameEntry, { projectId: ID, from: '/etc/passwd', to: 'a' }],
    ['a device name as new name', CHANNELS.createEntry, { projectId: ID, relPath: 'CON', kind: 'file' }],
    ['trashing the project root', CHANNELS.trashEntry, { projectId: ID, relPath: '' }],
    ['revealing outside', CHANNELS.revealEntry, { projectId: ID, relPath: '..' }],
  ])('rejects %s', async (_name, channel, payload) => {
    expect(await call(channel, workbench, payload)).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(deps.projects.createEntry).not.toHaveBeenCalled();
    expect(deps.projects.renameEntry).not.toHaveBeenCalled();
    expect(deps.projects.trashEntry).not.toHaveBeenCalled();
    expect(deps.trashItem).not.toHaveBeenCalled();
    expect(deps.revealItem).not.toHaveBeenCalled();
  });

  it('a refused reveal shows nothing', async () => {
    deps.projects.revealPath.mockResolvedValueOnce({ ok: false, code: 'not-found', message: 'ENOENT' });
    expect(await call(CHANNELS.revealEntry, workbench, { projectId: ID, relPath: 'gone.html' })).toEqual({
      ok: false,
      code: 'not-found',
      message: 'ENOENT',
    });
    expect(deps.revealItem).not.toHaveBeenCalled();
  });
});

describe('recovery channels (S12)', () => {
  const ref = { projectId: ID, relPath: '中文 路径/a.html', bufferId: BUF };

  it('journal writes and discards resolve the project root in main', async () => {
    const write = { ...ref, revision: 2, text: '<p>未保存</p>', bom: false };
    expect(await call(CHANNELS.recoveryRecord, workbench, write)).toEqual({ ok: true, value: { written: true } });
    expect(deps.journal.record).toHaveBeenCalledWith({ rootPath: '/p', relPath: '中文 路径/a.html' }, write);
    expect(await call(CHANNELS.recoveryDiscardSaved, workbench, { ...ref, revision: 2 })).toMatchObject({ ok: true });
    expect(deps.journal.discardSaved).toHaveBeenCalledWith({ rootPath: '/p', relPath: '中文 路径/a.html' }, BUF, 2);
    expect(await call(CHANNELS.recoveryDiscard, workbench, ref)).toMatchObject({ ok: true });
    expect(deps.journal.discard).toHaveBeenCalledWith({ rootPath: '/p', relPath: '中文 路径/a.html' }, BUF);
  });

  it('journal calls for a project that is not open are refused', async () => {
    const other = { ...ref, projectId: '00000000-0000-4000-8000-000000000000' };
    expect(
      await call(CHANNELS.recoveryRecord, workbench, { ...other, revision: 1, text: '', bom: false }),
    ).toMatchObject({ ok: false, code: 'unknown-project' });
    expect(await call(CHANNELS.recoveryRead, workbench, other)).toMatchObject({ code: 'unknown-project' });
    expect(deps.journal.record).not.toHaveBeenCalled();
    expect(deps.journal.read).not.toHaveBeenCalled();
  });

  it('lists pending projects with a display name and usage', async () => {
    expect(await call(CHANNELS.recoveryListPending, workbench)).toEqual({
      ok: true,
      value: {
        projects: [
          {
            key: KEY,
            name: 'p',
            rootPath: '/p',
            files: [{ relPath: 'a.html', bufferId: BUF, revision: 3, updatedAt: 5 }],
          },
        ],
        usage: { bytes: 10, entries: 1, maxTotalBytes: 100 },
      },
    });
  });

  it('reopens a project only from a root stored in the journal', async () => {
    expect(await call(CHANNELS.recoveryOpenProject, workbench, { key: KEY })).toMatchObject({ ok: true });
    expect(deps.projects.open).toHaveBeenCalledWith('/p');
    expect(await call(CHANNELS.recoveryOpenProject, workbench, { key: 'f'.repeat(32) })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(deps.projects.open).toHaveBeenCalledTimes(1);
  });

  it('read returns the journaled text with the file on disk to compare', async () => {
    const result = await call(CHANNELS.recoveryRead, workbench, ref);
    expect(result).toMatchObject({ ok: true, value: { text: 'r', revision: 3, disk: { text: 'x' }, diskError: null } });
    deps.projects.read.mockResolvedValueOnce({ ok: false, code: 'not-found', message: 'ENOENT' });
    expect(await call(CHANNELS.recoveryRead, workbench, ref)).toMatchObject({
      ok: true,
      value: { disk: null, diskError: 'not-found' },
    });
  });

  it('clear removes all journal data', async () => {
    expect(await call(CHANNELS.recoveryClear, workbench)).toEqual({ ok: true, value: null });
    expect(deps.journal.clearAll).toHaveBeenCalled();
  });
});
