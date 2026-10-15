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
    // `--squirrel-firstrun` (the launch right after installing) and every other argument start the app normally.
    default:
      return { kind: 'none' };
  }
}

/** What {@link runSquirrelAction} needs from Node and Electron (injected for tests). */
export interface SquirrelRunner {
  spawn(command: string, args: readonly string[]): { on(event: 'close' | 'error', listener: () => void): unknown };
  quit(): void;
  setTimeout(callback: () => void, ms: number): unknown;
}

/** Squirrel gives each hook about 15 s; we quit well before that even when Update.exe hangs. */
export const SQUIRREL_HOOK_TIMEOUT_MS = 10_000;

/**
 * S28.4: performs a Squirrel action and quits exactly once — when Update.exe finishes, when it cannot be started
 * (e.g. a portable copy without Update.exe next to it) or after {@link SQUIRREL_HOOK_TIMEOUT_MS}. It never opens a
 * window and never touches app data or projects: uninstalling removes the app and its shortcuts only
 * (docs/decisions/0023-upgrade-and-uninstall.md).
 */
export function runSquirrelAction(action: SquirrelAction, runner: SquirrelRunner): void {
  if (action.kind === 'none') return;
  let done = false;
  const quit = () => {
    if (done) return;
    done = true;
    runner.quit();
  };
  if (action.kind === 'quit') {
    quit();
    return;
  }
  runner.setTimeout(quit, SQUIRREL_HOOK_TIMEOUT_MS);
  try {
    const child = runner.spawn(action.updateExe, action.args);
    child.on('close', quit);
    child.on('error', quit);
  } catch {
    quit();
  }
}

/** Convenience wrapper for main.ts: decides from the real process. */
export function currentSquirrelAction(): SquirrelAction {
  return squirrelAction(process.platform, process.argv, process.execPath);
}
