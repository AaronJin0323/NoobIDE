import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVENTS, type WatchEvent, type WorkspaceChanged } from '../../src/shared/ipc/contract';
import { ProjectWatcher, type WatchFn } from '../../src/workspace/watcher';
import { ProjectWatchHub, type EventTarget } from '../../src/main/project-watch';
import { PreviewServer } from '../../src/preview/static-server';
import { ServerRegistry } from '../../src/preview/server-registry';
import { PreviewProxy } from '../../src/preview/preview-proxy';
import { WakeRecovery, type WakePreview, type WakeRecoveryDeps } from '../../src/main/wake-recovery';
import { wakeSignals } from '../../src/platform/power-events';

/**
 * S25.1/S25.2 (decision 0028) integration: sleep/wake recovery with the real watcher, the real loopback server and
 * the real server registry, on a project path with Chinese characters and spaces. Faults are injected the way a
 * sleep breaks things: the OS watch stops delivering without an error, the server's socket dies, a simulated
 * powerMonitor reports the wake (or does not, and only the clock jumps).
 */
let tmp: string;
let root: string;
const p = (...segments: string[]) => path.join(root, ...segments);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-wake-')));
  root = path.join(tmp, '网页 练习', '睡眠 唤醒');
  await mkdir(p('子 文件夹'), { recursive: true });
  await writeFile(p('index.html'), '<p>一</p>\n');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** An OS watch that the test can kill silently (no 'error', no more events — what a sleep can do to it). */
function deadAfterSleepWatch() {
  const attached: { deliver: (name: string | null) => void; closed: boolean }[] = [];
  const watch: WatchFn = (_root, onChange) => {
    const handle = { deliver: onChange, closed: false };
    attached.push(handle);
    return {
      on: () => undefined,
      close: () => {
        handle.closed = true;
      },
    };
  };
  return { watch, attached };
}

async function until(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe('watcher after sleep', () => {
  it('a watch that silently stopped delivering is re-attached, a rescan is reported, and the snapshot is current', async () => {
    const os = deadAfterSleepWatch();
    const events: WatchEvent[] = [];
    // No FSEvents replay filter here: the test edits within a few ms of the snapshot, which it would treat as a replay.
    const watcher = new ProjectWatcher(root, (batch) => events.push(...batch), {
      debounceMs: 20,
      replayWindowMs: 0,
      watch: os.watch,
    });
    await watcher.start();
    expect(os.attached).toHaveLength(1);

    // "Sleep": files change on disk (another program, a sync client) but the dead watch reports nothing.
    await writeFile(p('子 文件夹', '新 页面.html'), '<p>新</p>\n');
    await rm(p('index.html'));
    await new Promise((r) => setTimeout(r, 60));
    expect(events).toEqual([]);

    await watcher.resync();
    expect(events).toEqual([{ type: 'rescan' }]);
    expect(os.attached).toHaveLength(2);
    expect(os.attached[0]?.closed).toBe(true); // the old OS handle is released, never two watches
    expect(watcher.snapshotSize).toBe(2); // 子 文件夹 + 新 页面.html (index.html is gone)

    // The new watch works and classifies against the fresh snapshot: the new file is known (changed, not created).
    events.length = 0;
    await writeFile(p('子 文件夹', '新 页面.html'), '<p>改</p>\n');
    os.attached[1]?.deliver(['子 文件夹', '新 页面.html'].join(path.sep));

    await until(() => events.length > 0);
    await watcher.idle();
    expect(events).toEqual([{ type: 'changed', relPath: '子 文件夹/新 页面.html' }]);
    watcher.close();
  });

  it('a resync after close does nothing; a resync overlapping the first start keeps one OS watch', async () => {
    const os = deadAfterSleepWatch();
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { watch: os.watch });
    const starting = watcher.start();
    const resync = watcher.resync();
    await Promise.all([starting, resync]);
    expect(os.attached.filter((h) => !h.closed)).toHaveLength(1);
    watcher.close();
    events.length = 0;
    await watcher.resync();
    expect(events).toEqual([]);
    expect(os.attached.filter((h) => !h.closed)).toHaveLength(0);
  });
});

describe('watcher resync that fails', () => {
  it('reports a rescan and schedules a restart instead of staying detached', async () => {
    const os = deadAfterSleepWatch();
    let failNext = false;
    const watch: WatchFn = (r, onChange) => {
      if (failNext) {
        failNext = false;
        throw new Error('watch handle limit');
      }
      return os.watch(r, onChange);
    };
    const events: WatchEvent[] = [];
    const watcher = new ProjectWatcher(root, (batch) => events.push(...batch), { watch, restartDelaysMs: [20] });
    await watcher.start();
    failNext = true;
    await watcher.resync(); // attach throws inside attach(): it schedules the restart itself
    await until(() => os.attached.filter((h) => !h.closed).length === 1);
    expect(events.filter((e) => e.type === 'rescan').length).toBeGreaterThanOrEqual(1);
    watcher.close();
  });
});

