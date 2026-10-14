import { EVENTS, type CloseAnswer } from '../shared/ipc/contract';

/**
 * Closing the window or quitting never drops unsaved edits (S10.6). Electron ignores a `beforeunload` return value
 * when the window closes, so main intercepts the window's `close` event instead: it cancels the close, asks the
 * workbench (EVENTS.closeRequested) to save every open file, and closes only when the answer is `ok`. A failed save
 * answers `ok: false`: the window stays open and shows the save failure with its retry / save-elsewhere actions.
 *
 * A renderer that crashed or does not answer at all cannot save anything; after `timeoutMs` the window closes so the
 * app is never stuck (crash recovery, S12, covers that case).
 */
export interface CloseEventLike {
  preventDefault(): void;
}

export interface GuardedWindow {
  on(event: 'close', listener: (event: CloseEventLike) => void): void;
  close(): void;
  isDestroyed(): boolean;
  readonly webContents: { send(channel: string): void; isCrashed(): boolean };
}

export interface CloseGuardOptions {
  readonly timeoutMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called after an allowed close, e.g. to resume an app quit that the guard interrupted. */
  readonly onAllowed?: () => void;
  /** Called when the workbench refused (a save failed), e.g. to cancel a pending quit. */
  readonly onRefused?: () => void;
}

export interface CloseGuard {
  answer(answer: CloseAnswer): void;
  /** True while waiting for the workbench's answer. */
  readonly pending: boolean;
}

export const CLOSE_ANSWER_TIMEOUT_MS = 20_000;

export function installCloseGuard(win: GuardedWindow, options: CloseGuardOptions = {}): CloseGuard {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let allowed = false;
  let timer: unknown = null;

  const settle = (ok: boolean) => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
    if (!ok) {
      options.onRefused?.();
      return;
    }
    allowed = true;
    if (!win.isDestroyed()) win.close();
    options.onAllowed?.();
  };

  win.on('close', (event) => {
    if (allowed || win.webContents.isCrashed()) return;
    event.preventDefault();
    if (timer !== null) return; // Already asked; a second click waits for the same answer.
    timer = setTimer(() => settle(true), options.timeoutMs ?? CLOSE_ANSWER_TIMEOUT_MS);
    win.webContents.send(EVENTS.closeRequested);
  });

  return {
    answer: (answer) => settle(answer.ok),
    get pending() {
      return timer !== null;
    },
  };
}
