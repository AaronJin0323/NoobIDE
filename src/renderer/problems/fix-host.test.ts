import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { INITIAL_SAVE, type SaveSnapshot } from '../workbench/save-machine';
import { createSavedFileEvents } from '../workbench/saved-file-events';
import { createFixHost, type FixEditor, type FixSaver } from './fix-host';
import { startFix, type ReplaceTextAction } from './fix-model';

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
    replaceSpan(_uri, span, from, to) {
      const at = offset(span.line, span.column);
      if (model.text.slice(at, at + from.length) !== from) return { ok: false, reason: 'changed' };
      replace(span.line, span.column, span.endColumn, to);
      return { ok: true, text: model.text, version: model.version };
    },
    undoSpan(_uri, span, from, to, version) {
      if (model.version === version) {
        model.text = model.undo.pop() ?? model.text;
        model.version += 1;
      } else {
        const at = offset(span.line, span.column);
        if (model.text.slice(at, at + to.length) !== to) return { ok: false, reason: 'changed' };
        replace(span.line, span.column, span.column + to.length, from);
      }
      return { ok: true, text: model.text, version: model.version };
    },
    stillReportsUndefinedName: async (_uri, line, name) => model.text.split('\n')[line - 1]?.includes(name) ?? false,
  };
  return { model, editor };
}

/** A save pipeline stand-in: keeps the newest text in memory; `fail` makes writes fail like DocumentSaver does. */
function fakeSaver(initial: string, fail: { code: string } | null = null) {
  const disk = { text: initial };
  let state: SaveSnapshot = INITIAL_SAVE;
  const saver: FixSaver & { latest: string } = {
    latest: initial,
    get text() {
      return this.latest;
    },
    get state() {
      return state;
    },
    edit(text) {
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
  const host = createFixHost({
    showFile: async () => ({ uri: 'file:///p/script.js', readOnly: opts.readOnly ?? false }),
    saverOf: () => saver,
    uriOf: () => 'file:///p/script.js',
    savedFiles: createSavedFileEvents(),
    editor: async () => editor,
  });
  return { host, model, saver, disk };
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
});
