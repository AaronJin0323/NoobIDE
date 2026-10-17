/**
 * Emmet on Tab in Monaco (S53.1, decision 0039). The rules are in emmet-expand.ts; this binds Tab, inserts the
 * expansion as a snippet (tab stops, one undo step) and raises the one-time hint that names the off switch.
 *
 * Tab is bound only where nothing else owns it: no suggestion list, no AI suggestion, no snippet in progress, no
 * selection (Tab indents a selection). Where no abbreviation applies, the normal Tab runs, so indentation is unchanged.
 */
import { monaco } from './monaco-setup';
import { emmetExpansionAt, type EmmetSyntax } from './emmet-expand';
import { editorPrefs, setEditorPrefs } from './editor-prefs';
import { DEFAULT_LOCALE, isLocale, translate } from '../i18n/index';
import { showEmmetHint } from './emmet-hint';

const uiLocale = () => (isLocale(document.documentElement.lang) ? document.documentElement.lang : DEFAULT_LOCALE);

export const EMMET_ACTION_ID = 'noobide.emmetExpandOrTab';

const PRECONDITION =
  'editorTextFocus && !editorReadonly && !editorHasSelection && !editorHasMultipleSelections && ' +
  '!suggestWidgetVisible && !inSnippetMode && !inlineSuggestionVisible && !editorTabMovesFocus';

function syntaxOf(model: monaco.editor.ITextModel): EmmetSyntax | null {
  const language = model.getLanguageId();
  return language === 'html' || language === 'css' ? language : null;
}

interface SnippetController {
  insert(template: string): void;
}

/**
 * Expands the abbreviation before the cursor, or runs the normal Tab. Returns whether it expanded. Used by the Tab
 * binding and by the capability probe, so the cases test exactly what Tab does.
 */
export function expandOrTab(
  editor: monaco.editor.ICodeEditor,
  options: { readonly enabled?: boolean; readonly onExpanded?: () => void } = {},
): boolean {
  const model = editor.getModel();
  const selection = editor.getSelection();
  const syntax = model ? syntaxOf(model) : null;
  const enabled = options.enabled ?? editorPrefs().emmet;
  if (model && selection && syntax && enabled && selection.isEmpty()) {
    const offset = model.getOffsetAt(selection.getPosition());
    const lang = document.documentElement.lang || 'en';
    const expansion = emmetExpansionAt(model.getValue(), offset, syntax, { lang });
    const snippets = editor.getContribution<monaco.editor.IEditorContribution & SnippetController>(
      'snippetController2',
    );
    if (expansion && snippets) {
      const start = model.getPositionAt(expansion.start);
      editor.setSelection(
        new monaco.Selection(start.lineNumber, start.column, selection.positionLineNumber, selection.positionColumn),
      );
      snippets.insert(expansion.snippet);
      options.onExpanded?.();
      return true;
    }
  }
  editor.trigger('keyboard', 'tab', null);
  return false;
}

/** The first expansion ever (persisted): the status bar says what happened and where to turn it off. */
function firstExpansion(): void {
  if (editorPrefs().emmetHintShown) return;
  setEditorPrefs({ emmetHintShown: true });
  showEmmetHint();
}

export function attachEmmet(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  return editor.addAction({
    id: EMMET_ACTION_ID,
    label: translate(uiLocale(), 'emmet.action'),
    keybindings: [monaco.KeyCode.Tab],
    precondition: PRECONDITION,
    run: () => void expandOrTab(editor, { onExpanded: firstExpansion }),
  });
}
