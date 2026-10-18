import { EVENTS, type CloseAnswer } from '../shared/ipc/contract';

/**
 * Closing the window or quitting never drops unsaved edits (S10.6). Electron ignores a `beforeunload` return value
 * when the window closes, so main intercepts the window's `close` event instead: it cancels the close, asks the
 * workbench (EVENTS.closeRequested) to save every open file, and closes only when the answer is `ok`. A failed save
 * answers `ok: false`: the window stays open and shows the save failure with retry / save elsewhere, plus an explicit
 * "close without saving" choice so a file that can never be saved does not trap the user (`discardAndClose`).
 *
 * A busy renderer (many files, a slow disk, a locked file being retried) is not cut off: the window is closed without
 * an answer only when the renderer is gone or reported unresponsive, or after a long backstop (`timeoutMs`). A page
 * that is still loading has no edits yet and closes at once. Crash recovery (S12) covers the abnormal cases.
 */
export interface CloseEventLike {
  preventDefault(): void;
}

export interface GuardedWebContents {
  send(channel: string): void;
  isCrashed(): boolean;
  isLoading(): boolean;
  on(event: 'unresponsive' | 'render-process-gone', listener: () => void): void;
}

export interface GuardedWindow {
  on(event: 'close', listener: (event: CloseEventLike) => void): void;
  close(): void;
  isDestroyed(): boolean;
  readonly webContents: GuardedWebContents;
}

export interface CloseGuardOptions {
  readonly timeoutMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called after an allowed close, e.g. to resume an app quit that the guard interrupted. */
  readonly onAllowed?: () => void;
  /** Called when the workbench refused (a save failed), e.g. to cancel a pending quit. */
  readonly onRefused?: () => void;
  /** Each step of the handshake, for the content-free app log (a close that seems to hang can be traced). */
  readonly onStep?: (step: CloseStep) => void;
}

export type CloseStep = 'asked' | 'answered-ok' | 'answered-refused' | 'gave-up' | 'not-guarded';

export interface CloseGuard {
  answer(answer: CloseAnswer): void;
  /** The user explicitly chose to close without saving the files that failed (after a refused close). */
  discardAndClose(): void;
  /** True while waiting for the workbench's answer. */
  readonly pending: boolean;
}

/** Backstop only; a live renderer that is saving is normally answered within seconds. */
export const CLOSE_ANSWER_TIMEOUT_MS = 120_000;

export function installCloseGuard(win: GuardedWindow, options: CloseGuardOptions = {}): CloseGuard {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let allowed = false;
  let refused = false;
  let timer: unknown = null;

  const allow = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    allowed = true;
    if (!win.isDestroyed()) win.close();
    options.onAllowed?.();
  };

  const settle = (ok: boolean) => {
    if (timer === null) return;
    options.onStep?.(ok ? 'answered-ok' : 'answered-refused');
    if (ok) {
      allow();
      return;
    }
    clearTimer(timer);
    timer = null;
    refused = true;
    options.onRefused?.();
  };

  // A renderer that hangs or dies while we wait can no longer save; do not keep the window hostage.
  const giveUp = () => {
    if (timer === null) return;
    options.onStep?.('gave-up');
    allow();
  };
  win.webContents.on('unresponsive', giveUp);
  win.webContents.on('render-process-gone', giveUp);

  win.on('close', (event) => {
    if (allowed) return;
    if (win.webContents.isCrashed() || win.webContents.isLoading()) {
      options.onStep?.('not-guarded');
      return;
    }
    event.preventDefault();
    if (timer !== null) return; // Already asked; a second click waits for the same answer.
    options.onStep?.('asked');
    timer = setTimer(giveUp, options.timeoutMs ?? CLOSE_ANSWER_TIMEOUT_MS);
    win.webContents.send(EVENTS.closeRequested);
  });

  return {
    answer: (answer) => settle(answer.ok),
    discardAndClose: () => {
      // Only offered after a refusal; a page cannot use it to skip the save of a close that never happened.
      if (refused && timer === null) allow();
    },
    get pending() {
      return timer !== null;
    },
  };
}
