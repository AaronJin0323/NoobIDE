/**
 * Save state machine of one open file (S10.2, PLAN §7). Pure: no timers, no I/O, so every rule is unit-tested.
 *
 *   clean    — unchanged since it was opened
 *   dirty    — has edits that are not on disk yet
 *   saving   — a write is in flight (for the revision recorded in `savingRevision`)
 *   saved    — the newest edit was written and the write was confirmed
 *   failed   — the last write failed; the edits are still only in memory (the error says why)
 *   conflict — the file changed on disk while it had unsaved edits; nothing is written automatically (S11.2)
 *   deleted  — the file was deleted (or moved away) outside NoobIDE; the text stays here, the user may re-save (S11.3)
 *
 * A write only counts for the revision it carried: typing during a save leaves the file dirty. Saving is a separate
 * mechanism from undo, crash recovery and local history (AGENTS.md); this module knows nothing about them.
 */
export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'conflict' | 'deleted';

export const SAVE_STATUSES: readonly SaveStatus[] = [
  'clean',
  'dirty',
  'saving',
  'saved',
  'failed',
  'conflict',
  'deleted',
];

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
  /** S11.3: the file is gone from disk; autosave stops, the text is kept until the user re-saves or closes. */
  readonly deleted: boolean;
  /** At least one write succeeded since the file was opened. */
  readonly hasSaved: boolean;
}

export type SaveEvent =
  | { readonly type: 'edited' }
  | { readonly type: 'saveStarted' }
  | { readonly type: 'saveSucceeded'; readonly revision: number }
  | { readonly type: 'saveFailed'; readonly error: SaveError }
  | { readonly type: 'externalChange' }
  | { readonly type: 'conflictResolved' }
  // --- S11: the buffer now holds the disk version (clean reload, or "take the disk version") ---
  | { readonly type: 'reloaded' }
  | { readonly type: 'deletedOnDisk' }
  | { readonly type: 'reappeared' };

export const INITIAL_SAVE: SaveSnapshot = {
  revision: 0,
  savedRevision: 0,
  savingRevision: null,
  error: null,
  conflict: false,
  deleted: false,
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
      return { ...state, conflict: false, error: null };
    case 'reloaded': {
      // The disk text replaces the buffer: one new revision, already "on disk". Nothing is left to write.
      const revision = state.revision + 1;
      return { ...state, revision, savedRevision: revision, error: null, conflict: false, deleted: false };
    }
    case 'deletedOnDisk':
      // There is no disk version left to compare. Keep the edits, but retire the obsolete conflict.
      return { ...state, deleted: true, conflict: false };
    case 'reappeared':
      return { ...state, deleted: false };
  }
}

export function isUnsaved(state: SaveSnapshot): boolean {
  return state.revision !== state.savedRevision;
}

export function saveStatus(state: SaveSnapshot): SaveStatus {
  if (state.conflict) return 'conflict';
  if (state.deleted) return 'deleted';
  if (state.savingRevision !== null) return 'saving';
  if (isUnsaved(state)) return state.error ? 'failed' : 'dirty';
  return state.hasSaved ? 'saved' : 'clean';
}

/**
 * A write is allowed whenever there is something to write, except over a conflict (resolved by the user, S11.2) or
 * for a file deleted on disk (re-created only when the user asks, S11.3).
 */
export function canSave(state: SaveSnapshot): boolean {
  return isUnsaved(state) && !state.conflict && !state.deleted;
}
