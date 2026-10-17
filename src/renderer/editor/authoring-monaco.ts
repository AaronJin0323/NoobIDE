/**
 * HTML/CSS authoring aids in Monaco (S53): linked tag editing and "Wrap with tag" (S53.2). The rules are pure
 * modules (tag-match.ts); this registers them with Monaco. Used by the workbench editor and the capability probe, so
 * the cases test exactly what the user gets.
 */
import { monaco } from './monaco-setup';
import { linkedTagRanges, wrapSnippet } from './tag-match';
import { colorAt, formatColor, type Rgba } from './css-colors';
import { publishCursorColor } from './cursor-color';
import { htmlRegionAt } from './completion-context';
import { toggleBlockComment, toggleLineComments, type EmbeddedKind } from './embedded-comment';
import { DEFAULT_LOCALE, isLocale, translate, type MessageKey } from '../i18n/index';

export const WRAP_WITH_TAG_ACTION_ID = 'noobide.wrapWithTag';
export const LINE_COMMENT_ACTION_ID = 'noobide.toggleLineComment';
export const BLOCK_COMMENT_ACTION_ID = 'noobide.toggleBlockComment';

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

/** S53.4: the `<script>` / `<style>` region the whole selection is in (an HTML page), or null. */
function embeddedRegion(model: monaco.editor.ITextModel, selection: monaco.Selection): EmbeddedKind | null {
  if (model.getLanguageId() !== 'html') return null;
  const text = model.getValue();
  const at = (line: number, column: number) => htmlRegionAt(text, model.getOffsetAt({ lineNumber: line, column }));
  const startColumn = Math.max(1, model.getLineFirstNonWhitespaceColumn(selection.startLineNumber));
  const start = at(selection.startLineNumber, startColumn);
  const end = at(selection.endLineNumber, selection.endColumn);
  return start === end && start !== 'markup' ? start : null;
}

/**
 * S53.4: toggles comments with the syntax of where the cursor is — `//` and `/* *\/` inside an HTML page's
 * `<script>` and `<style>` (Monaco would write `<!-- -->` there), Monaco's own toggle everywhere else. One undo step.
 */
export async function toggleComment(editor: monaco.editor.ICodeEditor, block: boolean): Promise<void> {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
  const region = embeddedRegion(model, selection);
  if (!region) {
    await editor.getAction(block ? 'editor.action.blockComment' : 'editor.action.commentLine')?.run();
    return;
  }
  let range: monaco.Range;
  let text: string;
  if (block && !selection.isEmpty()) {
    range = selection;
    text = toggleBlockComment(model.getValueInRange(selection));
  } else {
    // A selection that ends at the start of a line does not include that line.
    const endLine =
      selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
        ? selection.endLineNumber - 1
        : selection.endLineNumber;
    range = new monaco.Range(selection.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
    const lines = model.getValueInRange(range).split(/\r?\n/);
    text = toggleLineComments(lines, region).join(model.getEOL());
  }
  editor.pushUndoStop();
  editor.executeEdits('noobide.comment', [{ range, text }]);
  editor.pushUndoStop();
}

/** S53.3: the CSS colour value at the cursor (CSS files; Monaco's swatches are shown for the same files). */
function colorAtCursor(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position || model.getLanguageId() !== 'css') return null;
  return colorAt(model.getValue(), model.getOffsetAt(position));
}

/**
 * S53.3: replaces the colour value at the cursor with `rgba`, written in the value's own format (a name becomes hex).
 * One undoable edit. False when the cursor is not on a colour value or the file is read-only.
 */
export function replaceColorAtCursor(editor: monaco.editor.ICodeEditor, rgba: Rgba): boolean {
  const model = editor.getModel();
  const found = colorAtCursor(editor);
  if (!model || !found || editor.getOption(monaco.editor.EditorOption.readOnly)) return false;
  const start = model.getPositionAt(found.start);
  const end = model.getPositionAt(found.end);
  const text = formatColor(rgba, found.format);
  editor.pushUndoStop();
  editor.executeEdits('noobide.color', [
    { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text },
  ]);
  editor.pushUndoStop();
  editor.setPosition(model.getPositionAt(found.start + text.length));
  return true;
}

/**
 * `publishColor`: this is the workbench editor, whose colour at the cursor the status bar shows (the capability
 * probe's off-screen editor is not).
 */
export function attachAuthoring(
  editor: monaco.editor.IStandaloneCodeEditor,
  { publishColor = true }: { readonly publishColor?: boolean } = {},
): monaco.IDisposable {
  const publish = () => {
    if (!publishColor) return;
    const found = colorAtCursor(editor);
    publishCursorColor(found ? { text: found.text, format: found.format, rgba: found.rgba } : null);
  };
  const disposables = [
    editor.addAction({
      id: WRAP_WITH_TAG_ACTION_ID,
      label: t('command.wrapWithTag'),
      precondition: "editorLangId == 'html' && !editorReadonly",
      run: () => void wrapWithTag(editor),
    }),
    // S53.4: the editor's own Ctrl/Cmd+/ and Shift+Alt+A go through the same toggle as the menu and palette.
    editor.addAction({
      id: LINE_COMMENT_ACTION_ID,
      label: t('command.toggleLineComment'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
      precondition: '!editorReadonly',
      run: () => toggleComment(editor, false),
    }),
    editor.addAction({
      id: BLOCK_COMMENT_ACTION_ID,
      label: t('command.toggleBlockComment'),
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyA],
      precondition: '!editorReadonly',
      run: () => toggleComment(editor, true),
    }),
    editor.onDidChangeCursorPosition(publish),
    editor.onDidChangeModelContent(publish),
    editor.onDidChangeModel(publish),
  ];
  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
