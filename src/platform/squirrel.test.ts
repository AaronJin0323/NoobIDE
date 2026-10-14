import { describe, expect, it } from 'vitest';
import { squirrelAction } from './squirrel';

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
