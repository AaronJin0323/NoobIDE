import { monaco } from './monaco-setup';
import { cursorOf, extensionOf, type CapabilityCase, type CapabilityResult } from './capability-cases';

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
  const { text, line, column } = cursorOf(c.text);
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
    editor.setPosition({ lineNumber: line, column });
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
  }
}

export async function runCapabilityCases(cases: readonly CapabilityCase[]): Promise<CapabilityResult[]> {
  const host = document.createElement('div');
  // Laid out (the suggest and hover widgets need real geometry) but invisible and out of the way.
  host.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px;opacity:0;pointer-events:none;z-index:-1';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  const editor = monaco.editor.create(host, { model: null, automaticLayout: false, minimap: { enabled: false } });
  editor.layout({ width: 900, height: 500 });
  const results: CapabilityResult[] = [];
  try {
    for (const c of cases) results.push(await runCase(editor, host, c));
  } finally {
    editor.dispose();
    host.remove();
  }
  return results;
}
