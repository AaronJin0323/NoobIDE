import { monaco } from '../editor/monaco-setup';
import { checkBeginner, type BeginnerFacts } from '../../diagnostics/beginner-checks';
import type { ProblemRecord } from '../../shared/problem';
import type { ProjectIndex } from '../editor/project-index';
import { sameBeginnerFinding } from './fix-model';

/**
 * S55.2: runs NoobIDE's beginner checks (src/diagnostics/beginner-checks.ts, rules 16–20 and 23–25) on the HTML, CSS
 * and JavaScript models of the open project and shows the findings as warning markers (owner `noobide-beginner`), so
 * they appear as squiggles, flow into Problems like the language services' markers, and get quick fixes in the
 * lightbulb (quick-fix-monaco.ts). Re-checked after a short pause in typing, and when the project's files change (a
 * created file can fix a broken path). Models outside the open project (the welcome sample, the capability probe)
 * are not checked: references and ids only mean something inside a project.
 *
 * Loaded by useProjectIndex when a project opens (like smart-monaco.ts), through monaco-setup: importing Monaco's core
 * on its own, ahead of monaco-setup, starts editors without their registered services.
 */
export const BEGINNER_CHECK_OWNER = 'noobide-beginner';
const DELAY_MS = 500;
const LANGUAGES = new Set(['html', 'css', 'javascript']);

/** Windows drive letters arrive in either case (as in smart-monaco.ts); everything else is compared as is. */
const normalPath = (path: string) => path.replace(/^\/([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}:`);

interface Project {
  readonly projectId: string;
  readonly index: ProjectIndex;
  /** Monaco URI path of the root, with a trailing slash. */
  readonly root: string;
  readonly unsubscribe: () => void;
}
let project: Project | null = null;

/** The open project's id and project-relative path of a model, or null for models outside it. */
export function projectPathOf(model: monaco.editor.ITextModel): { projectId: string; relPath: string } | null {
  const path = normalPath(model.uri.path);
  if (!project || model.uri.scheme !== 'file' || !path.startsWith(project.root)) return null;
  return { projectId: project.projectId, relPath: path.slice(project.root.length) };
}

/** What the checks and the quick fixes may know about the open project. */
export function projectFacts(model: monaco.editor.ITextModel): (BeginnerFacts & { projectId: string }) | null {
  const where = projectPathOf(model);
  if (!where || !project) return null;
  const symbols = project.index.symbols();
  return {
    projectId: where.projectId,
    relPath: where.relPath,
    projectFiles: project.index.files(),
    htmlIds: [...symbols.ids.keys()],
    htmlClasses: [...symbols.classes.keys()],
  };
}

export function checkModel(model: monaco.editor.ITextModel): void {
  if (model.isDisposed()) return;
  const facts = LANGUAGES.has(model.getLanguageId()) ? projectFacts(model) : null;
  const markers = facts
    ? checkBeginner(model.getLanguageId(), model.getValue(), facts).map((f) => ({
        severity: monaco.MarkerSeverity.Warning,
        code: f.code,
        message: f.message,
        startLineNumber: f.line,
        startColumn: f.column,
        endLineNumber: f.line,
        endColumn: f.endColumn,
      }))
    : [];
  monaco.editor.setModelMarkers(model, BEGINNER_CHECK_OWNER, markers);
}

/**
 * S55.3 re-check of a quick fix: the beginner checks run on the open file's current text right now (not the markers,
 * which wait for a pause in typing). True while they still report the same finding (same code, line and facts);
 * null when the file is not open or outside the project. `extraFiles` count as existing (a file just created).
 */
export function stillReportsBeginner(
  uri: string,
  record: ProblemRecord,
  extraFiles: readonly string[] = [],
): Promise<boolean | null> {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  const facts = model && !model.isDisposed() ? projectFacts(model) : null;
  if (!model || !facts) return Promise.resolve(null);
  const files = [...(facts.projectFiles ?? []), ...extraFiles];
  const findings = checkBeginner(model.getLanguageId(), model.getValue(), { ...facts, projectFiles: files });
  return Promise.resolve(findings.some((f) => sameBeginnerFinding(record, f)));
}

/** S55.3: the same finding at the same column, in the file's current text (see FixEditor.reportsNow). */
export function reportsNow(uri: string, record: ProblemRecord): boolean | null {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  const facts = model && !model.isDisposed() ? projectFacts(model) : null;
  if (!model || !facts) return null;
  return checkBeginner(model.getLanguageId(), model.getValue(), facts).some(
    (f) => f.column === record.column && sameBeginnerFinding(record, f),
  );
}

const checkAll = () => {
  for (const model of monaco.editor.getModels()) checkModel(model);
};

/** The open project (from useProjectIndex), or null when it closes. Every open model is checked again. */
export function setBeginnerProject(next: { projectId: string; index: ProjectIndex; rootPath: string } | null): void {
  project?.unsubscribe();
  project = null;
  if (next) {
    const root = normalPath(monaco.Uri.file(next.rootPath).path);
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Files or ids changed (watcher, a created file): re-check after a pause, once per burst.
    const unsubscribe = next.index.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        checkAll();
      }, DELAY_MS);
    });
    project = {
      projectId: next.projectId,
      index: next.index,
      root: root.endsWith('/') ? root : `${root}/`,
      unsubscribe: () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      },
    };
  }
  checkAll();
}

function watch(model: monaco.editor.ITextModel): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changes = model.onDidChangeContent(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      checkModel(model);
    }, DELAY_MS);
  });
  const language = model.onDidChangeLanguage(() => checkModel(model));
  model.onWillDispose(() => {
    if (timer) clearTimeout(timer);
    changes.dispose();
    language.dispose();
    monaco.editor.setModelMarkers(model, BEGINNER_CHECK_OWNER, []);
  });
  checkModel(model);
}

for (const model of monaco.editor.getModels()) watch(model);
monaco.editor.onDidCreateModel(watch);
