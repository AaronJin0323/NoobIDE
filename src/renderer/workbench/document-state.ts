import type { FileContent, OpenedProject, ReadFileError } from '../../shared/ipc/contract';
import { INITIAL_SAVE, saveStatus, type SaveSnapshot, type SaveStatus } from './save-machine';

/**
 * Project, open tabs and their save state (S03.3, S09.2, S10.2). Pure reducer. Each tab's save snapshot is produced
 * by its DocumentSaver (save-controller.ts) and only stored here, so the save rules live in one tested place.
 */
export interface OpenTab {
  readonly relPath: string;
  /** Stable `file://` URI: the editor model key (S09.1). */
  readonly uri: string;
  /** The file as it was read from disk; the live text is in the editor model and the tab's saver. */
  readonly content: FileContent;
  readonly save: SaveSnapshot;
  // ── S11: external changes ──
  /** A clean buffer was reloaded because the file changed outside NoobIDE (S11.1); shown until dismissed or edited. */
  readonly diskNotice?: 'reloaded';
  /** The disk version that conflicts with unsaved edits (S11.2), for the comparison. */
  readonly conflictDisk?: FileContent;
}

export type OpenErrorCode = ReadFileError | 'invalid-request' | 'forbidden-sender';

export interface DocumentState {
  readonly project: OpenedProject | null;
  readonly openFailed: boolean;
  readonly tabs: readonly OpenTab[];
  /** relPath of the visible tab. */
  readonly active: string | null;
  /** A file that could not be opened; shown until another file opens or a tab is chosen. */
  readonly docError: { readonly relPath: string; readonly code: OpenErrorCode } | null;
}

export type DocumentAction =
  | { type: 'projectOpened'; project: OpenedProject }
  | { type: 'projectOpenFailed' }
  /** S13.3: the project was closed; the welcome screen shows again. */
  | { type: 'projectClosed' }
  | { type: 'docLoaded'; relPath: string; content: FileContent }
  | { type: 'docFailed'; relPath: string; code: OpenErrorCode }
  | { type: 'activate'; relPath: string }
  | { type: 'closed'; relPath: string }
  | { type: 'saveState'; relPath: string; save: SaveSnapshot }
  // --- S11: external changes ---
  /** The buffer now holds this disk version (clean reload, or "use the disk version"). */
  | { type: 'diskReloaded'; relPath: string; content: FileContent; notice: boolean }
  | { type: 'diskConflict'; relPath: string; content: FileContent }
  | { type: 'conflictCleared'; relPath: string }
  | { type: 'diskNoticeDismissed'; relPath: string };

export const INITIAL_DOCUMENT_STATE: DocumentState = {
  project: null,
  openFailed: false,
  tabs: [],
  active: null,
  docError: null,
};

export function documentReducer(state: DocumentState, action: DocumentAction): DocumentState {
  switch (action.type) {
    case 'projectOpened':
      return { ...INITIAL_DOCUMENT_STATE, project: action.project };
    case 'projectClosed':
      return INITIAL_DOCUMENT_STATE;
    case 'projectOpenFailed':
      return { ...state, openFailed: true };
    case 'docLoaded': {
      const known = state.tabs.some((tab) => tab.relPath === action.relPath);
      const tabs = known
        ? state.tabs
        : [
            ...state.tabs,
            { relPath: action.relPath, uri: action.content.uri, content: action.content, save: INITIAL_SAVE },
          ];
      return { ...state, tabs, active: action.relPath, docError: null };
    }
    case 'docFailed':
      return { ...state, docError: { relPath: action.relPath, code: action.code } };
    case 'activate':
      return state.tabs.some((tab) => tab.relPath === action.relPath)
        ? { ...state, active: action.relPath, docError: null }
        : state;
    case 'closed': {
      const index = state.tabs.findIndex((tab) => tab.relPath === action.relPath);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.relPath !== action.relPath);
      // Closing the visible tab shows its right neighbour, else its left one — the usual editor convention.
      const active =
        state.active === action.relPath ? (tabs[Math.min(index, tabs.length - 1)]?.relPath ?? null) : state.active;
      return { ...state, tabs, active };
    }
    case 'saveState':
      return {
        ...state,
        tabs: state.tabs.map((tab) => (tab.relPath === action.relPath ? { ...tab, save: action.save } : tab)),
      };
    // --- S11 ---
    case 'diskReloaded':
      return mapTab(state, action.relPath, (tab) => {
        const { conflictDisk: _gone, diskNotice: _old, ...rest } = tab;
        return action.notice
          ? { ...rest, content: action.content, diskNotice: 'reloaded' }
          : { ...rest, content: action.content };
      });
    case 'diskConflict':
      return mapTab(state, action.relPath, (tab) => {
        const { diskNotice: _old, ...rest } = tab;
        return { ...rest, conflictDisk: action.content };
      });
    case 'conflictCleared':
      return mapTab(state, action.relPath, (tab) => {
        const { conflictDisk: _gone, ...rest } = tab;
        return rest;
      });
    case 'diskNoticeDismissed':
      return mapTab(state, action.relPath, (tab) => {
        if (!tab.diskNotice) return tab;
        const { diskNotice: _old, ...rest } = tab;
        return rest;
      });
  }
}

function mapTab(state: DocumentState, relPath: string, update: (tab: OpenTab) => OpenTab): DocumentState {
  if (!state.tabs.some((tab) => tab.relPath === relPath)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.relPath === relPath ? update(tab) : tab)) };
}

export function activeTab(state: DocumentState): OpenTab | null {
  return state.tabs.find((tab) => tab.relPath === state.active) ?? null;
}

/** What the top bar shows: the status of the visible file, `null` when no file is open. */
export function activeSaveStatus(state: DocumentState): SaveStatus | null {
  const tab = activeTab(state);
  return tab ? saveStatus(tab.save) : null;
}

/** The tab after (`step` 1) or before (`step` -1) the visible one, wrapping around; for Ctrl+Tab switching. */
export function cycleTab(state: DocumentState, step: 1 | -1): string | null {
  if (state.tabs.length === 0) return null;
  const index = state.tabs.findIndex((tab) => tab.relPath === state.active);
  const next = (index + step + state.tabs.length) % state.tabs.length;
  return state.tabs[index < 0 ? 0 : next]?.relPath ?? null;
}
