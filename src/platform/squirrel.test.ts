import { describe, expect, it } from 'vitest';
import { runSquirrelAction, squirrelAction, SQUIRREL_HOOK_TIMEOUT_MS, type SquirrelRunner } from './squirrel';

const exe = 'C:\\Users\\林 小雨\\AppData\\Local\\NoobIDE\\app-0.1.0\\noobide.exe';

describe('squirrelAction', () => {
  it('does nothing outside Windows or without a Squirrel flag', () => {
    expect(squirrelAction('darwin', ['x', '--squirrel-install'], '/Applications/NoobIDE.app')).toEqual({
      kind: 'none',
    });
    expect(squirrelAction('win32', ['x'], exe)).toEqual({ kind: 'none' });
  });

  it('creates shortcuts on install and update via Update.exe next to the app folder (Chinese + space path)', () => {
    for (const flag of ['--squirrel-install', '--squirrel-updated']) {
      expect(squirrelAction('win32', ['x', flag], exe)).toEqual({
        kind: 'run-update-exe',
        updateExe: 'C:\\Users\\林 小雨\\AppData\\Local\\NoobIDE\\Update.exe',
        args: ['--createShortcut=noobide.exe'],
      });
    }
  });

  it('removes shortcuts on uninstall and quits when obsolete', () => {
    expect(squirrelAction('win32', ['x', '--squirrel-uninstall'], exe)).toMatchObject({
      kind: 'run-update-exe',
      args: ['--removeShortcut=noobide.exe'],
    });
    expect(squirrelAction('win32', ['x', '--squirrel-obsolete'], exe)).toEqual({ kind: 'quit' });
  });
});

describe('runSquirrelAction (S28.4)', () => {
  function fakeRunner(spawnBehaviour: 'ok' | 'throws' = 'ok') {
    const listeners = new Map<string, () => void>();
    const timers: { ms: number; callback: () => void }[] = [];
    const spawned: { command: string; args: readonly string[] }[] = [];
    let quits = 0;
    const runner: SquirrelRunner = {
      spawn: (command, args) => {
        if (spawnBehaviour === 'throws') throw new Error('ENOENT');
        spawned.push({ command, args });
        const child = {
          on: (event: string, listener: () => void) => {
            listeners.set(event, listener);
            return child;
          },
        };
        return child;
      },
      quit: () => void (quits += 1),
      setTimeout: (callback, ms) => timers.push({ ms, callback }),
    };
    return { runner, listeners, timers, spawned, quits: () => quits };
  }

  const install = squirrelAction('win32', ['x', '--squirrel-install'], exe);

  it('runs Update.exe and quits once it closes (a late timeout does not quit twice)', () => {
    const f = fakeRunner();
    runSquirrelAction(install, f.runner);
    expect(f.spawned).toEqual([
      { command: 'C:\\Users\\林 小雨\\AppData\\Local\\NoobIDE\\Update.exe', args: ['--createShortcut=noobide.exe'] },
    ]);
    expect(f.quits()).toBe(0);
    f.listeners.get('close')?.();
    f.timers[0]?.callback();
    expect(f.quits()).toBe(1);
  });

  it('quits when Update.exe cannot be started or fails, and after the timeout when it hangs', () => {
    const throws = fakeRunner('throws');
    runSquirrelAction(install, throws.runner);
    expect(throws.quits()).toBe(1);

    const fails = fakeRunner();
    runSquirrelAction(install, fails.runner);
    fails.listeners.get('error')?.();
    fails.listeners.get('close')?.();
    expect(fails.quits()).toBe(1);

    const hangs = fakeRunner();
    runSquirrelAction(install, hangs.runner);
    expect(hangs.timers.map((t) => t.ms)).toEqual([SQUIRREL_HOOK_TIMEOUT_MS]);
    hangs.timers[0]?.callback();
    expect(hangs.quits()).toBe(1);
  });

  it('quits at once when obsolete and does nothing for a normal start or the first run after install', () => {
    const obsolete = fakeRunner();
    runSquirrelAction({ kind: 'quit' }, obsolete.runner);
    expect([obsolete.quits(), obsolete.spawned.length]).toEqual([1, 0]);
    for (const argv of [['x'], ['x', '--squirrel-firstrun']]) {
      const normal = fakeRunner();
      runSquirrelAction(squirrelAction('win32', argv, exe), normal.runner);
      expect([normal.quits(), normal.spawned.length, normal.timers.length]).toEqual([0, 0, 0]);
    }
  });
});
