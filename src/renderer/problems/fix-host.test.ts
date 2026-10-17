import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { INITIAL_SAVE, type SaveSnapshot } from '../workbench/save-machine';
import { createSavedFileEvents } from '../workbench/saved-file-events';
import { createFixHost, type FixEditor, type FixSaver } from './fix-host';
import { holdsText, startFix, type CreateFileAction, type ReplaceTextAction } from './fix-model';

const TEXT = "const userName = '林小雨';\nconsole.log(userNmae);\nconsole.log(userNmae + '!');\n";
const action: ReplaceTextAction = {
  kind: 'replace-text',
  label: { key: 'action.replaceWith', params: { name: 'userName' } },
  span: { file: 'script.js', line: 2, column: 13, endColumn: 21 },
  from: 'userNmae',
  to: 'userName',
};

/** A tiny editor model: text, a version id and an undo stack, with the same span rules as rule-context-monaco. */
function fakeEditor(initial: string) {
  const model = { text: initial, version: 1, undo: [] as string[] };
  const offset = (line: number, column: number) => {
    const lines = model.text.split('\n');
    return lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
  };
  const replace = (line: number, column: number, endColumn: number, text: string) => {
    model.undo.push(model.text);
    const start = offset(line, column);
    model.text = model.text.slice(0, start) + text + model.text.slice(offset(line, endColumn));
    model.version += 1;
  };
  const editor: FixEditor = {
    waitForModel: async () => model,
    replaceSpan(_uri, span, from, to, match) {
      if (!holdsText(model.text.split('\n')[span.line - 1] ?? '', span.column, from, match)) {
        return { ok: false, reason: 'changed' };
      }
      replace(span.line, span.column, span.endColumn, to);
      return { ok: true, text: model.text, version: model.version };
    },
    undoSpan(_uri, span, from, to, version, match) {
      if (model.version === version) {
        model.text = model.undo.pop() ?? model.text;
        model.version += 1;
      } else {
        if (!holdsText(model.text.split('\n')[span.line - 1] ?? '', span.column, to, match)) {
          return { ok: false, reason: 'changed' };
        }
        replace(span.line, span.column, span.column + to.length, from);
      }
      return { ok: true, text: model.text, version: model.version };
    },
    fillEmpty(_uri, text) {
      if (model.text !== '') return { ok: false, reason: 'changed' };
      model.undo.push(model.text);
      model.text = text;
      model.version += 1;
      return { ok: true, text: model.text, version: model.version };
    },
    emptyAgain(_uri, text, version) {
      if (model.version !== version && model.text !== text) return { ok: false, reason: 'changed' };
      model.text = '';
      model.version += 1;
      return { ok: true, text: model.text, version: model.version };
    },
    stillReportsUndefinedName: async (_uri, line, name) => model.text.split('\n')[line - 1]?.includes(name) ?? false,
    stillReportsBeginner: async () => null,
    reportsNow: () => null,
  };
  return { model, editor };
}

/** A save pipeline stand-in: keeps the newest text in memory; `fail` makes writes fail like DocumentSaver does. */
function fakeSaver(initial: string, fail: { code: string } | null = null) {
  const disk = { text: initial };
  let state: SaveSnapshot = INITIAL_SAVE;
  const saver: FixSaver & { latest: string; edit(text: string): void } = {
    latest: initial,
    get text() {
      return this.latest;
    },
    get state() {
      return state;
    },
    edit(text: string) {
      this.latest = text;
      state = { ...state, revision: state.revision + 1 };
    },
    async save() {
      if (fail) {
        state = { ...state, error: { code: fail.code, message: 'EACCES' } };
        return false;
      }
      disk.text = this.latest;
      state = { ...state, savedRevision: state.revision, error: null };
      return true;
    },
  };
  return { saver, disk };
}

