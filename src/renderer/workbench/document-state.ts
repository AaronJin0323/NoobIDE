import type { FileContent, OpenedProject, ReadFileError, WriteFileError } from '../../shared/ipc/contract';

/**
 * Project, open document and save state of the workbench (S03.3, S03.4). Pure reducer so the save rules are tested:
 * a save only counts as "saved" for the revision it wrote — typing during a save leaves the document unsaved — and a
 * failed save keeps the text and says why (AGENTS.md: user data is sacred). Tabs and multiple models: S09.
 */
export type SaveState = 'clean' | 'dirty' | 'saving' | 'failed';

export interface OpenDocument {
  readonly relPath: string;
  readonly content: FileContent;
}

export interface DocumentState {
  readonly project: OpenedProject | null;
  readonly openFailed: boolean;
  readonly doc: OpenDocument | null;
  readonly docError: {
    readonly relPath: string;
    readonly code: ReadFileError | 'invalid-request' | 'forbidden-sender';
  } | null;
  /** Incremented on every edit of the open document. */
  readonly revision: number;
  /** The revision on disk; `revision === savedRevision` means nothing is unsaved. */
  readonly savedRevision: number;
  readonly savingRevision: number | null;
  readonly saveError: { readonly code: string; readonly message: string } | null;
}

export type DocumentAction =
  | { type: 'projectOpened'; project: OpenedProject }
  | { type: 'projectOpenFailed' }
  | { type: 'docLoaded'; relPath: string; content: FileContent }
  | { type: 'docFailed'; relPath: string; code: ReadFileError | 'invalid-request' | 'forbidden-sender' }
  /** S08.3: the open file was moved to the trash (its edits were saved first). */
  | { type: 'docClosed' }
  | { type: 'edited' }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; revision: number }
  | { type: 'saveFailed'; code: WriteFileError | 'invalid-request' | 'forbidden-sender'; message: string };

export const INITIAL_DOCUMENT_STATE: DocumentState = {
  project: null,
  openFailed: false,
  doc: null,
  docError: null,
  revision: 0,
  savedRevision: 0,
  savingRevision: null,
  saveError: null,
};

const freshDocument = { revision: 0, savedRevision: 0, savingRevision: null, saveError: null } as const;

export function documentReducer(state: DocumentState, action: DocumentAction): DocumentState {
  switch (action.type) {
    case 'projectOpened':
      return { ...INITIAL_DOCUMENT_STATE, project: action.project };
    case 'projectOpenFailed':
      return { ...state, openFailed: true };
    case 'docLoaded':
      return { ...state, ...freshDocument, doc: { relPath: action.relPath, content: action.content }, docError: null };
    case 'docFailed':
      return { ...state, ...freshDocument, doc: null, docError: { relPath: action.relPath, code: action.code } };
    case 'docClosed':
      return { ...state, ...freshDocument, doc: null, docError: null };
    case 'edited':
      return state.doc ? { ...state, revision: state.revision + 1 } : state;
    case 'saveStarted':
      return { ...state, savingRevision: state.revision };
    case 'saveSucceeded':
      return { ...state, savingRevision: null, savedRevision: action.revision, saveError: null };
    case 'saveFailed':
      return { ...state, savingRevision: null, saveError: { code: action.code, message: action.message } };
  }
}

export function hasUnsavedChanges(state: DocumentState): boolean {
  return state.doc !== null && state.revision !== state.savedRevision;
}

/** What the top bar shows. `null` when no file is open. */
export function saveState(state: DocumentState): SaveState | null {
  if (!state.doc) return null;
  if (state.savingRevision !== null) return 'saving';
  if (state.saveError && hasUnsavedChanges(state)) return 'failed';
  return hasUnsavedChanges(state) ? 'dirty' : 'clean';
}
