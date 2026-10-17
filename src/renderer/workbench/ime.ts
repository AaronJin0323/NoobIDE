/**
 * The one IME guard of the renderer (S35.4, stage 2 in S48.3). Chat, inline edit, rename, the project wizard, the
 * palette, annotation notes and dialogs all ask `isImeKey` before acting on a key, so an input method (Pinyin etc.)
 * owns candidate selection and cancellation.
 *
 * - Stage 1: a key is the IME's while composing, including the boundary key reported as legacy code 229.
 * - Stage 2: WebKit (macOS) ends the composition before the confirming keydown arrives, with isComposing false, so
 *   an Enter within IME_GRACE_MS of compositionend is still the IME's unless Ctrl or Cmd is held (a deliberate
 *   shortcut). An Escape that just closed a candidate list is stopped at the window, before any panel or dialog
 *   behind the field sees it (`installImeGuard`).
 */

export const IME_GRACE_MS = 500;

export interface ImeKeyLike {
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface ImeGuard {
  /** A compositionend happened now. */
  compositionEnded(): void;
  /** Whether the input method owns this key, so the app must not act on it. */
  isImeKey(event: ImeKeyLike): boolean;
}

export interface ImeGuardOptions {
  readonly now: () => number;
  /** Whether the engine is WebKit (navigator.vendor contains "Apple"); read per key, so tests can switch it. */
  readonly webkit: () => boolean;
}

export function createImeGuard({ now, webkit }: ImeGuardOptions): ImeGuard {
  let endedAt = Number.NEGATIVE_INFINITY;
  return {
    compositionEnded() {
      endedAt = now();
    },
    isImeKey(event) {
      if (event.isComposing === true || event.keyCode === 229) return true;
      if (event.key !== 'Enter' && event.key !== 'Escape') return false;
      if (now() - endedAt > IME_GRACE_MS || !webkit()) return false;
      // A held Ctrl/Cmd makes Enter a deliberate shortcut, never a candidate confirmation.
      return event.key === 'Escape' || (event.ctrlKey !== true && event.metaKey !== true);
    },
  };
}

function isWebKitVendor(): boolean {
  return typeof navigator !== 'undefined' && /Apple/.test(navigator.vendor ?? '');
}

const defaultGuard = createImeGuard({
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  webkit: isWebKitVendor,
});

/** IME owns candidate selection/cancellation, including the boundary key reported as legacy code 229. */
export function isImeKey(event: ImeKeyLike): boolean {
  return defaultGuard.isImeKey(event);
}

/** An options object, not `true`: some EventTarget implementations (Node's) do not match a boolean on removal. */
const CAPTURE = { capture: true } as const;

/**
 * Listens on `target` (the window) in the capture phase, before any other key handler: records compositionend for
 * the guard, and stops an IME-owned Escape there so it cannot close the panel or dialog behind the field. The
 * keydown is not cancelled: the input method has already used it. Returns the uninstaller.
 */
export function installImeGuard(target: EventTarget, guard: ImeGuard = defaultGuard): () => void {
  const onCompositionEnd = () => guard.compositionEnded();
  const onKeyDown = (event: Event) => {
    const key = event as Event & ImeKeyLike;
    if (key.key === 'Escape' && guard.isImeKey(key)) event.stopImmediatePropagation();
  };
  target.addEventListener('compositionend', onCompositionEnd, CAPTURE);
  target.addEventListener('keydown', onKeyDown, CAPTURE);
  return () => {
    target.removeEventListener('compositionend', onCompositionEnd, CAPTURE);
    target.removeEventListener('keydown', onKeyDown, CAPTURE);
  };
}
