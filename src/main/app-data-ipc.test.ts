import type { IpcMainInvokeEvent } from 'electron';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DATA_CHANNELS } from '../shared/ipc/app-data-contract';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { registerAppDataIpcHandlers, resolveThirdPartyNotices, type AppDataIpcDeps } from './app-data-ipc';
import { ok } from '../shared/result';
import { ProjectService } from '../workspace/project-service';

/** S13 app-data channels: sender and payload are checked before any store runs (same rules as ipc.ts). */
const ORIGIN = 'noobide://app';
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

const eventFrom = (url: string | null, topLevel = true) =>
  ({ senderFrame: url === null ? null : { url, parent: topLevel ? null : {} } }) as unknown as IpcMainInvokeEvent;
const workbench = eventFrom(`${ORIGIN}/index.html`);
const strangers = [eventFrom('https://evil.example/'), eventFrom(`${ORIGIN}/index.html`, false), eventFrom(null)];

let handlers: Map<string, Handler>;
let deps: AppDataIpcDeps & {
  settings: { snapshot: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  openLogsFolder: ReturnType<typeof vi.fn>;
  openThirdPartyNotices: ReturnType<typeof vi.fn>;
  projects: { rootOf: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  recent: { list: ReturnType<typeof vi.fn>; rootOf: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  projectOpened: ReturnType<typeof vi.fn>;
  projectClosed: ReturnType<typeof vi.fn>;
  session: Record<'lastProject' | 'layout' | 'tabsOf' | 'saveTabs' | 'saveLayout', ReturnType<typeof vi.fn>>;
  pendingRecovery: ReturnType<typeof vi.fn>;
  restoreEnabled: ReturnType<typeof vi.fn>;
};
const LAYOUT = { filesOpen: true, problemsOpen: false, filesWidth: 300, editorShare: 0.6 };
const RECENT = '9b2f6c1e-4d3a-4b8c-8e7f-0a1b2c3d4e5f';
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

beforeEach(() => {
  handlers = new Map();
  deps = {
    allowedOrigin: ORIGIN,
    settings: {
      snapshot: vi.fn(async () => ({ settings: DEFAULT_SETTINGS, notice: null, backupPath: null })),
      update: vi.fn(async (patch: object) => ({ ...DEFAULT_SETTINGS, ...patch })),
    },
    openLogsFolder: vi.fn(async () => ''),
    openThirdPartyNotices: vi.fn(async () => ''),
    projects: {
      rootOf: vi.fn(() => undefined),
      open: vi.fn(async (root: string) =>
        ok({ projectId: ID, name: 'p', rootPath: root, files: [], truncated: false }),
      ),
      close: vi.fn((id: string) => id === ID),
    },
    recent: {
      list: vi.fn(async () => [{ id: RECENT, name: 'p', path: '/p', available: true, lastOpened: 1 }]),
      rootOf: vi.fn(async (id: string) => (id === RECENT ? '/p' : undefined)),
      remove: vi.fn(async () => true),
    },
    projectOpened: vi.fn((_id: string, _root: string, _sender: unknown) => undefined),
    projectClosed: vi.fn((_id: string, _root: string) => undefined),
    session: {
      lastProject: vi.fn(async () => tmpdir()), // an existing folder
      layout: vi.fn(async () => LAYOUT),
      tabsOf: vi.fn(async () => ({ tabs: ['index.html'], active: 'index.html' })),
      saveTabs: vi.fn(async () => undefined),
      saveLayout: vi.fn(async () => undefined),
    },
    pendingRecovery: vi.fn(async () => 0),
    restoreEnabled: vi.fn(async () => true),
  };
  registerAppDataIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, deps);
});

const call = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  return h(event, ...args);
};

describe('settings channels (S13.1)', () => {
  it('serve the workbench', async () => {
    expect(await call(APP_DATA_CHANNELS.settingsGet, workbench)).toEqual({
      ok: true,
      value: { settings: DEFAULT_SETTINGS, notice: null, backupPath: null },
    });
    expect(await call(APP_DATA_CHANNELS.settingsUpdate, workbench, { locale: 'en' })).toEqual({
      ok: true,
      value: { ...DEFAULT_SETTINGS, locale: 'en' },
    });
    expect(deps.settings.update).toHaveBeenCalledWith({ locale: 'en' });
  });

  it('refuse other senders before touching the store', async () => {
    for (const event of strangers) {
      expect(await call(APP_DATA_CHANNELS.settingsUpdate, event, { locale: 'en' })).toMatchObject({
        ok: false,
        code: 'forbidden-sender',
      });
    }
    expect(deps.settings.update).not.toHaveBeenCalled();
  });

  it('refuse malformed payloads', async () => {
    for (const bad of [{ locale: 'xx' }, { version: 9 }, 'en', null]) {
      expect(await call(APP_DATA_CHANNELS.settingsUpdate, workbench, bad)).toMatchObject({ code: 'invalid-request' });
    }
    expect(await call(APP_DATA_CHANNELS.settingsGet, workbench, {})).toMatchObject({ code: 'invalid-request' });
    expect(await call(APP_DATA_CHANNELS.settingsUpdate, workbench, { locale: 'en' }, 2)).toMatchObject({
      code: 'invalid-request',
    });
    expect(deps.settings.update).not.toHaveBeenCalled();
  });
});

describe('open logs folder (S13.6)', () => {
  it('opens the folder for the workbench only, with no payload', async () => {
    expect(await call(APP_DATA_CHANNELS.openLogsFolder, workbench)).toEqual({ ok: true, value: null });
    expect(await call(APP_DATA_CHANNELS.openLogsFolder, workbench, 'C:/Windows')).toMatchObject({
      code: 'invalid-request',
    });
    for (const event of strangers) {
      expect(await call(APP_DATA_CHANNELS.openLogsFolder, event)).toMatchObject({ code: 'forbidden-sender' });
    }
    expect(deps.openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it('reports a folder the OS could not open', async () => {
    deps.openLogsFolder.mockResolvedValueOnce('Failed to open');
    expect(await call(APP_DATA_CHANNELS.openLogsFolder, workbench)).toMatchObject({ ok: false, code: 'open-failed' });
  });
});

describe('open third-party notices', () => {
  it('opens the notices file for the workbench only, with no payload', async () => {
    expect(await call(APP_DATA_CHANNELS.openThirdPartyNotices, workbench)).toEqual({ ok: true, value: null });
    expect(await call(APP_DATA_CHANNELS.openThirdPartyNotices, workbench, 'C:/Windows/notepad.exe')).toMatchObject({
      code: 'invalid-request',
    });
    for (const event of strangers) {
      expect(await call(APP_DATA_CHANNELS.openThirdPartyNotices, event)).toMatchObject({ code: 'forbidden-sender' });
    }
    expect(deps.openThirdPartyNotices).toHaveBeenCalledTimes(1);
    deps.openThirdPartyNotices.mockResolvedValueOnce('Failed to open');
    expect(await call(APP_DATA_CHANNELS.openThirdPartyNotices, workbench)).toMatchObject({
      ok: false,
      code: 'open-failed',
    });
  });

  it('resolves the file next to app.asar when packaged, in build/ from source', () => {
    const resourcesPath = path.join('C:', 'Program Files', 'NoobIDE 中文', 'resources');
    const appPath = path.join('D:', 'NoobIDE');
    expect(resolveThirdPartyNotices({ isPackaged: true, resourcesPath, appPath })).toBe(
      path.join(resourcesPath, 'THIRD_PARTY_NOTICES.txt'),
    );
    expect(resolveThirdPartyNotices({ isPackaged: false, resourcesPath, appPath })).toBe(
      path.join(appPath, 'build', 'THIRD_PARTY_NOTICES.txt'),
    );
  });
});

describe('project configuration channels (S13.2)', () => {
  it('accept only a project id and a portable .html entry (or null)', async () => {
    for (const bad of [
      { projectId: ID, entry: 'C:/Users/x/index.html' },
      { projectId: ID, entry: '/etc/index.html' },
      { projectId: ID, entry: '../outside.html' },
      { projectId: ID, entry: 'style.css' },
      { projectId: ID, entry: '.noobide/project.html' },
      { projectId: ID },
      { projectId: ID, entry: 'index.html', extra: 1 },
      { projectId: 'nope', entry: 'index.html' },
    ]) {
      expect(await call(APP_DATA_CHANNELS.projectSetEntry, workbench, bad)).toMatchObject({ code: 'invalid-request' });
    }
    expect(deps.projects.rootOf).not.toHaveBeenCalled();
  });

  it('unknown projects are refused; other senders never reach the project', async () => {
    expect(await call(APP_DATA_CHANNELS.projectConfig, workbench, { projectId: ID })).toMatchObject({
      code: 'unknown-project',
    });
    expect(
      await call(APP_DATA_CHANNELS.projectSetEntry, workbench, { projectId: ID, entry: '子 文件夹/页面 二.html' }),
    ).toMatchObject({ code: 'unknown-project' });
    for (const event of strangers) {
      expect(await call(APP_DATA_CHANNELS.projectSetEntry, event, { projectId: ID, entry: null })).toMatchObject({
        code: 'forbidden-sender',
      });
    }
  });
});

describe('recent projects and closing a project (S13.3)', () => {
  it('lists, opens by opaque id (main supplies the path) and removes from the list only', async () => {
    expect(await call(APP_DATA_CHANNELS.recentList, workbench)).toEqual({
      ok: true,
      value: [{ id: RECENT, name: 'p', path: '/p', available: true, lastOpened: 1 }],
    });
    const opened = await call(APP_DATA_CHANNELS.recentOpen, workbench, { id: RECENT });
    expect(opened).toMatchObject({ ok: true, value: { projectId: ID, rootPath: '/p' } });
    expect(deps.projects.open).toHaveBeenCalledWith('/p');
    expect(deps.projectOpened).toHaveBeenCalledWith(ID, '/p', undefined);
    expect(await call(APP_DATA_CHANNELS.recentRemove, workbench, { id: RECENT })).toEqual({ ok: true, value: null });
    expect(deps.recent.remove).toHaveBeenCalledWith(RECENT);
  });

  it('never accepts a path from the renderer, and refuses unknown ids', async () => {
    for (const bad of [{ id: '/p' }, { path: '/p' }, { id: RECENT, path: 'C:/x' }, 'C:/x', { id: 1 }]) {
      expect(await call(APP_DATA_CHANNELS.recentOpen, workbench, bad)).toMatchObject({ code: 'invalid-request' });
      expect(await call(APP_DATA_CHANNELS.recentRemove, workbench, bad)).toMatchObject({ code: 'invalid-request' });
    }
    expect(await call(APP_DATA_CHANNELS.recentOpen, workbench, { id: ID })).toMatchObject({ code: 'not-found' });
    expect(deps.projects.open).not.toHaveBeenCalled();
    for (const event of strangers) {
      expect(await call(APP_DATA_CHANNELS.recentOpen, event, { id: RECENT })).toMatchObject({
        code: 'forbidden-sender',
      });
    }
  });

  it('closing tears the project down; an unknown project is refused', async () => {
    deps.projects.rootOf.mockImplementation((id: string) => (id === ID ? '/p' : undefined));
    expect(await call(APP_DATA_CHANNELS.closeProject, workbench, { projectId: ID })).toEqual({ ok: true, value: null });
    expect(deps.projectClosed).toHaveBeenCalledWith(ID, '/p');
    expect(
      await call(APP_DATA_CHANNELS.closeProject, workbench, { projectId: '0f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f' }),
    ).toMatchObject({ code: 'unknown-project' });
    expect(deps.projectClosed).toHaveBeenCalledTimes(1);
  });
});

describe('session restore (S13.4)', () => {
  it('a delayed session read cannot revoke a manually opened project or start its lifecycle hooks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noobide-restore-race-'));
    const projects = new ProjectService();
    let release!: (value: typeof LAYOUT) => void;
    deps.session.layout.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    deps.session.lastProject.mockResolvedValue(root);
    deps.projects.open.mockImplementation((chosen, options) => projects.open(chosen, options));
    try {
      const restoring = call(APP_DATA_CHANNELS.sessionRestore, workbench);
      const chosen = await projects.open(root);
      if (!chosen.ok) throw new Error(chosen.message);
      release(LAYOUT);
      expect(await restoring).toMatchObject({ ok: true, value: { project: null } });
      expect(projects.rootOf(chosen.value.projectId)).toBe(chosen.value.rootPath);
      expect(deps.projectOpened).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('duplicate requests neither repeat startup side effects nor return an old project id', async () => {
    const first = call(APP_DATA_CHANNELS.sessionRestore, workbench);
    const repeated = await call(APP_DATA_CHANNELS.sessionRestore, workbench);
    expect(repeated).toEqual({ ok: true, value: { project: null, layout: null, reason: 'none' } });
    await first;
    expect(deps.projects.open).toHaveBeenCalledTimes(1);
    expect(deps.projectOpened).toHaveBeenCalledTimes(1);
    expect(await call(APP_DATA_CHANNELS.sessionRestore, workbench)).toEqual(repeated);
  });

  it('reopens the last project and returns the layout', async () => {
    const result = await call(APP_DATA_CHANNELS.sessionRestore, workbench);
    expect(result).toMatchObject({
      ok: true,
      value: { reason: 'restored', layout: LAYOUT, project: { projectId: ID } },
    });
    expect(deps.projects.open).toHaveBeenCalledWith(tmpdir(), { restore: true });
    expect(deps.projectOpened).toHaveBeenCalledTimes(1);
  });

  it('crash recovery takes precedence: nothing is reopened while recovery records wait', async () => {
    deps.pendingRecovery.mockResolvedValue(2);
    expect(await call(APP_DATA_CHANNELS.sessionRestore, workbench)).toEqual({
      ok: true,
      value: { project: null, layout: LAYOUT, reason: 'recovery-pending' },
    });
    expect(deps.projects.open).not.toHaveBeenCalled();
  });

  it('honours the restoreSession setting', async () => {
    deps.restoreEnabled.mockResolvedValue(false);
    expect(await call(APP_DATA_CHANNELS.sessionRestore, workbench)).toMatchObject({ value: { reason: 'disabled' } });
    expect(deps.projects.open).not.toHaveBeenCalled();
  });

  it('saves tabs only as relative paths of an open project, and validated layouts', async () => {
    deps.projects.rootOf.mockImplementation((id: string) => (id === ID ? '/p' : undefined));
    const good = { projectId: ID, tabs: ['index.html', '子 文件夹/页面 二.html'], active: 'index.html' };
    expect(await call(APP_DATA_CHANNELS.sessionSaveTabs, workbench, good)).toEqual({ ok: true, value: null });
    expect(deps.session.saveTabs).toHaveBeenCalledWith('/p', { tabs: good.tabs, active: 'index.html' });
    for (const bad of [
      { ...good, tabs: ['C:/x/index.html'] },
      { ...good, tabs: ['../x.html'] },
      { ...good, active: 'other.html' },
      { ...good, tabs: ['a.html', 'a.html'], active: null },
      { ...good, extra: 1 },
    ]) {
      expect(await call(APP_DATA_CHANNELS.sessionSaveTabs, workbench, bad)).toMatchObject({ code: 'invalid-request' });
    }
    expect(await call(APP_DATA_CHANNELS.sessionSaveLayout, workbench, LAYOUT)).toEqual({ ok: true, value: null });
    for (const bad of [
      { ...LAYOUT, filesWidth: 5000 },
      { ...LAYOUT, editorShare: 1 },
      { ...LAYOUT, x: 1 },
    ]) {
      expect(await call(APP_DATA_CHANNELS.sessionSaveLayout, workbench, bad)).toMatchObject({
        code: 'invalid-request',
      });
    }
    expect(deps.session.saveLayout).toHaveBeenCalledTimes(1);
  });
});

describe('portability check (S13.5)', () => {
  const REPORT = { issues: [{ kind: 'mixed-eol', relPath: 'a.js' }], truncated: false } as const;

  it('scans the root main knows for the projectId; the renderer never sends a path', async () => {
    const scan = vi.fn(async () => REPORT);
    deps.scanPortability = scan;
    deps.projects.rootOf.mockImplementation((id: string) => (id === ID ? '/项目 根' : undefined));
    expect(await call(APP_DATA_CHANNELS.portabilityCheck, workbench, { projectId: ID })).toEqual({
      ok: true,
      value: REPORT,
    });
    expect(scan).toHaveBeenCalledWith('/项目 根');
  });

  it('refuses unknown projects, bad payloads and other senders before scanning', async () => {
    const scan = vi.fn(async () => REPORT);
    deps.scanPortability = scan;
    expect(await call(APP_DATA_CHANNELS.portabilityCheck, workbench, { projectId: ID })).toMatchObject({
      code: 'unknown-project',
    });
    for (const bad of [undefined, {}, { projectId: 'nope' }, { projectId: ID, root: '/etc' }]) {
      expect(await call(APP_DATA_CHANNELS.portabilityCheck, workbench, bad)).toMatchObject({ code: 'invalid-request' });
    }
    deps.projects.rootOf.mockImplementation(() => '/p');
    for (const event of strangers) {
      expect(await call(APP_DATA_CHANNELS.portabilityCheck, event, { projectId: ID })).toMatchObject({
        code: 'forbidden-sender',
      });
    }
    expect(scan).not.toHaveBeenCalled();
  });

  it('a failing scan is an error result, not a thrown exception', async () => {
    deps.scanPortability = vi.fn(async () => {
      throw new Error('EACCES');
    });
    deps.projects.rootOf.mockImplementation(() => '/p');
    expect(await call(APP_DATA_CHANNELS.portabilityCheck, workbench, { projectId: ID })).toMatchObject({
      ok: false,
      code: 'scan-failed',
    });
  });
});