function setup(opts: { fail?: { code: string }; readOnly?: boolean; text?: string } = {}) {
  const { model, editor } = fakeEditor(opts.text ?? TEXT);
  const { saver, disk } = fakeSaver(opts.text ?? TEXT, opts.fail ?? null);
  /** What the workbench's recordEdit received: the journal and the save pipeline are fed from it. */
  const recorded: { relPath: string; text: string }[] = [];
  const tab = { saver: saver as FixSaver | undefined };
  const host = createFixHost({
    showFile: async () => ({ uri: 'file:///p/script.js', readOnly: opts.readOnly ?? false }),
    saverOf: () => tab.saver,
    recordEdit: (relPath, text) => {
      recorded.push({ relPath, text });
      saver.edit(text);
    },
    uriOf: () => 'file:///p/script.js',
    savedFiles: createSavedFileEvents(),
    editor: async () => editor,
  });
  return { host, model, saver, disk, recorded, tab, editor };
}

const record = createProblemRecord(
  {
    source: 'static',
    severity: 'error',
    projectId: 'p',
    file: 'script.js',
    line: 2,
    column: 13,
    code: '2552',
    message: "Cannot find name 'userNmae'. Did you mean 'userName'?",
    at: 1,
  },
  's',
);

describe('one-click fix through the editor and the save pipeline (S22.5)', () => {
  it('changes only that span, as one undo step, and saves it through the pipeline', async () => {
    const { host, model, disk } = setup();
    const outcome = await host.apply(action);
    expect(outcome).toEqual({ kind: 'applied', version: 2 });
    const expected = "const userName = '林小雨';\nconsole.log(userName);\nconsole.log(userNmae + '!');\n";
    expect(model.text).toBe(expected); // the same name on line 3 is untouched
    expect(disk.text).toBe(expected);
    expect(model.undo).toEqual([TEXT]); // one undo step
    expect(await host.stillReported({ ...startFix(record, action), version: 2 })).toBe(false);
  });

  it('a failed save keeps the edit in the editor and in the save pipeline, and reports the save error', async () => {
    const { host, model, saver, disk } = setup({ fail: { code: 'permission-denied' } });
    const outcome = await host.apply(action);
    expect(outcome).toEqual({ kind: 'save-failed', version: 2, code: 'permission-denied' });
    expect(model.text).toContain('console.log(userName);');
    expect(saver.text).toBe(model.text); // nothing lost: the pipeline holds the edit for the next save
    expect(disk.text).toBe(TEXT);
    expect(await host.retrySave('script.js')).toEqual({ ok: false, code: 'permission-denied' });
  });

  it('changes nothing when the code changed since the check, or the file is read-only', async () => {
    const moved = setup({ text: "const userName = '林小雨';\nconsole.log( userNmae);\n" });
    expect(await moved.host.apply(action)).toEqual({ kind: 'not-applied', reason: 'changed' });
    expect(moved.model.undo).toEqual([]);
    expect(moved.disk.text).toBe("const userName = '林小雨';\nconsole.log( userNmae);\n");
    const readOnly = setup({ readOnly: true });
    expect(await readOnly.host.apply(action)).toEqual({ kind: 'not-applied', reason: 'read-only' });
    expect(readOnly.model.text).toBe(TEXT);
  });

  it("the card's Undo uses the editor's undo when nothing changed since, and saves the original back", async () => {
    const { host, model, disk } = setup();
    const applied = await host.apply(action);
    if (applied.kind !== 'applied') throw new Error('not applied');
    const fix = { ...startFix(record, action), phase: 'resolved' as const, version: applied.version };
    expect(await host.undo(fix)).toEqual({ kind: 'undone' });
    expect(model.text).toBe(TEXT);
    expect(disk.text).toBe(TEXT);
  });

  it('Undo after later edits puts back only that span, and refuses when the span changed', async () => {
    const { host, model } = setup();
    const applied = await host.apply(action);
    if (applied.kind !== 'applied') throw new Error('not applied');
    model.text = model.text + '// more\n';
    model.version += 1;
    const fix = { ...startFix(record, action), phase: 'resolved' as const, version: applied.version };
    expect(await host.undo(fix)).toEqual({ kind: 'undone' });
    expect(model.text).toBe(`${TEXT}// more\n`);
    expect(await host.undo(fix)).toEqual({ kind: 'changed' }); // the span reads userNmae again
  });

  it('records the edit for the recovery journal even when the editor does not show the file (background tab)', async () => {
    const { host, recorded, disk } = setup({ fail: { code: 'permission-denied' } });
    expect((await host.apply(action)).kind).toBe('save-failed');
    // The save failed: the fix exists only in memory, and the journal has it (recordEdit feeds tabJournals.edited).
    expect(recorded).toEqual([{ relPath: 'script.js', text: expect.stringContaining('console.log(userName);') }]);
    expect(disk.text).toBe(TEXT);
  });

  it('does not touch a buffer that is no longer the tab of that file (closed, project reopened)', async () => {
    const { host, model, tab, editor } = setup();
    const wait = editor.waitForModel;
    editor.waitForModel = async (uri) => {
      const result = await wait(uri);
      tab.saver = undefined; // the tab closed while the model was awaited
      return result;
    };
    expect(await host.apply(action)).toEqual({ kind: 'not-applied', reason: 'not-open' });
    expect(model.text).toBe(TEXT);
  });

  it('changes nothing when the span is now part of a longer name', async () => {
    const longer = setup({ text: 'const userNameList = [];\nconsole.log(userNmaeList);\n' });
    const inside = { ...action, span: { ...action.span, line: 2, column: 13, endColumn: 21 } };
    expect(await longer.host.apply(inside)).toEqual({ kind: 'not-applied', reason: 'changed' });
    expect(longer.model.undo).toEqual([]);
  });
});