describe('static server after sleep', () => {
  it('answers while listening and stops answering once its socket died', async () => {
    const server = await PreviewServer.start(root);
    expect(await server.answers(1_000)).toBe(true);
    await server.close();
    expect(await server.answers(1_000)).toBe(false);
  });

  it('a server that accepts connections but never answers fails the check within the timeout', async () => {
    const server = await PreviewServer.start(root);
    // Stand-in for a wedged socket: occupy a port with a server that never responds, and probe it as the preview's.
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as AddressInfo).port;
    Object.defineProperty(server, 'port', { value: port });
    const started = Date.now();
    expect(await server.answers(300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    await server.close();
  });

  it('the health check is refused by the request checks (no secret sent, nothing served)', async () => {
    const server = await PreviewServer.start(root);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'HEAD',
          path: '/.noobide-health',
          headers: { Host: `127.0.0.1:${server.port}` },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    await server.close();
  });

  it('the network proxy answers while listening and not after its socket died', async () => {
    const proxy = await PreviewProxy.start({ serverHost: '127.0.0.1', serverPort: 1, resolve: async () => [] });
    expect(await proxy.answers(1_000)).toBe(true);
    await proxy.close();
    expect(await proxy.answers(1_000)).toBe(false);
  });

  it('a restarted server gets the same port when it is free, else a new one', async () => {
    const registry = new ServerRegistry<PreviewServer>((r, options) => PreviewServer.start(r, options));
    const owner = { projectId: 'p1', windowId: 1 };
    const first = await registry.acquire(owner, root);
    const port = first.port;
    await registry.release('p1');
    const again = await registry.acquire(owner, root);
    expect(again.port).toBe(port);
    expect(await again.answers()).toBe(true);
    await registry.release('p1');
    // Another program took the port while the machine slept: the preview gets a new URL.
    const squatter = createServer(() => undefined);
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    const moved = await registry.acquire(owner, root);
    expect(moved.port).not.toBe(port);
    expect(await moved.answers()).toBe(true);
    await registry.release('p1');
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });
});

/** A workbench stand-in (real EventEmitter). */
class Target extends EventEmitter implements EventTarget {
  readonly sent: WorkspaceChanged[] = [];
  send(channel: string, payload: WorkspaceChanged) {
    if (channel === EVENTS.changed) this.sent.push(payload);
  }
  isDestroyed() {
    return false;
  }
}

describe('wake recovery end to end in main (simulated powerMonitor)', () => {
  it('resume: the dead watch is replaced, and a dead server makes the preview restart on the same port', async () => {
    const os = deadAfterSleepWatch();
    const hub = new ProjectWatchHub((r, emit) => new ProjectWatcher(r, emit, { watch: os.watch }));
    const target = new Target();
    hub.watch('p1', root, target);
    await until(() => os.attached.length === 1);

    // The preview half: the real registry and server; restart = release + acquire, as PreviewManager does.
    const registry = new ServerRegistry<PreviewServer>((r, options) => PreviewServer.start(r, options));
    const owner = { projectId: 'p1', windowId: 1 };
    let server = await registry.acquire(owner, root);
    const firstPort = server.port;
    const restarts: string[] = [];
    const preview: WakePreview = {
      wakeSubject: () => ({ projectId: 'p1', state: 'running' }),
      forgetStalePing: () => undefined,
      serverAnswers: (ms) => server.answers(ms),
      pageAnswers: async () => true,
      restartAfterWake: async (reason) => {
        restarts.push(reason);
        await registry.release('p1');
        server = await registry.acquire(owner, root);
        return true;
      },
    };
    const power = new EventEmitter();
    const recovery = new WakeRecovery({
      power: power as unknown as WakeRecoveryDeps['power'],
      signals: wakeSignals(),
      watchers: hub,
      preview,
      settleMs: 0,
      probeTimeoutMs: 1_000,
    });
    recovery.install();

    power.emit('suspend');
    await writeFile(p('睡眠时 新建.html'), '<p>z</p>\n'); // missed by the dead watch
    await server.close(); // the socket died during sleep
    power.emit('resume');
    const report = await recovery.recover('resume'); // joins the one the event started
    expect(report).toMatchObject({ watcher: 'rescanned', server: 'restarted' });
    expect(target.sent.at(-1)).toEqual({ projectId: 'p1', events: [{ type: 'rescan' }] });
    expect(restarts).toEqual(['server']);
    expect(server.port).toBe(firstPort);
    expect(await server.answers()).toBe(true);

    recovery.dispose();
    hub.stop();
    await registry.release('p1');
  });

  it('no power event, only a clock jump: the drift check runs the same recovery', async () => {
    const os = deadAfterSleepWatch();
    const hub = new ProjectWatchHub((r, emit) => new ProjectWatcher(r, emit, { watch: os.watch }));
    const target = new Target();
    hub.watch('p1', root, target);
    await until(() => os.attached.length === 1);
    let clock = 0;
    let tick: () => void = () => undefined;
    const recovery = new WakeRecovery({
      power: new EventEmitter() as unknown as WakeRecoveryDeps['power'],
      signals: wakeSignals('win32'),
      watchers: hub,
      preview: {
        wakeSubject: () => null,
        forgetStalePing: () => undefined,
        serverAnswers: async () => true,
        pageAnswers: async () => true,
        restartAfterWake: async () => true,
      },
      now: () => clock,
      settleMs: 0,
      timers: {
        setInterval: (callback) => {
          tick = callback;
          return 0;
        },
        clearInterval: () => undefined,
        setTimeout: (callback, ms) => setTimeout(callback, ms),
      },
    });
    recovery.install();
    clock += 30 * 60_000; // half an hour of Modern Standby
    tick();
    await until(() => recovery.last !== null);
    expect(recovery.last).toMatchObject({ trigger: 'clock-jump', watcher: 'rescanned', server: 'none' });
    expect(os.attached).toHaveLength(2);
    expect(target.sent.at(-1)?.events).toEqual([{ type: 'rescan' }]);
    recovery.dispose();
    hub.stop();
  });
});
