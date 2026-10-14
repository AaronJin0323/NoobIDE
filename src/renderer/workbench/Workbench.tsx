import { useReducer } from 'react';
import { useMediaQuery } from '../theme/useMediaQuery';
import { TopBar } from './TopBar';
import { Rail } from './Rail';
import { FilesPanel } from './FilesPanel';
import { EditorPane } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import { ProblemsPanel } from './ProblemsPanel';
import { INITIAL_LAYOUT, NARROW_QUERY, layoutReducer, visibleRegions } from './layout';

/**
 * The five workbench regions of PLAN §3 in the 2026-10-14 prototype layout (S30.3): top bar, labelled rail, files,
 * editor and preview panels, and a status strip that expands into Problems. Below 960px the editor and preview
 * share one column behind a Code / Preview switch (S30.4). Contents are still placeholders: files (S08),
 * tabs/models (S09), preview view (S04/S14), problems and console (S16/S17). Splitters: S15.
 */
export function Workbench() {
  const [layout, dispatch] = useReducer(layoutReducer, INITIAL_LAYOUT);
  const narrow = useMediaQuery(NARROW_QUERY);
  const visible = visibleRegions(layout, narrow);

  return (
    <div className={narrow ? 'workbench narrow' : 'workbench'}>
      <TopBar
        narrow={
          visible.narrowSwitch
            ? { view: layout.narrowView, onShow: (view) => dispatch({ type: 'showNarrowView', view }) }
            : undefined
        }
      />
      <div className="workbench-middle">
        <Rail
          filesVisible={visible.files}
          problemsOpen={visible.problemsPanel}
          onToggleFiles={() => dispatch({ type: 'toggleFiles', narrow })}
          onToggleProblems={() => dispatch({ type: 'toggleProblems' })}
        />
        <FilesPanel hidden={!visible.files} />
        <EditorPane hidden={!visible.editor} />
        <PreviewPane hidden={!visible.preview} />
      </div>
      <ProblemsPanel open={visible.problemsPanel} onToggle={() => dispatch({ type: 'toggleProblems' })} />
    </div>
  );
}
