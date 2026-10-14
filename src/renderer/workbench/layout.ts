/**
 * Which workbench regions are shown (S30.3, S30.4). Pure so the rules are unit-tested; Workbench.tsx owns the state.
 * Wide and narrow windows remember the files panel separately: collapsing it on a laptop does not decide whether it
 * pops over the code in a narrow window, and the narrow default is closed so code gets the space.
 */
import { EDITOR_SHARE, FILES_WIDTH, type SessionLayout } from '../../shared/session';

export type NarrowView = 'code' | 'preview';

export interface LayoutState {
  filesOpenWide: boolean;
  filesOpenNarrow: boolean;
  problemsOpen: boolean;
  narrowView: NarrowView;
  /** S13.4: width of the files panel (wide window), CSS pixels. */
  filesWidth: number;
  /** S13.4: fraction of the editor + preview width the editor gets. */
  editorShare: number;
}

export type LayoutAction =
  | { type: 'toggleFiles'; narrow: boolean }
  | { type: 'toggleProblems' }
  | { type: 'showNarrowView'; view: NarrowView }
  // --- S13.4: layout sizes, restored from the session ---
  | { type: 'resizeFiles'; width: number }
  | { type: 'resizeEditor'; share: number }
  | { type: 'restoreLayout'; layout: SessionLayout };

/** Problems starts collapsed into the status strip (assessment finding 2: empty regions must not dominate). */
export const INITIAL_LAYOUT: LayoutState = {
  filesOpenWide: true,
  filesOpenNarrow: false,
  problemsOpen: false,
  narrowView: 'code',
  filesWidth: FILES_WIDTH.default,
  editorShare: EDITOR_SHARE.default,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** S13.4: the part of the layout that is remembered across starts. */
export function persistedLayout(state: LayoutState): SessionLayout {
  return {
    filesOpen: state.filesOpenWide,
    problemsOpen: state.problemsOpen,
    filesWidth: state.filesWidth,
    editorShare: state.editorShare,
  };
}

/** Below this width the editor and preview share one column with a Code / Preview switch. */
export const NARROW_QUERY = '(max-width: 959px)';

export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case 'toggleFiles':
      return action.narrow
        ? { ...state, filesOpenNarrow: !state.filesOpenNarrow }
        : { ...state, filesOpenWide: !state.filesOpenWide };
    case 'toggleProblems':
      return { ...state, problemsOpen: !state.problemsOpen };
    case 'showNarrowView':
      // Picking a view also closes the narrow file drawer, which would otherwise cover it.
      return { ...state, narrowView: action.view, filesOpenNarrow: false };
    case 'resizeFiles':
      return { ...state, filesWidth: Math.round(clamp(action.width, FILES_WIDTH.min, FILES_WIDTH.max)) };
    case 'resizeEditor':
      return {
        ...state,
        editorShare: Math.round(clamp(action.share, EDITOR_SHARE.min, EDITOR_SHARE.max) * 1000) / 1000,
      };
    case 'restoreLayout':
      return {
        ...state,
        filesOpenWide: action.layout.filesOpen,
        problemsOpen: action.layout.problemsOpen,
        filesWidth: clamp(action.layout.filesWidth, FILES_WIDTH.min, FILES_WIDTH.max),
        editorShare: clamp(action.layout.editorShare, EDITOR_SHARE.min, EDITOR_SHARE.max),
      };
  }
}

export interface Visibility {
  files: boolean;
  editor: boolean;
  preview: boolean;
  problemsPanel: boolean;
  narrowSwitch: boolean;
}

export function visibleRegions(state: LayoutState, narrow: boolean): Visibility {
  return {
    files: narrow ? state.filesOpenNarrow : state.filesOpenWide,
    editor: !narrow || state.narrowView === 'code',
    preview: !narrow || state.narrowView === 'preview',
    problemsPanel: state.problemsOpen,
    narrowSwitch: narrow,
  };
}
