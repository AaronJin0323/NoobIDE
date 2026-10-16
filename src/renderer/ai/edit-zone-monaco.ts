import { monaco } from '../editor/monaco-setup';
import type { EditZone } from '../editor/editor-handle';
import { editLinesOf, sameRangeText, type LineRange } from './inline-edit-model';

/**
 * S35: the inline edit zone in the code editor. Like Monaco's own zone widgets (peek view), it is
 * - a view zone above the edited lines, which reserves vertical space between the lines, and
 * - an overlay widget placed exactly over that space, which holds the interactive content (instruction box, diff,
 *   Accept / Reject). Overlay widgets get mouse and keyboard input like the find widget does.
 * Keys, mouse and context-menu events inside the widget stop at its outer element, so typing an instruction never
 * reaches the editor's keybindings (Ctrl/Cmd+Z, Ctrl/Cmd+A…) — while the app's own command shortcuts, which listen in
 * the capture phase on window, still work. The content is rendered into `container`, the root of its own React tree.
 *
 * The edited range is tracked by a decoration (it moves when lines are added above it) and `apply` replaces it as one
 * undo step only while it still reads the text that was sent.
 */
let counter = 0;
let open: EditZone | null = null;

const STOP_EVENTS = ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown', 'contextmenu', 'dblclick'] as const;

