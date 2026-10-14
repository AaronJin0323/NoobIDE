import { describe, expect, it } from 'vitest';
import { MAX_RESTARTS_PER_MINUTE, WorkerSupervisor, type WorkerKind, type WorkerLike } from './worker-supervisor';

class FakeWorker implements WorkerLike {
  sent: unknown[] = [];
  terminated = false;
  private listeners: Record<string, (() => void)[]> = {};
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  addEventListener(type: 'message' | 'error', listener: () => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  terminate() {
    this.terminated = true;
  }
  fire(type: 'message' | 'error') {
    for (const l of this.listeners[type] ?? []) l();
  }
}

function setup() {
  let now = 0;
  const restarts: WorkerKind[] = [];
  const supervisor = new WorkerSupervisor({
    restart: (kind) => restarts.push(kind),
    stallMs: 1000,
    now: () => now,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  return { supervisor, restarts, advance: (ms: number) => (now += ms) };
}

describe('WorkerSupervisor (S18.4)', () => {
  it('leaves a worker alone while it answers', () => {
    const { supervisor, restarts, advance } = setup();
    const w = supervisor.watch('ts', new FakeWorker());
    w.postMessage({ id: 1 });
    advance(900);
    w.fire('message');
    advance(5000);
    supervisor.check();
    expect(restarts).toEqual([]);
    expect(w.sent).toEqual([{ id: 1 }]); // messages still reach the worker
  });

  it('an idle worker (nothing outstanding) is never restarted', () => {
    const { supervisor, restarts, advance } = setup();
    supervisor.watch('css', new FakeWorker());
    advance(60_000);
    supervisor.check();
    expect(restarts).toEqual([]);
  });

  it('restarts a killed or stuck worker: a request without any reply for stallMs', () => {
    const { supervisor, restarts, advance } = setup();
    const w = supervisor.watch('ts', new FakeWorker());
    w.postMessage({ id: 1 });
    advance(500);
    w.postMessage({ id: 2 }); // still measured from the oldest unanswered request
    advance(600);
    supervisor.check();
    expect(restarts).toEqual(['ts']);
    expect(w.terminated).toBe(true);
    expect(supervisor.live('ts')).toEqual([]);
    expect(supervisor.restartCount).toBe(1);
    advance(5000);
    supervisor.check();
    expect(restarts).toEqual(['ts']); // replaced once, not again
  });

  it('restarts a crashed worker on its error event', () => {
    const { supervisor, restarts } = setup();
    const w = supervisor.watch('html', new FakeWorker());
    w.fire('error');
    w.fire('error');
    expect(restarts).toEqual(['html']);
  });

  it('does not restart in a loop when a worker keeps dying', () => {
    const { supervisor, restarts, advance } = setup();
    for (let i = 0; i < MAX_RESTARTS_PER_MINUTE + 3; i += 1) {
      supervisor.watch('ts', new FakeWorker()).fire('error');
      advance(1000);
    }
    expect(restarts).toHaveLength(MAX_RESTARTS_PER_MINUTE);
    advance(60_000);
    supervisor.watch('ts', new FakeWorker()).fire('error');
    expect(restarts).toHaveLength(MAX_RESTARTS_PER_MINUTE + 1);
  });
});
