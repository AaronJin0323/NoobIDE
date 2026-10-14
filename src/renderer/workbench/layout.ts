/**
 * Which workbench regions are shown (S30.3, S30.4). Pure so the rules are unit-tested; Workbench.tsx owns the state.
 * Wide and narrow windows remember the files panel separately: collapsing it on a laptop does not decide whether it
 * pops over the code in a narrow window, and the narrow default is closed so code gets the space.
 */
export type NarrowView = 'code' | 'preview';

export interface LayoutState {
  filesOpenWide: boolean;
  filesOpenNarrow: boolean;
  problemsOpen: boolean;
  narrowView: NarrowView;
}

export type LayoutAction =
  { type: 'toggleFiles'; narrow: boolean } | { type: 'toggleProblems' } | { type: 'showNarrowView'; view: NarrowView };

/** Problems starts collapsed into the status strip (assessment finding 2: empty regions must not dominate). */
export const INITIAL_LAYOUT: LayoutState = {
  filesOpenWide: true,
  filesOpenNarrow: false,
  problemsOpen: false,
  narrowView: 'code',
};

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
