import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TS_IDLE_CHECK_MS,
  TS_WORKER_IDLE_MS,
  TsWorkerIdleStop,
  installTsIdleStop,
  type TsWorkerManagerLike,
} from './ts-idle-stop';
import { WorkerSupervisor, type WorkerLike } from './worker-supervisor';

/** A stand-in for Monaco's TypeScript WorkerManager: a worker is created lazily per request and dropped on stop. */
class FakeManager implements TsWorkerManagerLike {
  _worker: { id: number } | null = null;
  created = 0;
  stopped = 0;
  async getLanguageServiceWorker(): Promise<unknown> {
    if (!this._worker) this._worker = { id: (this.created += 1) };
    return this._worker;
  }
  _stopWorker(): void {
    if (this._worker) this.stopped += 1;
    this._worker = null;
  }
}

class FakeWorker implements WorkerLike {
  terminated = false;
  private listeners: Record<string, (() => void)[]> = {};
  postMessage(_message?: unknown): void {}
  addEventListener(type: 'message' | 'error', listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  terminate() {
    this.terminated = true;
  }
  reply() {
    for (const l of this.listeners.message ?? []) l();
  }
}

describe('TypeScript worker idle stop (S59.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(busy = () => false) {
    const retired: number[] = [];
    const idle = new TsWorkerIdleStop({
      busy,
      retire: () => retired.push(Date.now()),
      now: () => Date.now(),
    });
    // A fresh prototype per test, wrapped the way monaco-setup.ts wraps Monaco's.
    class Manager extends FakeManager {}
    expect(installTsIdleStop(Manager.prototype, idle)).toBe(true);
    return { idle, retired, Manager };
  }

  it('stops the worker after the idle period without requests, and not before', async () => {
    const { idle, retired, Manager } = setup();
    const manager = new Manager();
    await manager.getLanguageServiceWorker();
    expect(manager._worker).not.toBeNull();

    await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS - TS_IDLE_CHECK_MS);
    expect(manager.stopped).toBe(0);
    await vi.advanceTimersByTimeAsync(TS_IDLE_CHECK_MS);
    expect(manager.stopped).toBe(1);
    expect(manager._worker).toBeNull();
    expect(idle.stopCount).toBe(1);
    expect(retired).toHaveLength(1);
  });

  it('any request resets the idle period', async () => {
    const { Manager } = setup();
    const manager = new Manager();
    await manager.getLanguageServiceWorker();
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS - TS_IDLE_CHECK_MS);
      await manager.getLanguageServiceWorker();
    }
    expect(manager.stopped).toBe(0);
    expect(manager.created).toBe(1);
  });

  it('starts a fresh worker transparently on the next request after a stop', async () => {
    const { Manager } = setup();
    const manager = new Manager();
    await manager.getLanguageServiceWorker();
    await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS + TS_IDLE_CHECK_MS);
    expect(manager._worker).toBeNull();

    expect(await manager.getLanguageServiceWorker()).toEqual({ id: 2 });
    expect(manager.created).toBe(2);
    // ...and that worker is stopped again once idle.
    await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS + TS_IDLE_CHECK_MS);
    expect(manager.stopped).toBe(2);
  });

  it('never stops a worker while a request is waiting for its reply', async () => {
    let busy = true;
    const { Manager } = setup(() => busy);
    const manager = new Manager();
    await manager.getLanguageServiceWorker();
    await vi.advanceTimersByTimeAsync(3 * TS_WORKER_IDLE_MS);
    expect(manager.stopped).toBe(0);
    busy = false;
    await vi.advanceTimersByTimeAsync(TS_IDLE_CHECK_MS);
    expect(manager.stopped).toBe(1);
  });

  it('stops each manager on its own and retires the supervised workers only when none runs', async () => {
    const { retired, Manager } = setup();
    const javascript = new Manager();
    const typescript = new Manager();
    await javascript.getLanguageServiceWorker();
    await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS / 2);
    await typescript.getLanguageServiceWorker();
    await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS / 2 + TS_IDLE_CHECK_MS);
    expect(javascript.stopped).toBe(1);
    expect(typescript.stopped).toBe(0);
    expect(retired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(TS_WORKER_IDLE_MS / 2);
    expect(typescript.stopped).toBe(1);
    expect(retired).toHaveLength(1);
  });

  it('does nothing when no worker was ever requested', async () => {
    const { idle } = setup();
    idle.check();
    await vi.advanceTimersByTimeAsync(10 * TS_WORKER_IDLE_MS);
    expect(idle.stopCount).toBe(0);
  });

  it('leaves Monaco alone when the private members it needs are missing', () => {
    const idle = new TsWorkerIdleStop({ busy: () => false, retire: () => undefined });
    const original = async () => null;
    const noStop = { getLanguageServiceWorker: original };
    expect(installTsIdleStop(noStop, idle)).toBe(false);
    expect(noStop.getLanguageServiceWorker).toBe(original);
    expect(installTsIdleStop(undefined, idle)).toBe(false);
    expect(installTsIdleStop({ _stopWorker: () => undefined }, idle)).toBe(false);
  });

  it('works with the supervisor: busy while a request is outstanding, retire terminates without a restart', () => {
    const restarts: string[] = [];
    const supervisor = new WorkerSupervisor({
      restart: (kind) => restarts.push(kind),
      setInterval: () => 1,
      clearInterval: () => undefined,
      now: () => 0,
    });
    const ts = supervisor.watch('ts', new FakeWorker());
    const css = supervisor.watch('css', new FakeWorker());
    expect(supervisor.busy('ts')).toBe(false);
    ts.postMessage({ id: 1 });
    expect(supervisor.busy('ts')).toBe(true);
    expect(supervisor.busy('css')).toBe(false);
    ts.reply();
    expect(supervisor.busy('ts')).toBe(false);

    expect(supervisor.retire('ts')).toBe(1);
    expect(ts.terminated).toBe(true);
    expect(css.terminated).toBe(false);
    expect(supervisor.live('ts')).toEqual([]);
    expect(supervisor.live('css')).toEqual([css]);
    expect(restarts).toEqual([]);
    expect(supervisor.retire('ts')).toBe(0);
  });
});