describe('S55.3 quick fixes through the editor and the save pipeline', () => {
  const PAGE = '<img src="images/logoo.png" alt="标志">\n<img src="images/logoo.png" alt="二">\n';
  const usePath: ReplaceTextAction = {
    kind: 'replace-text',
    label: { key: 'action.usePath', params: { path: 'images/logo.png' } },
    span: { file: 'index.html', line: 1, column: 11, endColumn: 27 },
    from: 'images/logoo.png',
    to: 'images/logo.png',
    match: 'exact',
  };
  const pageRecord = createProblemRecord(
    {
      source: 'static',
      severity: 'warning',
      projectId: 'p',
      file: 'index.html',
      line: 1,
      column: 11,
      code: 'html-broken-ref',
      message: '`src` path `images/logoo.png` does not match any file in the project.',
      data: { ref: 'images/logoo.png', attr: 'src', endLine: 1, endColumn: 27 },
      at: 1,
    },
    'q',
  );
  const create: CreateFileAction = {
    kind: 'create-file',
    label: { key: 'action.createFile', params: { path: 'css/main.css' } },
    path: 'css/main.css',
    template: 'css',
    problemFile: 'index.html',
    problemLine: 4,
  };

  it('an exact replacement changes only that span (not the same text on the next line), as one undo step, saved', async () => {
    const { host, model, disk } = setup({ text: PAGE });
    expect(await host.apply(usePath)).toEqual({ kind: 'applied', version: 2 });
    const expected = '<img src="images/logo.png" alt="标志">\n<img src="images/logoo.png" alt="二">\n';
    expect(model.text).toBe(expected);
    expect(disk.text).toBe(expected);
    expect(model.undo).toEqual([PAGE]);
    const fix = { ...startFix(pageRecord, usePath), phase: 'resolved' as const, version: 2 };
    expect(await host.undo(fix)).toEqual({ kind: 'undone' });
    expect(disk.text).toBe(PAGE);
  });

  it('an exact replacement is not applied when the span no longer reads the old text', async () => {
    const moved = setup({ text: `<p>\n${PAGE}` });
    expect(await moved.host.apply(usePath)).toEqual({ kind: 'not-applied', reason: 'changed' });
    expect(moved.disk.text).toBe(`<p>\n${PAGE}`);
  });

  /** A host for a file that does not exist yet: createFile succeeds once (or reports `exists`). */
  function createSetup(opts: { exists?: boolean; fail?: { code: string }; code?: string } = {}) {
    const { model, editor } = fakeEditor('');
    const { saver, disk } = fakeSaver('', opts.fail ?? null);
    const created: string[] = [];
    const host = createFixHost({
      showFile: async () => ({ uri: 'file:///p/css/main.css', readOnly: false }),
      saverOf: () => saver,
      recordEdit: (_relPath, text) => saver.edit(text),
      uriOf: () => 'file:///p/css/main.css',
      savedFiles: createSavedFileEvents(),
      createFile: async (relPath) => {
        if (opts.exists) return { ok: false, code: 'exists' };
        if (opts.code) return { ok: false, code: opts.code };
        created.push(relPath);
        return { ok: true };
      },
      locale: () => 'en',
      editor: async () => editor,
    });
    return { host, model, disk, created, saver, editor };
  }

  it('create-file: created exclusively, the template is one editor edit in the empty file, saved', async () => {
    const { host, model, disk, created } = createSetup();
    expect(await host.apply(create)).toEqual({ kind: 'applied', version: 2 });
    expect(created).toEqual(['css/main.css']);
    expect(model.text).toBe('/* main: write your styles here. */\n');
    expect(disk.text).toBe(model.text);
    const fix = { ...startFix(pageRecord, create), phase: 'resolved' as const, version: 2 };
    expect(await host.undo(fix)).toEqual({ kind: 'undone' });
    expect(disk.text).toBe(''); // the template is taken out; the file itself stays (deleting is the user's call)
  });

  it('create-file never overwrites: when the path exists nothing is created, opened or written', async () => {
    const { host, model, created } = createSetup({ exists: true });
    expect(await host.apply(create)).toEqual({ kind: 'not-applied', reason: 'exists' });
    expect(created).toEqual([]);
    expect(model.undo).toEqual([]);
  });

  it('create-file: a file that is not empty when opened is left alone', async () => {
    const { host, model } = createSetup();
    model.text = 'body { color: red; }\n';
    expect(await host.apply(create)).toEqual({ kind: 'not-applied', reason: 'created-empty' });
    expect(model.text).toBe('body { color: red; }\n');
  });

  it('create-file: a failed save keeps the template in the editor and the pipeline, and reports it', async () => {
    const { host, model, disk, saver } = createSetup({ fail: { code: 'permission-denied' } });
    expect(await host.apply(create)).toEqual({ kind: 'save-failed', version: 2, code: 'permission-denied' });
    expect(model.text).toContain('write your styles here');
    expect(saver.text).toBe(model.text);
    expect(disk.text).toBe('');
  });

  it('a stale quick fix (the finding is gone from the current text) changes nothing', async () => {
    const { host, model, disk, editor } = setup({ text: PAGE });
    editor.reportsNow = () => false;
    expect(await host.apply(usePath, pageRecord)).toEqual({ kind: 'not-applied', reason: 'changed' });
    expect(model.undo).toEqual([]);
    expect(disk.text).toBe(PAGE);
    editor.reportsNow = () => true;
    expect((await host.apply(usePath, pageRecord)).kind).toBe('applied');
  });

  it('create-file: a stale reference creates nothing; a refused create keeps its cause', async () => {
    const stale = createSetup();
    stale.editor.reportsNow = () => false;
    expect(await stale.host.apply(create, pageRecord)).toEqual({ kind: 'not-applied', reason: 'changed' });
    expect(stale.created).toEqual([]);
    const { host, created } = createSetup({ code: 'permission-denied' });
    expect(await host.apply(create, pageRecord)).toEqual({
      kind: 'not-applied',
      reason: 'create-failed',
      code: 'permission-denied',
    });
    expect(created).toEqual([]);
  });

  it('without a createFile dependency nothing is created', async () => {
    const { host } = setup({ text: '' });
    expect(await host.apply(create)).toEqual({ kind: 'not-applied', reason: 'not-open' });
  });
});
