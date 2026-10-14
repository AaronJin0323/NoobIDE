import { TopBar } from './TopBar';
import { FilesPanel } from './FilesPanel';
import { EditorPane } from './EditorPane';
import { PreviewPane } from './PreviewPane';
import { ProblemsPanel } from './ProblemsPanel';

/**
 * The five workbench regions of PLAN §3 (S02.3). Placeholders for now: files (S08), tabs/models (S09),
 * preview view (S04/S14), problems and console (S16/S17). Splitters and the narrow Code/Preview switch: S15.
 */
export function Workbench() {
  return (
    <div className="workbench">
      <TopBar />
      <div className="workbench-middle">
        <FilesPanel />
        <EditorPane />
        <PreviewPane />
      </div>
      <ProblemsPanel />
    </div>
  );
}