describe("Monaco's TypeScript WorkerManager still has what the idle stop relies on (S59.5 pin)", () => {
  // A Monaco upgrade that renames these turns the idle stop off silently (installTsIdleStop returns false); this
  // test makes the upgrade notice instead.
  const require = createRequire(import.meta.url);
  // The same specifier monaco-setup.ts imports, resolved through Monaco's "exports" map.
  const managerFile = require.resolve('monaco-editor/languages/features/typescript/workerManager.js');
  const source = readFileSync(managerFile, 'utf8');
  const tsMode = readFileSync(path.join(path.dirname(managerFile), 'tsMode.js'), 'utf8');

  it('creates the worker lazily in getLanguageServiceWorker and drops it in _stopWorker', () => {
    expect(source).toMatch(/async getLanguageServiceWorker\(\.\.\.resources\)/);
    expect(source).toMatch(
      /_stopWorker\(\) \{\s*if \(this\._worker\) \{\s*this\._worker\.dispose\(\);\s*this\._worker = null;\s*\}\s*this\._client = null;/,
    );
    expect(source).toMatch(/if \(!this\._client\) \{/);
    // A new worker receives every open model of the language (NoobIDE sets eager model sync) and the extra libs.
    expect(source).toMatch(/getEagerModelSync\(\)/);
    expect(source).toMatch(/extraLibs: this\._defaults\.getExtraLibs\(\)/);
  });

  it('is the class every language feature asks for its worker', () => {
    expect(tsMode).toMatch(/import \{ WorkerManager \} from '\.\/workerManager\.js'/);
    expect(tsMode).toMatch(/client\.getLanguageServiceWorker\(\.\.\.uris\)/);
  });
});
