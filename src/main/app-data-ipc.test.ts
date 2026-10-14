import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_DATA_CHANNELS } from '../shared/ipc/app-data-contract';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { registerAppDataIpcHandlers, type AppDataIpcDeps } from './app-data-ipc';

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
  projects: { rootOf: ReturnType<typeof vi.fn> };
};
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
    projects: { rootOf: vi.fn(() => undefined) },
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