export function createEditZone(
  editor: monaco.editor.IStandaloneCodeEditor,
  uri: string,
  lines: LineRange | null,
): EditZone | null {
  const model = editor.getModel();
  if (!model) return null;
  open?.dispose();
  counter += 1;
  const id = counter;

  const selected = lines ?? selectedLines(editor);
  const { startLine, endLine, wholeFile } = editLinesOf(model.getLineCount(), selected);
  const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
  const original = model.getValueInRange(range);
  const fullText = model.getValue();
  const eol = model.getEOL() === '\r\n' ? '\r\n' : '\n';

  const tracked = editor.createDecorationsCollection([
    {
      range,
      options: {
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]);
  const marks = editor.createDecorationsCollection();

  const outer = document.createElement('div');
  outer.className = 'inline-edit-widget';
  outer.dataset.testid = 'inline-edit';
  for (const type of STOP_EVENTS) outer.addEventListener(type, (event) => event.stopPropagation());
  const container = document.createElement('div');
  container.className = 'inline-edit-root';
  outer.appendChild(container);

  let top = -1e6;
  const layout = () => {
    const info = editor.getLayoutInfo();
    outer.style.left = `${info.contentLeft}px`;
    outer.style.width = `${Math.max(200, info.contentWidth - info.verticalScrollbarWidth - 8)}px`;
  };
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => `noobide.inline-edit.${id}`,
    getDomNode: () => outer,
    getPosition: () => ({ preference: { top, left: editor.getLayoutInfo().contentLeft } }),
  };
  layout();
  editor.addOverlayWidget(widget);
  editor.revealLineInCenterIfOutsideViewport(startLine);

  const placeholder = document.createElement('div');
  const zone: monaco.editor.IViewZone = {
    afterLineNumber: startLine - 1,
    heightInPx: 120,
    domNode: placeholder,
    onDomNodeTop: (value) => {
      if (value === top) return;
      top = value;
      outer.style.top = `${value}px`;
      editor.layoutOverlayWidget(widget);
    },
  };
  let zoneId: string | null = null;
  editor.changeViewZones((accessor) => {
    zoneId = accessor.addZone(zone);
  });
  // When the proposal arrives (phase "review"), the zone is brought into view again: the user may have scrolled away
  // while the AI was writing, and Accept / Reject must not be off screen.
  let revealedPhase: string | null = null;
  const revealZone = () => {
    const line = tracked.getRange(0)?.startLineNumber ?? startLine;
    const height = zone.heightInPx ?? 0;
    const zoneTop = editor.getTopForLineNumber(line) - height;
    const viewTop = editor.getScrollTop();
    const viewHeight = editor.getLayoutInfo().height;
    const visibleEnd = zoneTop + Math.min(height, viewHeight);
    if (zoneTop >= viewTop && visibleEnd <= viewTop + viewHeight) return;
    editor.setScrollTop(Math.max(0, zoneTop - 8));
  };
  // The zone is as tall as its content (which changes from instruction box to diff to messages).
  const resize = new ResizeObserver(() => {
    const height = Math.ceil(outer.getBoundingClientRect().height) + 4;
    const phase = container.querySelector('[data-phase]')?.getAttribute('data-phase') ?? null;
    const changed = zoneId !== null && Math.abs(height - (zone.heightInPx ?? 0)) >= 1;
    if (changed) {
      zone.heightInPx = height;
      editor.changeViewZones((accessor) => {
        if (zoneId !== null) accessor.layoutZone(zoneId);
      });
    }
    if (phase !== revealedPhase) {
      revealedPhase = phase;
      if (phase === 'review' && !closed) revealZone();
    }
  });
  resize.observe(outer);

  const listeners: (() => void)[] = [];
  let closed = false;
  const subscriptions: monaco.IDisposable[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    if (open === self) open = null;
    resize.disconnect();
    for (const subscription of subscriptions) subscription.dispose();
    editor.changeViewZones((accessor) => {
      if (zoneId !== null) accessor.removeZone(zoneId);
    });
    editor.removeOverlayWidget(widget);
    tracked.clear();
    marks.clear();
    for (const listener of listeners.splice(0)) listener();
  };
  subscriptions.push(
    editor.onDidLayoutChange(layout),
    // Another file on screen, or the model gone: the zone belongs to this file's text.
    editor.onDidChangeModel(close),
    editor.onDidDispose(close),
    model.onWillDispose(close),
  );

  const currentRange = (): monaco.Range | null => {
    if (closed || model.isDisposed() || editor.getModel() !== model) return null;
    return tracked.getRange(0);
  };

  const self: EditZone = {
    uri,
    languageId: model.getLanguageId(),
    startLine,
    endLine,
    wholeFile,
    original,
    fullText,
    eol,
    container,
    currentText() {
      const now = currentRange();
      if (!now) return null;
      // The whole file stays the whole file even when lines were added at its end.
      return wholeFile ? model.getValue() : model.getValueInRange(now);
    },
    modelText() {
      return currentRange() ? model.getValue() : null;
    },
    markProposal(on) {
      const now = currentRange();
      if (!on || !now) {
        marks.clear();
        return;
      }
      marks.set([
        {
          range: now,
          options: {
            isWholeLine: true,
            className: 'inline-edit-replaced-line',
            linesDecorationsClassName: 'inline-edit-replaced-gutter',
          },
        },
      ]);
    },
    apply(text, expected) {
      const now = currentRange();
      if (!now) return { ok: false, reason: 'no-model' };
      const target = wholeFile ? model.getFullModelRange() : now;
      if (!sameRangeText(model.getValueInRange(target), expected)) return { ok: false, reason: 'changed' };
      model.pushStackElement();
      model.pushEditOperations([], [{ range: target, text }], () => null);
      model.pushStackElement();
      return { ok: true, text: model.getValue(), version: model.getAlternativeVersionId() };
    },
    focusEditor() {
      if (!closed) editor.focus();
    },
    onClose(listener) {
      if (closed) listener();
      else listeners.push(listener);
    },
    dispose: close,
  };
  open = self;
  return self;
}

/** The selected whole lines, or null when nothing (or only whitespace) is selected. */
function selectedLines(editor: monaco.editor.IStandaloneCodeEditor): LineRange | null {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection || selection.isEmpty() || !model.getValueInRange(selection).trim()) return null;
  // A selection that ends at the start of a line does not include that line.
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  return { startLine: selection.startLineNumber, endLine };
}
