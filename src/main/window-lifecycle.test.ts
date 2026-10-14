import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installWindowLifecycle } from './window-lifecycle';

function setup(platform: NodeJS.Platform, windows: number) {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  let count = windows;
  const deps = {
    platform,
    windowCount: () => count,
    createWindow: vi.fn(() => {
      count += 1;
    }),
    focusFirstWindow: vi.fn(),
  };
  installWindowLifecycle(app, deps);
  return {
    app,
    deps,
    setCount: (n: number) => {
      count = n;
    },
  };
}

describe('window lifecycle (S24.2, PLAN §3)', () => {
  it('Windows exits when the last window closes and never reopens on activate', () => {
    const { app, deps } = setup('win32', 0);
    app.emit('window-all-closed');
    expect(app.quit).toHaveBeenCalledOnce();
    app.emit('activate');
    expect(deps.createWindow).not.toHaveBeenCalled();
  });

  it('macOS keeps running without windows and reopens one on activation (dock click)', () => {
    const { app, deps, setCount } = setup('darwin', 0);
    app.emit('window-all-closed');
    expect(app.quit).not.toHaveBeenCalled();
    app.emit('activate');
    expect(deps.createWindow).toHaveBeenCalledOnce();
    app.emit('activate'); // a window is open now: activation only brings the app forward
    expect(deps.createWindow).toHaveBeenCalledOnce();
    setCount(0);
    app.emit('second-instance'); // launching it again from Finder also opens a window
    expect(deps.createWindow).toHaveBeenCalledTimes(2);
  });

  it('a second launch focuses the existing window', () => {
    const { app, deps } = setup('win32', 1);
    app.emit('second-instance');
    expect(deps.focusFirstWindow).toHaveBeenCalledOnce();
    expect(deps.createWindow).not.toHaveBeenCalled();
  });
});
