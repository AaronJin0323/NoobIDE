import { monaco, languageDefaults } from './monaco-setup';
import { folderPaths, navigate, renamePlanAt } from './js-navigation-monaco';
import { extensionOf, selectionOf, type CapabilityCase, type CapabilityResult } from './capability-cases';
import { expandOrTab } from './emmet-monaco';
import { attachAuthoring, replaceColorAtCursor } from './authoring-monaco';
import { parseColor } from './css-colors';

/**
 * Runs language capability cases in the real editor (S18.1, S18.2): a real Monaco editor, the bundled language
 * workers, and the same suggest / hover / format commands the user triggers. Used by the packaged-app self-test, so
 * the capabilities NoobIDE claims (docs/capabilities.md) are proven in the shipped binary, offline.
 *
 * The probe editor sits in an off-screen host and is disposed afterwards; its models use a private URI scheme root
 * (`file:///noobide-probe/…`) and are disposed too, so nothing reaches the workbench, the problems list or disk.
 */
const CASE_TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (performance.now() > end) return null;
    await sleep(100);
  }
}

const shorten = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text);

function suggestionLabels(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.suggest-widget .monaco-list-row .label-name')].map((el) =>
    (el.textContent ?? '').trim(),
  );
}

function hoverText(host: HTMLElement): string {
  return [...host.querySelectorAll('.monaco-hover .hover-contents, .monaco-hover .monaco-hover-content')]
    .map((el) => el.textContent ?? '')
    .join(' ')
    .trim();
}

/** S53: runs an edit case's action the way the user's key or command does. False: the action did not run. */
async function runEdit(editor: monaco.editor.IStandaloneCodeEditor, c: CapabilityCase): Promise<boolean> {
  const action = c.action ?? '';
  if (action === 'emmet') {
    expandOrTab(editor, { enabled: true });
    return true;
  }
  const typed = () => {
    if (c.typeText) editor.trigger('keyboard', 'type', { text: c.typeText });
  };
  if (action === 'set-color') {
    // S53.3: what the colour picker's Apply does, with the new colour given as text.
    const color = parseColor(c.typeText ?? '');
    return color !== null && replaceColorAtCursor(editor, color.rgba);
  }
  if (action === 'linked-type') {
    // Linked editing is computed after the cursor moves; type once its ranges are there (or after a while, for the
    // cases that prove it does not apply).
    const model = editor.getModel();
    await poll(
      () =>
        model?.getAllDecorations().some((d) => d.options.className?.includes('linked-editing-decoration'))
          ? true
          : null,
      2_000,
    );
    typed();
    // The mirrored edit lands on the next tick; wait past it so a case that must NOT be linked cannot pass early.
    await sleep(300);
    return true;
  }
  const run = editor.getAction(action);
  if (!run) return false;
  await run.run();
  typed();
  return true;
}

