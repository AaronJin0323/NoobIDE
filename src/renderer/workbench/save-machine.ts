/**
 * Save state machine of one open file (S10.2, PLAN §7). Pure: no timers, no I/O, so every rule is unit-tested.
 *
 *   clean    — unchanged since it was opened
 *   dirty    — has edits that are not on disk yet
 *   saving   — a write is in flight (for the revision recorded in `savingRevision`)
 *   saved    — the newest edit was written and the write was confirmed
 *   failed   — the last write failed; the edits are still only in memory (the error says why)
 *   conflict — the file changed on disk while it had unsaved edits; nothing is written automatically (S11)
 *
 * A write only counts for the revision it carried: typing during a save leaves the file dirty. Saving is a separate
 * mechanism from undo, crash recovery and local history (AGENTS.md); this module knows nothing about them.
 */
export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict';

export const SAVE_STATUSES: readonly SaveStatus[] = ['clean', 'dirty', 'saving', 'saved', 'failed', 'conflict'];

export interface SaveError {
  /** Contract error code, e.g. `permission-denied`, `busy`, `disk-full`. */
  readonly code: string;
  /** Technical detail such as the OS error code. Never file contents. */
  readonly message: string;
}

export interface SaveSnapshot {
  /** Incremented on every edit. */
  readonly revision: number;
  /** Newest revision confirmed on disk. */
  readonly savedRevision: number;
  /** Revision of the write in flight, if any. */
  readonly savingRevision: number | null;
  /** Error of the last failed write; cleared by the next successful one. */
  readonly error: SaveError | null;
  /** Disk changed under unsaved edits; autosave stops until the user decides (S11.2). */
  readonly conflict: boolean;
  /** At least one write succeeded since the file was opened. */
  readonly hasSaved: boolean;
}

export type SaveEvent =
  | { readonly type: 'edited' }
  | { readonly type: 'saveStarted' }
  | { readonly type: 'saveSucceeded'; readonly revision: number }
  | { readonly type: 'saveFailed'; readonly error: SaveError }
  | { readonly type: 'externalChange' }
  | { readonly type: 'conflictResolved' };

export const INITIAL_SAVE: SaveSnapshot = {
  revision: 0,
  savedRevision: 0,
  savingRevision: null,
  error: null,
  conflict: false,
  hasSaved: false,
};

export function saveReducer(state: SaveSnapshot, event: SaveEvent): SaveSnapshot {
  switch (event.type) {
    case 'edited':
      return { ...state, revision: state.revision + 1 };
    case 'saveStarted':
      return { ...state, savingRevision: state.revision };
    case 'saveSucceeded':
      return {
        ...state,
        savingRevision: null,
        savedRevision: Math.max(state.savedRevision, event.revision),
        error: null,
        hasSaved: true,
      };
    case 'saveFailed':
      return { ...state, savingRevision: null, error: event.error };
    case 'externalChange':
      // A clean buffer simply reloads (S11.1); only unsaved edits make a conflict.
      return isUnsaved(state) ? { ...state, conflict: true } : state;
    case 'conflictResolved':
      return { ...state, conflict: false };
  }
}

export function isUnsaved(state: SaveSnapshot): boolean {
  return state.revision !== state.savedRevision;
}

export function saveStatus(state: SaveSnapshot): SaveStatus {
  if (state.conflict) return 'conflict';
  if (state.savingRevision !== null) return 'saving';
  if (isUnsaved(state)) return state.error ? 'failed' : 'dirty';
  return state.hasSaved ? 'saved' : 'clean';
}

/** A write is allowed whenever there is something to write, except over a conflict (resolved by the user, S11.2). */
export function canSave(state: SaveSnapshot): boolean {
  return isUnsaved(state) && !state.conflict;
}
