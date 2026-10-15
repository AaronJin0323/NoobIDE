/**
 * S32.1 ghost-text completions in Monaco. One InlineCompletionsProvider for HTML, CSS and JavaScript asks the inline
 * model (through `window.noobide.ai`, decision 0025) for a suggestion at the cursor; Monaco shows it as grey text.
 * Accepting is Monaco's own: Tab accepts, Esc dismisses, Ctrl+→ (⌘→ on macOS) accepts the next word; an accepted
 * suggestion is one undo step (Monaco pushes undo stops around it).
 *
 * The rules (what is sent, when nothing is sent, debounce, cancel, clean-up of the answer) are pure modules:
 * inline-context.ts, inline-requester.ts, inline-postprocess.ts. This file only connects them to Monaco.
 */
import { monaco } from '../editor/monaco-setup';
import {
  INLINE_LANGUAGES,
  INLINE_MAX_PREFIX_CHARS,
  INLINE_MAX_SUFFIX_CHARS,
  boundedContext,
  editorBlockReason,
  statusBlockReason,
  type InlineBlockReason,
  type InlineTarget,
} from './inline-context';
import { fitToLine, postProcessSuggestion } from './inline-postprocess';
import { InlineRequester } from './inline-requester';
import { aiBridge, aiStatusCache } from './inline-status';

interface Attached {
  readonly editor: monaco.editor.ICodeEditor;
  readonly target: () => InlineTarget | null;
}

const attached = new Set<Attached>();
const requester = new InlineRequester(aiBridge, { onStatusError: () => aiStatusCache.invalidate() });
const counters = { shown: 0, blocked: {} as Partial<Record<InlineBlockReason, number>> };

/** The document version and cursor offset a request belongs to; any other value makes it stale. */
function keyOf(model: monaco.editor.ITextModel, position: monaco.IPosition): string {
  return `${model.id}:${model.getVersionId()}:${model.getOffsetAt(position)}`;
}

function blocked(reason: InlineBlockReason): monaco.languages.InlineCompletions {
  counters.blocked[reason] = (counters.blocked[reason] ?? 0) + 1;
  return { items: [] };
}

/**
 * Prefix and suffix around `position`, read from a window around the cursor (never the whole file). The window is
 * twice the limits plus one character, so that even with CRLF line breaks (read back as LF) it is longer than the
 * limit whenever the file goes on: boundedContext then knows the cut falls inside the text and starts at a line.
 */
function contextAt(model: monaco.editor.ITextModel, position: monaco.Position): { prefix: string; suffix: string } {
  const offset = model.getOffsetAt(position);
  const from = model.getPositionAt(Math.max(0, offset - 2 * INLINE_MAX_PREFIX_CHARS - 2));
  const to = model.getPositionAt(offset + 2 * INLINE_MAX_SUFFIX_CHARS + 2);
  const LF = monaco.editor.EndOfLinePreference.LF;
  const before = model.getValueInRange(monaco.Range.fromPositions(from, position), LF);
  const after = model.getValueInRange(monaco.Range.fromPositions(position, to), LF);
  return boundedContext(before + after, before.length);
}

const provider: monaco.languages.InlineCompletionsProvider = {
  displayName: 'NoobIDE AI',
  // Debouncing is ours (inline-requester.ts), so it can be tested; Monaco should not add its own wait.
  debounceDelayMs: 0,
  async provideInlineCompletions(model, position, _context, token) {
    const entry = [...attached].find((candidate) => candidate.editor.getModel() === model);
    if (!entry) return { items: [] };
    const selections = entry.editor.getSelections() ?? [];
    const line = model.getLineContent(position.lineNumber);
    const target = entry.target();
    const editorBlock = editorBlockReason({
      target,
      languageId: model.getLanguageId(),
      fileLength: model.getValueLength(),
      cursorCount: selections.length,
      hasSelection: selections.some((selection) => !selection.isEmpty()),
      charAfterCursor: line.charAt(position.column - 1),
    });
    if (editorBlock || !target) return blocked(editorBlock ?? 'no-project');
    const status = await aiStatusCache.get(target.projectId);
    if (token.isCancellationRequested) return { items: [] };
    const statusBlock = statusBlockReason(status);
    if (statusBlock) return blocked(statusBlock);

    const { prefix, suffix } = contextAt(model, position);
    const key = keyOf(model, position);
    const raw = await requester.complete(
      {
        kind: 'inline',
        projectId: target.projectId,
        relPath: target.relPath,
        languageId: model.getLanguageId(),
        prefix,
        suffix,
      },
      key,
      token,
    );
    if (raw === null || token.isCancellationRequested || model.isDisposed()) return { items: [] };
    const now = entry.editor.getPosition();
    if (entry.editor.getModel() !== model || !now || keyOf(model, now) !== key) return { items: [] };
    const cleaned = postProcessSuggestion(raw, { prefix, suffix });
    const text = cleaned === null ? null : fitToLine(cleaned, line.slice(position.column - 1));
    if (text === null) return { items: [] };
    counters.shown += 1;
    return {
      items: [
        {
          insertText: text.replace(/\n/g, model.getEOL()),
          range: monaco.Range.fromPositions(position, position),
        },
      ],
    };
  },
  disposeInlineCompletions() {
    // Nothing is held per list.
  },
};

let registered = false;

function ensureProvider(): void {
  if (registered) return;
  registered = true;
  for (const language of INLINE_LANGUAGES) monaco.languages.registerInlineCompletionsProvider(language, provider);
}

/**
 * Lets `editor` show AI suggestions for the file `target()` describes (null: none, e.g. the welcome sample). Typing,
 * moving the cursor or switching files cancels a pending or running request.
 */
export function attachInlineAi(
  editor: monaco.editor.ICodeEditor,
  target: () => InlineTarget | null,
): monaco.IDisposable {
  ensureProvider();
  const entry: Attached = { editor, target };
  attached.add(entry);
  const stillCurrent = () => {
    const model = editor.getModel();
    const position = editor.getPosition();
    if (model && position) requester.cancelUnless(keyOf(model, position));
    else requester.cancelAll();
  };
  const subscriptions = [
    editor.onDidChangeModelContent(stillCurrent),
    editor.onDidChangeCursorPosition(stillCurrent),
    editor.onDidChangeModel(() => requester.cancelAll()),
  ];
  return {
    dispose: () => {
      attached.delete(entry);
      requester.cancelAll();
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}

/** Read-only counters for the e2e suite (like __noobideEditorTestHooks): numbers and error codes, never text. */
const inlineTestHooks = {
  stats: () => ({ ...requester.stats, shown: counters.shown, blocked: { ...counters.blocked } }),
  /** The opaque id of the project whose file is on screen (for granting consent in the e2e test). */
  projectId: () => [...attached].map((entry) => entry.target()?.projectId).find((id) => id !== undefined) ?? null,
};
Object.defineProperty(window, '__noobideInlineAiTestHooks', { value: inlineTestHooks });
