import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { EVENTS, type WatchEvent } from '../shared/ipc/contract';
import type { ProjectWatcher } from '../workspace/watcher';
import { ProjectWatchHub, type EventTarget } from './project-watch';

function fakeWatcher() {
  const watcher = { start: vi.fn(async () => undefined), close: vi.fn() };
  let emit: (events: WatchEvent[]) => void = () => undefined;
  const create = vi.fn((_root: string, e: (events: WatchEvent[]) => void) => {
    emit = e;
    return watcher as unknown as ProjectWatcher;
  });
  return { watcher, create, emit: (events: WatchEvent[]) => emit(events) };
}

/** A webContents stand-in: a real EventEmitter, so listener counts are real. */
class FakeContents extends EventEmitter implements EventTarget {
  destroyed = false;
  send = vi.fn();
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

describe('project watch hub (S07.3)', () => {
  it('forwards events only to the window that opened the project', () => {
    const fake = fakeWatcher();
    const hub = new ProjectWatchHub(fake.create);
    const win = new FakeContents();
    hub.watch(ID, '/p', win);
    expect(fake.watcher.start).toHaveBeenCalled();
    fake.emit([{ type: 'created', relPath: 'a.html' }]);
    expect(win.send).toHaveBeenCalledWith(EVENTS.changed, {
      projectId: ID,
      events: [{ type: 'created', relPath: 'a.html' }],
    });
  });

  it('stops the previous watcher when another project opens, and when the window closes', () => {
    const first = fakeWatcher();
    const second = fakeWatcher();
    const create = vi.fn((root: string, emit: (events: WatchEvent[]) => void) =>
      root === '/a' ? first.create(root, emit) : second.create(root, emit),
    );
    const hub = new ProjectWatchHub(create);
    const win = new FakeContents();
    hub.watch(ID, '/a', win);
    hub.watch(ID, '/b', win);
    expect(first.watcher.close).toHaveBeenCalled();
    expect(second.watcher.close).not.toHaveBeenCalled();
    win.destroy();
    expect(second.watcher.close).toHaveBeenCalled();
  });

  it('does not accumulate destroyed listeners over many project switches (review finding 5)', () => {
    const hub = new ProjectWatchHub(() => fakeWatcher().watcher as unknown as ProjectWatcher);
    const win = new FakeContents();
    const warning = vi.fn();
    process.on('warning', warning);
    try {
      for (let i = 0; i < 25; i += 1) hub.watch(ID, `/p${i}`, win);
      expect(win.listenerCount('destroyed')).toBe(1);
      hub.stop();
      expect(win.listenerCount('destroyed')).toBe(0);
    } finally {
      process.off('warning', warning);
    }
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not send to a destroyed window', () => {
    const fake = fakeWatcher();
    const hub = new ProjectWatchHub(fake.create);
    const win = new FakeContents();
    win.destroyed = true;
    hub.watch(ID, '/p', win);
    fake.emit([{ type: 'rescan' }]);
    expect(win.send).not.toHaveBeenCalled();
  });
});
