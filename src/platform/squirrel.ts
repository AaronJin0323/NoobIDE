import path from 'node:path';

/**
 * Windows Squirrel installer events (S02.7). Squirrel launches the app with one of these flags during install,
 * update and uninstall; the app must create/remove shortcuts via Update.exe and quit instead of opening a window.
 * Equivalent to the `electron-squirrel-startup` package, kept here to avoid a dependency (AGENTS.md: platform code
 * lives in src/platform).
 */
export type SquirrelAction =
  { kind: 'none' } | { kind: 'quit' } | { kind: 'run-update-exe'; updateExe: string; args: string[] };

export function squirrelAction(platform: NodeJS.Platform, argv: readonly string[], execPath: string): SquirrelAction {
  if (platform !== 'win32') return { kind: 'none' };
  const cmd = argv[1];
  const updateExe = path.win32.resolve(path.win32.dirname(execPath), '..', 'Update.exe');
  const target = path.win32.basename(execPath);
  switch (cmd) {
    case '--squirrel-install':
    case '--squirrel-updated':
      return { kind: 'run-update-exe', updateExe, args: [`--createShortcut=${target}`] };
    case '--squirrel-uninstall':
      return { kind: 'run-update-exe', updateExe, args: [`--removeShortcut=${target}`] };
    case '--squirrel-obsolete':
      return { kind: 'quit' };
    default:
      return { kind: 'none' };
  }
}

/** Convenience wrapper for main.ts: decides from the real process. */
export function currentSquirrelAction(): SquirrelAction {
  return squirrelAction(process.platform, process.argv, process.execPath);
}
