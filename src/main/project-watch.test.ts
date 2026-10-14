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

function target(destroyed = false) {
  let onDestroyed: () => void = () => undefined;
  const t = {
    send: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((_e: 'destroyed', l: () => void) => (onDestroyed = l)),
  };
  return { t: t as EventTarget & typeof t, destroy: () => onDestroyed() };
}

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

describe('project watch hub (S07.3)', () => {
  it('forwards events only to the window that opened the project', () => {
    const fake = fakeWatcher();
    const hub = new ProjectWatchHub(fake.create);
    const { t } = target();
    hub.watch(ID, '/p', t);
    expect(fake.watcher.start).toHaveBeenCalled();
    fake.emit([{ type: 'created', relPath: 'a.html' }]);
    expect(t.send).toHaveBeenCalledWith(EVENTS.changed, {
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
    const win = target();
    hub.watch(ID, '/a', win.t);
    hub.watch(ID, '/b', win.t);
    expect(first.watcher.close).toHaveBeenCalled();
    expect(second.watcher.close).not.toHaveBeenCalled();
    win.destroy();
    expect(second.watcher.close).toHaveBeenCalled();
  });

  it('does not send to a destroyed window', () => {
    const fake = fakeWatcher();
    const hub = new ProjectWatchHub(fake.create);
    const { t } = target(true);
    hub.watch(ID, '/p', t);
    fake.emit([{ type: 'rescan' }]);
    expect(t.send).not.toHaveBeenCalled();
  });
});
