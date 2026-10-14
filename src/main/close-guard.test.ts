import { describe, expect, it, vi } from 'vitest';
import { EVENTS } from '../shared/ipc/contract';
import { installCloseGuard, type CloseEventLike } from './close-guard';

function fakeWindow() {
  let listener: ((event: CloseEventLike) => void) | undefined;
  const contentsListeners = new Map<string, () => void>();
  const win = {
    closed: 0,
    crashed: false,
    loading: false,
    emit: (event: string) => contentsListeners.get(event)?.(),
    sent: [] as string[],
    on: (_event: 'close', l: (event: CloseEventLike) => void) => {
      listener = l;
    },
    isDestroyed: () => false,
    webContents: {
      send: (channel: string) => void win.sent.push(channel),
      isCrashed: () => win.crashed,
      isLoading: () => win.loading,
      on: (event: string, l: () => void) => void contentsListeners.set(event, l),
    },
    /** What Electron does on win.close(): emit 'close'; the window closes unless a listener prevented it. */
    close() {
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      listener?.(event);
      if (!event.prevented) win.closed += 1;
    },
  };
  return win;
}

function fakeTimers() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (callback: () => void) => {
      timers.set(next, callback);
      return next++;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    fire: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    count: () => timers.size,
  };
}

describe('close guard (S10.6)', () => {
  it('holds the close, asks the workbench to save, and closes once it answers ok', () => {
    const win = fakeWindow();
    const timers = fakeTimers();
    const onAllowed = vi.fn();
    const guard = installCloseGuard(win, { ...timers, onAllowed });
    win.close();
    expect(win.closed).toBe(0);
    expect(win.sent).toEqual([EVENTS.closeRequested]);
    expect(guard.pending).toBe(true);
    guard.answer({ ok: true });
    expect(win.closed).toBe(1);
    expect(onAllowed).toHaveBeenCalledTimes(1);
    expect(timers.count()).toBe(0);
  });

  it('keeps the window open when a save failed, and asks again on the next close', () => {
    const win = fakeWindow();
    const onRefused = vi.fn();
    const guard = installCloseGuard(win, { ...fakeTimers(), onRefused });
    win.close();
    guard.answer({ ok: false });
    expect(win.closed).toBe(0);
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(guard.pending).toBe(false);
    win.close();
    expect(win.sent).toEqual([EVENTS.closeRequested, EVENTS.closeRequested]);
    guard.answer({ ok: true });
    expect(win.closed).toBe(1);
  });

  it('asks only once while an answer is pending, and ignores answers nobody asked for', () => {
    const win = fakeWindow();
    const guard = installCloseGuard(win, fakeTimers());
    guard.answer({ ok: true });
    expect(win.closed).toBe(0);
    win.close();
    win.close();
    expect(win.sent).toHaveLength(1);
  });

  it('closes when the renderer becomes unresponsive or goes away while we wait', () => {
    for (const event of ['unresponsive', 'render-process-gone']) {
      const win = fakeWindow();
      installCloseGuard(win, fakeTimers());
      win.emit(event); // nothing pending: ignored
      expect(win.closed).toBe(0);
      win.close();
      win.emit(event);
      expect(win.closed).toBe(1);
    }
  });

  it('does not ask a page that is still loading (it has no edits yet)', () => {
    const win = fakeWindow();
    installCloseGuard(win, fakeTimers());
    win.loading = true;
    win.close();
    expect(win.closed).toBe(1);
    expect(win.sent).toEqual([]);
  });

  it('closes without saving only after a refused close, on explicit request', () => {
    const win = fakeWindow();
    const onAllowed = vi.fn();
    const guard = installCloseGuard(win, { ...fakeTimers(), onAllowed });
    guard.discardAndClose(); // no refused close yet: ignored
    expect(win.closed).toBe(0);
    win.close();
    guard.answer({ ok: false });
    guard.discardAndClose();
    expect(win.closed).toBe(1);
    expect(onAllowed).toHaveBeenCalledTimes(1);
  });

  it('closes after the long backstop when the workbench never answers', () => {
    const win = fakeWindow();
    const timers = fakeTimers();
    installCloseGuard(win, timers);
    win.close();
    timers.fire();
    expect(win.closed).toBe(1);
  });

  it('does not wait for a crashed renderer', () => {
    const win = fakeWindow();
    installCloseGuard(win, fakeTimers());
    win.crashed = true;
    win.close();
    expect(win.closed).toBe(1);
    expect(win.sent).toEqual([]);
  });
});
