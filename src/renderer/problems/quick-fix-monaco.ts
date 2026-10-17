/**
 * S55.3: the editor lightbulb for the beginner checks' quick fixes. For a `noobide-beginner` marker under the cursor
 * the same rules as the problem card decide the fix (explain → fixActionOf), so a fix is offered here exactly when the
 * card offers it, with the same label naming the exact change. Choosing it (mouse, or Ctrl/Cmd+. then Enter) runs the
 * workbench's problem fix (quick-fix-handler.ts): one ordinary editor edit, saved through the file's save pipeline,
 * re-checked, with the result announced as text on the fix card. Nothing is applied by the provider itself.
 *
 * Loaded by useProjectIndex when a project opens, through monaco-setup (see beginner-checks-monaco.ts).
 */
import { monaco } from '../editor/monaco-setup';
import { isBeginnerCode } from '../../diagnostics/beginner-checks';
import { formatMessage, type DiagnosticsLocale } from '../../diagnostics/messages';
import { explain } from '../../diagnostics/rules';
import type { ProblemRecord } from '../../shared/problem';
import { BEGINNER_CHECK_OWNER, projectFacts } from './beginner-checks-monaco';
import { fixActionOf, type FixAction } from './fix-model';
import { getQuickFixHandler } from './quick-fix-handler';
import { markerToProblem } from './static-problems';

export { setBeginnerProject } from './beginner-checks-monaco';

export const APPLY_QUICK_FIX_COMMAND = 'noobide.applyQuickFix';

const locale = (): DiagnosticsLocale => (document.documentElement.lang === 'en' ? 'en' : 'zh-CN');

/** The quick fixes for the beginner markers of `model` that overlap `markers` (the lightbulb's context). */
export function quickFixesFor(
  model: monaco.editor.ITextModel,
  markers: readonly monaco.editor.IMarkerData[],
): { record: ProblemRecord; fix: FixAction; marker: monaco.editor.IMarkerData }[] {
  const facts = projectFacts(model);
  if (!facts?.relPath) return [];
  const out: { record: ProblemRecord; fix: FixAction; marker: monaco.editor.IMarkerData }[] = [];
  for (const marker of markers) {
    const code = typeof marker.code === 'string' ? marker.code : marker.code?.value;
    if (!code || !isBeginnerCode(code)) continue;
    const record = markerToProblem(
      { ...marker, owner: BEGINNER_CHECK_OWNER, code },
      { projectId: facts.projectId, relPath: facts.relPath, at: Date.now() },
    );
    if (!record || marker.startLineNumber > model.getLineCount()) continue;
    const explanation = explain(record, {
      lineText: model.getLineContent(marker.startLineNumber),
      ...(facts.projectFiles ? { projectFiles: facts.projectFiles } : {}),
      ...(facts.htmlIds ? { htmlIds: facts.htmlIds } : {}),
      ...(facts.htmlClasses ? { htmlClasses: facts.htmlClasses } : {}),
    });
    const fix = fixActionOf(explanation);
    if (fix) out.push({ record, fix, marker });
  }
  return out;
}

monaco.editor.registerCommand(APPLY_QUICK_FIX_COMMAND, (_accessor, record: ProblemRecord, fix: FixAction) => {
  getQuickFixHandler()?.(record, fix, 'lightbulb');
});

monaco.languages.registerCodeActionProvider(
  ['html', 'css', 'javascript'],
  {
    provideCodeActions(model, _range, context) {
      if (!getQuickFixHandler()) return { actions: [], dispose: () => undefined };
      const actions = quickFixesFor(model, context.markers).map(({ record, fix, marker }) => {
        const title = formatMessage(locale(), fix.label);
        return {
          title,
          kind: 'quickfix',
          diagnostics: [marker],
          isPreferred: true,
          command: { id: APPLY_QUICK_FIX_COMMAND, title, arguments: [record, fix] },
        };
      });
      return { actions, dispose: () => undefined };
    },
  },
  { providedCodeActionKinds: ['quickfix'] },
);
