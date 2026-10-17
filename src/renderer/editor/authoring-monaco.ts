/**
 * HTML/CSS authoring aids in Monaco (S53): linked tag editing and "Wrap with tag" (S53.2). The rules are pure
 * modules (tag-match.ts); this registers them with Monaco. Used by the workbench editor and the capability probe, so
 * the cases test exactly what the user gets.
 */
import { monaco } from './monaco-setup';
import { linkedTagRanges, wrapSnippet } from './tag-match';
import { DEFAULT_LOCALE, isLocale, translate, type MessageKey } from '../i18n/index';

export const WRAP_WITH_TAG_ACTION_ID = 'noobide.wrapWithTag';

const t = (key: MessageKey) => {
  const lang = document.documentElement.lang;
  return translate(isLocale(lang) ? lang : DEFAULT_LOCALE, key);
};

// Monaco's HTML service brings no linked editing: NoobIDE's own pairs (registered once for every HTML model).
monaco.languages.registerLinkedEditingRangeProvider('html', {
  provideLinkedEditingRanges(model, position) {
    const pair = linkedTagRanges(model.getValue(), model.getOffsetAt(position));
    if (!pair) return null;
    return {
      ranges: pair.map((tag) => {
        const start = model.getPositionAt(tag.start);
        const end = model.getPositionAt(tag.end);
        return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      }),
      wordPattern: /[A-Za-z][\w:.-]*/,
    };
  },
});

interface SnippetController {
  insert(template: string): void;
}

/** Wraps the selection (or the current line's text) in `<div>…</div>` with both tag names selected and linked. */
export function wrapWithTag(editor: monaco.editor.ICodeEditor): boolean {
  const model = editor.getModel();
  let selection = editor.getSelection();
  const snippets = editor.getContribution<monaco.editor.IEditorContribution & SnippetController>('snippetController2');
  if (!model || !selection || !snippets || model.getLanguageId() !== 'html') return false;
  if (selection.isEmpty()) {
    // Nothing selected: the line's text without its indentation.
    const line = selection.positionLineNumber;
    const first = model.getLineFirstNonWhitespaceColumn(line);
    const last = model.getLineLastNonWhitespaceColumn(line);
    if (first === 0) return false; // an empty line
    selection = new monaco.Selection(line, first, line, last);
    editor.setSelection(selection);
  }
  editor.focus();
  snippets.insert(wrapSnippet(model.getValueInRange(selection)));
  return true;
}

export function attachAuthoring(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  return editor.addAction({
    id: WRAP_WITH_TAG_ACTION_ID,
    label: t('command.wrapWithTag'),
    precondition: "editorLangId == 'html' && !editorReadonly",
    run: () => void wrapWithTag(editor),
  });
}