async function runCase(
  editor: monaco.editor.IStandaloneCodeEditor,
  host: HTMLElement,
  c: CapabilityCase,
): Promise<CapabilityResult> {
  const started = performance.now();
  const dir = `file:///noobide-probe/${c.id}/`;
  const extra = Object.entries(c.files ?? {}).map(([name, text]) => {
    const language = name.endsWith('.css') ? 'css' : name.endsWith('.html') ? 'html' : 'javascript';
    return monaco.editor.createModel(text, language, monaco.Uri.parse(dir + name));
  });
  // S57: project files that are not open reach the JavaScript service as extra libs, as in the workbench.
  const libs = Object.entries(c.closedFiles ?? {}).map(([name, text]) =>
    languageDefaults.javascript.addExtraLib(text, monaco.Uri.parse(dir + name).toString()),
  );
  const { text, start: from, end: to } = selectionOf(c.text);
  const model = monaco.editor.createModel(
    text,
    c.language,
    monaco.Uri.parse(dir + (c.fileName ?? `case.${extensionOf(c.language)}`)),
  );
  const result = (pass: boolean, seen?: string): CapabilityResult => ({
    id: c.id,
    pass,
    ...(seen !== undefined ? { seen: shorten(seen) } : {}),
    ms: Math.round(performance.now() - started),
  });
  try {
    // Same indentation as the workbench editor (CodeEditor: tabSize 2, spaces), so format results match the app.
    model.updateOptions({ tabSize: 2, insertSpaces: true });
    editor.setModel(model);
    editor.focus();
    editor.setSelection(new monaco.Selection(from.line, from.column, to.line, to.column));
    if (c.kind === 'edit') {
      const got = await runEdit(editor, c);
      const want = (c.expectText ?? '').replace(/\r\n/g, '\n');
      const read = () => model.getValue().replace(/\r\n/g, '\n');
      // Linked editing mirrors a typed change on the next tick; give the editor a moment before comparing.
      await poll(() => (read() === want ? true : null), 1_000);
      const seen = read();
      return result(got && seen === want, seen);
    }
    if (c.kind === 'definition' || c.kind === 'references') {
      // S57.1: what F12 / Shift+F12 find, as `file:line:column` (or `unsupported`). Retried while the service starts.
      const want = (c.expect ?? []).join(' | ');
      let seen = '';
      const paths = folderPaths(dir);
      const position = { lineNumber: from.line, column: from.column };
      const end = performance.now() + CASE_TIMEOUT_MS;
      while (performance.now() < end) {
        const found = await navigate(c.kind, model, position, paths);
        seen =
          found.kind === 'locations'
            ? found.locations.map((l) => `${l.relPath}:${l.line}:${l.column}`).join(' | ')
            : found.kind; // 'unsupported' ('indexing' cannot happen: folderPaths is always indexed)
        if (seen === want) break;
        await sleep(500);
      }
      return result(seen === want, seen);
    }
    if (c.kind === 'rename') {
      // S57.2: the plan F2 previews: every changed file's text, or a refusal.
      const pages = Object.entries(c.files ?? {})
        .filter(([name]) => name.endsWith('.html'))
        .map(([relPath, text]) => ({ relPath, text }));
      const position = { lineNumber: from.line, column: from.column };
      // `refused` or `refused:<reason>` (js-navigation.ts RenameRefusal).
      const [refusedWord, wantReason] = (c.expect?.[0] ?? '').split(':');
      const refused = refusedWord === 'refused';
      let seen = '';
      let pass = false;
      const end = performance.now() + CASE_TIMEOUT_MS;
      while (performance.now() < end && !pass) {
        const plan = await renamePlanAt(model, position, c.newName ?? '', pages, folderPaths(dir));
        if (!plan.ok) {
          seen = `refused:${plan.reason}`;
          pass = refused && (wantReason === undefined || wantReason === plan.reason);
        } else {
          const got = Object.fromEntries(plan.files.map((f) => [f.relPath, f.after.replace(/\r\n/g, '\n')]));
          seen = JSON.stringify(got);
          pass =
            !refused &&
            JSON.stringify(got) === JSON.stringify(Object.fromEntries(Object.entries(c.expectFiles ?? {}).sort()));
        }
        if (!pass) await sleep(500);
      }
      return result(pass, seen);
    }
    if (c.kind === 'colors') {
      // S53.3: the colour swatches Monaco draws (inline decorations), as the text they stand in front of.
      let seen: string[] = [];
      const read = () =>
        model
          .getAllDecorations()
          .filter((d) => d.options.before?.inlineClassName?.includes('colorpicker-color-decoration'))
          .sort((a, b) => monaco.Range.compareRangesUsingStarts(a.range, b.range))
          .map((d) => model.getValueInRange(d.range));
      const want = c.expect ?? [];
      const found = await poll(() => {
        seen = read();
        return seen.length === want.length && seen.every((text, i) => text === want[i]) ? seen : null;
      }, CASE_TIMEOUT_MS);
      return result(found !== null, seen.join(' | '));
    }
    if (c.kind === 'completion') {
      let lastTrigger = 0;
      let labels: string[] = [];
      const found = await poll(() => {
        if (performance.now() - lastTrigger > 2_500) {
          lastTrigger = performance.now();
          editor.trigger('capability-probe', 'editor.action.triggerSuggest', {});
        }
        labels = suggestionLabels(host);
        return (c.expect ?? []).every((label) => labels.includes(label)) ? labels : null;
      }, CASE_TIMEOUT_MS);
      editor.trigger('capability-probe', 'hideSuggestWidget', {});
      return result(found !== null, labels.join(', '));
    }
    if (c.kind === 'hover') {
      let lastTrigger = 0;
      let seen = '';
      const found = await poll(() => {
        if (performance.now() - lastTrigger > 2_500) {
          lastTrigger = performance.now();
          editor.trigger('capability-probe', 'editor.action.showHover', {});
        }
        seen = hoverText(host);
        return seen && (c.expect ?? []).every((part) => seen.includes(part)) ? seen : null;
      }, CASE_TIMEOUT_MS);
      return result(found !== null, seen);
    }
    // format
    const want = (c.expectText ?? '').replace(/\r\n/g, '\n');
    // The formatter answers once its worker is up; retry until then (formatting twice is a no-op).
    const end = performance.now() + CASE_TIMEOUT_MS;
    let got = model.getValue();
    while (performance.now() < end) {
      await editor.getAction('editor.action.formatDocument')?.run();
      got = model.getValue().replace(/\r\n/g, '\n');
      if (got === want) break;
      await sleep(500);
    }
    return result(got === want, got);
  } catch (error) {
    return result(false, error instanceof Error ? error.message : String(error));
  } finally {
    editor.setModel(null);
    model.dispose();
    for (const m of extra) m.dispose();
    for (const lib of libs) lib.dispose();
  }
}

export async function runCapabilityCases(cases: readonly CapabilityCase[]): Promise<CapabilityResult[]> {
  const host = document.createElement('div');
  // Laid out (the suggest and hover widgets need real geometry) but invisible and out of the way.
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px;opacity:0;pointer-events:none;z-index:-1';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  const editor = monaco.editor.create(host, {
    model: null,
    automaticLayout: false,
    minimap: { enabled: false },
    linkedEditing: true, // S53.2, as in the workbench editor
  });
  const authoring = attachAuthoring(editor, { publishColor: false }); // S53.2: Wrap with tag
  editor.layout({ width: 900, height: 500 });
  const results: CapabilityResult[] = [];
  try {
    for (const c of cases) results.push(await runCase(editor, host, c));
  } finally {
    authoring.dispose();
    editor.dispose();
    host.remove();
  }
  return results;
}
