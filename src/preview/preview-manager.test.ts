import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewEvent, PreviewStatus } from '../shared/ipc/preview-contract';
import type { PreviewServer } from './static-server';

// The manager imports Electron for views and sessions; Stop on an already-built preview touches neither.
vi.mock('electron', () => ({ session: {}, WebContentsView: class {}, webContents: {} }));
const { PreviewManager } = await import('./preview-manager');

/**
 * Stop racing a new Start or a second Stop (S14.1/S14.6). Stop awaits the proxy and server shutdown; whatever comes
 * in meanwhile must not get the server that is about to close, nor have its status overwritten by the late Stop.
 */
let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-pm-')));
  root = path.join(tmp, '预览 项目');
  await mkdir(root);
  await writeFile(path.join(root, 'index.html'), '<p>hi</p>\n');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const PROJECT = 'project-a';
const OWNER = { projectId: PROJECT, windowId: 7 };

interface Internals {
  live: unknown;
  machine: { state: string; generation: number };
  status: PreviewStatus;
  generation: number;
  servers: { acquire(owner: typeof OWNER, root: string): Promise<PreviewServer> };
  apply(window: unknown, projectId: string | null, event: { type: string }): void;
}

/** A manager showing a running preview whose proxy closes only when the test says so. */
async function runningPreview() {
  const manager = new PreviewManager({ rootOf: () => root });
  const internals = manager as unknown as Internals;
  const server = await internals.servers.acquire(OWNER, root);
  let finishProxyClose: () => void = () => undefined;
  const proxyClosed = new Promise<void>((resolve) => {
    finishProxyClose = resolve;
  });
  const sent: PreviewEvent[] = [];
  const window = {
    isDestroyed: () => false,
    removeListener: () => undefined,
    contentView: { removeChildView: () => undefined },
    webContents: { id: OWNER.windowId, isDestroyed: () => false, send: (_c: string, e: PreviewEvent) => sent.push(e) },
  };
  internals.live = {
    projectId: PROJECT,
    windowId: OWNER.windowId,
    server,
    proxy: { close: () => proxyClosed },
    view: { webContents: { isDestroyed: () => true } },
    window,
    onWindowClosed: () => undefined,
    timers: [],
    picker: { dispose: () => undefined },
    afterLoadRecords: [],
  };
  internals.machine = { state: 'running', generation: 1 };
  internals.status = { state: 'running', projectId: PROJECT, generation: 1, url: server.origin };
  return { manager, internals, server, window, sent, finishProxyClose };
}

const statuses = (sent: PreviewEvent[]) =>
  sent.flatMap((e) => (e.kind === 'status' ? [e.status.state] : [])).filter((s) => s !== undefined);

describe('PreviewManager.stop races', () => {
  it('a Start of the same project during Stop gets a server that keeps running, not the one being closed', async () => {
    const { manager, internals, server, finishProxyClose } = await runningPreview();
    const stopping = manager.stop();
    // A new Start acquires the project's server while Stop still waits for the proxy.
    const next = await internals.servers.acquire(OWNER, root);
    finishProxyClose();
    await stopping;
    expect(next).not.toBe(server);
    expect(await next.answers(1_000)).toBe(true);
    expect(manager.serverProjects()).toEqual([PROJECT]);
    await next.close();
  });

  it('a Start that began during Stop keeps its status: the late Stop does not mark it stopped', async () => {
    const { manager, internals, window, sent, finishProxyClose } = await runningPreview();
    const stopping = manager.stop();
    // What startNow does: invalidate older work, then announce the start.
    internals.generation += 2;
    internals.apply(window, PROJECT, { type: 'start' });
    finishProxyClose();
    await stopping;
    expect(manager.getStatus().state).toBe('starting');
    expect(statuses(sent).at(-1)).toBe('starting');
  });

  it('two overlapping Stops still tell the workbench that the preview stopped', async () => {
    const { manager, sent, finishProxyClose } = await runningPreview();
    const first = manager.stop();
    const second = manager.stop(); // e.g. the project closed while the user pressed Stop
    await second;
    finishProxyClose();
    await first;
    expect(manager.getStatus().state).toBe('stopped');
    expect(statuses(sent).at(-1)).toBe('stopped');
  });
});

describe('PreviewManager refresh hold (S58.10)', () => {
  it('a release waits for save notices still on their way, so the batch reloads the page once', async () => {
    const manager = new PreviewManager({ rootOf: () => root });
    const calls: string[] = [];
    (manager as unknown as { refresher: unknown }).refresher = {
      hold: () => calls.push('hold'),
      release: () => calls.push('release'),
    };
    manager.holdRefresh();
    let arrive: () => void = () => undefined;
    manager.saveArriving(new Promise<void>((resolve) => (arrive = resolve)).then(() => void calls.push('saved')));
    // A notice that fails (the refresh-mode read threw) must not keep the hold forever.
    manager.saveArriving(Promise.reject(new Error('config read failed')));
    const released = manager.releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(['hold']);
    arrive();
    await released;
    expect(calls).toEqual(['hold', 'saved', 'release']);
    // Nothing is left waiting: the next release is immediate.
    await manager.releaseRefresh();
    expect(calls).toEqual(['hold', 'saved', 'release', 'release']);
  });
});
