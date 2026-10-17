/**
 * S55.3 integration: the "create the missing file" and "change the path" quick fixes on the real file system, in a
 * project path with Chinese characters and spaces, through the same host the workbench uses (fix-host.ts):
 * - creating never overwrites (the workspace's exclusive create; an existing file keeps its bytes);
 * - the template / new path is saved with the real atomic write; a failed save keeps the edit in memory;
 * - the fix is never "resolved" while its save failed, and only after a re-check of the page (the real beginner
 *   checks, with the created file counted) no longer reports the problem.
 * The editor model is a small stand-in with the same rules as rule-context-monaco (Monaco needs a browser).
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBeginner } from '../../src/diagnostics/beginner-checks';
import { explain } from '../../src/diagnostics/rules';
import { createFixHost, type FixEditor, type FixSaver } from '../../src/renderer/problems/fix-host';
import {
  fixActionOf,
  holdsText,
  nextPhase,
  recheckOnSave,
  sameBeginnerFinding,
  startFix,
  type FixState,
} from '../../src/renderer/problems/fix-model';
import { markerToProblem } from '../../src/renderer/problems/static-problems';
import { INITIAL_SAVE, type SaveSnapshot } from '../../src/renderer/workbench/save-machine';
import { createSavedFileEvents } from '../../src/renderer/workbench/saved-file-events';
import type { ProblemRecord } from '../../src/shared/problem';
import { writeFileAtomic } from '../../src/workspace/atomic-write';
import { createEntry } from '../../src/workspace/file-ops';

let tmp: string;
let root: string;
const PAGE =
  '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <link rel="stylesheet" href="css/主题 样式.css">\n</head>\n<body>\n  <img src="images/logoo.png" alt="标志">\n</body>\n</html>\n';

beforeEach(async () => {
  // The real path: on hosted Windows runners TEMP is an 8.3 short name (C:UsersRUNNER~1...), and
  // createEntry realpath-checks the parent folder against the root it is given, so the raw path would be 'outside'.
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-quickfix-')));
  root = path.join(tmp, '我的 网站');
  await mkdir(path.join(root, 'css'), { recursive: true });
  await mkdir(path.join(root, 'images'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), PAGE);
  await writeFile(path.join(root, 'images', 'logo.png'), 'png');
  await writeFile(path.join(root, 'css', 'base.css'), 'body { margin: 0; }');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The project's files as the index lists them (files only: the create fix needs its folder to hold a file). */
const baseFiles = ['index.html', 'images/logo.png', 'css/base.css'];
const files = async () => baseFiles;

/** Open "editor buffers" by project path: text + version, edited with the same span rules as the real editor. */
function workspace(opts: { failSaves?: Set<string> } = {}) {
  const models = new Map<string, { text: string; version: number; undo: string[] }>();
  const savers = new Map<string, FixSaver & { latest: string }>();
  const extraFiles: string[] = [];
  const open = async (relPath: string) => {
    if (!models.has(relPath)) {
      const text = await readFile(path.join(root, relPath), 'utf8');
      models.set(relPath, { text, version: 1, undo: [] });
      let state: SaveSnapshot = INITIAL_SAVE;
      savers.set(relPath, {
        latest: text,
        get text() {
          return this.latest;
        },
        get state() {
          return state;
        },
        async save() {
          if (opts.failSaves?.has(relPath)) {
            state = { ...state, error: { code: 'permission-denied', message: 'EACCES' } };
            return false;
          }
          await writeFileAtomic(path.join(root, relPath), new TextEncoder().encode(this.latest));
          state = { ...state, error: null };
          return true;
        },
      });
    }
    return { uri: `file:///${relPath}`, readOnly: false };
  };
  const rel = (uri: string) => uri.slice('file:///'.length);
  const set = (m: { text: string; version: number; undo: string[] }, text: string) => {
    m.undo.push(m.text);
    m.text = text;
    m.version += 1;
    return { ok: true as const, text, version: m.version };
  };
  const editor: FixEditor = {
    waitForModel: async (uri) => models.get(rel(uri)),
    replaceSpan(uri, span, from, to, match) {
      const m = models.get(rel(uri))!;
      const lines = m.text.split('\n');
      const line = lines[span.line - 1] ?? '';
      if (!holdsText(line, span.column, from, match)) return { ok: false, reason: 'changed' };
      lines[span.line - 1] = line.slice(0, span.column - 1) + to + line.slice(span.endColumn - 1);
      return set(m, lines.join('\n'));
    },
    undoSpan: () => ({ ok: false, reason: 'changed' }),
    fillEmpty(uri, text) {
      const m = models.get(rel(uri))!;
      return m.text === '' ? set(m, text) : { ok: false, reason: 'changed' };
    },
    emptyAgain: () => ({ ok: false, reason: 'changed' }),
    stillReportsUndefinedName: async () => null,
    reportsNow(uri, record) {
      const m = models.get(rel(uri));
      if (!m) return null;
      return checkBeginner('html', m.text, { relPath: rel(uri), projectFiles: [...baseFiles, ...extraFiles] }).some(
        (f) => f.column === record.column && sameBeginnerFinding(record, f),
      );
    },
    // The real beginner checks on the page's current buffer, with the project's files read from disk.
    async stillReportsBeginner(uri, record, extra) {
      const m = models.get(rel(uri));
      if (!m) return null;
      const projectFiles = [...(await files()), ...extraFiles, ...extra];
      const findings = checkBeginner('html', m.text, { relPath: rel(uri), projectFiles });
      return findings.some((f) => sameBeginnerFinding(record, f));
    },
  };
  const host = createFixHost({
    showFile: open,
    saverOf: (relPath) => savers.get(relPath),
    recordEdit: (relPath, text) => {
      savers.get(relPath)!.latest = text;
    },
    uriOf: (relPath) => (models.has(relPath) ? `file:///${relPath}` : undefined),
    savedFiles: createSavedFileEvents(),
    createFile: async (relPath) => {
      const result = await createEntry(root, relPath, 'file');
      return result.ok ? { ok: true } : { ok: false, code: result.code };
    },
    locale: () => 'zh-CN',
    editor: async () => editor,
  });
  return { host, models, savers, open };
}

/** The page's beginner problems, as the editor would list them. */
async function pageProblems(): Promise<ProblemRecord[]> {
  const text = await readFile(path.join(root, 'index.html'), 'utf8');
  return checkBeginner('html', text, { relPath: 'index.html', projectFiles: await files() }).map((f) =>
    markerToProblem(
      {
        owner: 'noobide-beginner',
        severity: 4,
        code: f.code,
        message: f.message,
        startLineNumber: f.line,
        startColumn: f.column,
        endLineNumber: f.line,
        endColumn: f.endColumn,
      },
      { projectId: 'p', relPath: 'index.html', at: 1 },
    )!,
  );
}

/** What the card would do: apply, then (if saved) re-check and judge. Returns the final phase. */
async function runFix(ws: ReturnType<typeof workspace>, record: ProblemRecord): Promise<FixState> {
  const action = fixActionOf(explain(record, { projectFiles: await files() }));
  if (!action) throw new Error('no fix offered');
  let fix = startFix(record, action);
  const outcome = await ws.host.apply(action, record);
  if (outcome.kind === 'not-applied') return { ...fix, phase: 'not-applied', reason: outcome.reason };
  if (outcome.kind === 'save-failed') {
    fix = { ...fix, phase: 'save-failed', version: outcome.version, saveError: outcome.code };
    // Whatever a re-check would say, a fix whose save failed is never resolved.
    return { ...fix, phase: nextPhase(fix, false, []) };
  }
  fix = { ...fix, phase: 'checking', version: outcome.version };
  expect(nextPhase(fix, null, [])).toBe('checking'); // no answer yet: not resolved
  return { ...fix, phase: nextPhase(fix, await ws.host.stillReported(fix), []) };
}

describe('S55.3 quick fixes on the real file system', () => {
  it('create the missing file: created from the template, saved atomically, resolved after the re-check', async () => {
    const ws = workspace();
    await ws.open('index.html');
    const css = (await pageProblems()).find((r) => r.data?.ref === 'css/主题 样式.css')!;
    const fix = await runFix(ws, css);
    expect(fix.phase).toBe('resolved');
    expect(await readFile(path.join(root, 'css', '主题 样式.css'), 'utf8')).toBe('/* 主题 样式：在这里写样式。 */\n');
  });

  it('create the missing file never overwrites: a file that appeared meanwhile keeps its bytes', async () => {
    const ws = workspace();
    await ws.open('index.html');
    const css = (await pageProblems()).find((r) => r.data?.ref === 'css/主题 样式.css')!;
    // The file appears after the check (e.g. created in Explorer) but before the fix runs.
    await writeFile(path.join(root, 'css', '主题 样式.css'), 'h1 { color: red; }\n');
    const fix = await runFix(ws, css);
    expect(fix).toMatchObject({ phase: 'not-applied', reason: 'exists' });
    expect(await readFile(path.join(root, 'css', '主题 样式.css'), 'utf8')).toBe('h1 { color: red; }\n');
  });

  it('change the path: a failed save keeps the edit in memory and is never resolved; saving again resolves it', async () => {
    const failSaves = new Set(['index.html']);
    const ws = workspace({ failSaves });
    await ws.open('index.html');
    const img = (await pageProblems()).find((r) => r.data?.ref === 'images/logoo.png')!;
    const failed = await runFix(ws, img);
    expect(failed).toMatchObject({ phase: 'save-failed', saveError: 'permission-denied' });
    expect(ws.models.get('index.html')!.text).toContain('src="images/logo.png"'); // the edit is kept in memory
    expect(ws.savers.get('index.html')!.text).toContain('src="images/logo.png"'); // and in the save pipeline
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe(PAGE); // the disk is untouched

    failSaves.clear();
    expect(await ws.host.retrySave('index.html')).toEqual({ ok: true });
    const rechecked = { ...failed, phase: 'checking' as const };
    expect(nextPhase(rechecked, await ws.host.stillReported(rechecked), [])).toBe('resolved');
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toContain('src="images/logo.png"');
  });

  it('create the missing file: a failed save is never resolved, not even when the page is saved meanwhile', async () => {
    const ws = workspace({ failSaves: new Set(['css/主题 样式.css']) });
    await ws.open('index.html');
    const css = (await pageProblems()).find((r) => r.data?.ref === 'css/主题 样式.css')!;
    const fix = await runFix(ws, css);
    expect(fix).toMatchObject({ phase: 'save-failed', saveError: 'permission-denied' });
    expect(ws.models.get('css/主题 样式.css')!.text).toContain('在这里写样式'); // kept in memory
    expect(await readFile(path.join(root, 'css', '主题 样式.css'), 'utf8')).toBe(''); // created empty, never overwritten
    // The user saves the page: that does not re-check a fix whose own save failed (the card keeps "Save again").
    expect(recheckOnSave(fix, 'index.html')).toBe(false);
    expect(recheckOnSave(fix, 'css/主题 样式.css')).toBe(true);
  });

  it('a stale finding (removed from the page since the check) is not "fixed" again', async () => {
    const ws = workspace();
    await ws.open('index.html');
    const img = (await pageProblems()).find((r) => r.data?.ref === 'images/logoo.png')!;
    // The user corrects the path by hand before the markers caught up, then clicks the card's fix.
    ws.models.get('index.html')!.text = PAGE.replace('images/logoo.png', 'images/logo.png ');
    const fix = await runFix(ws, img);
    expect(fix).toMatchObject({ phase: 'not-applied', reason: 'changed' });
  });

  it('the re-check keeps a fix "still reported" while the page still has the same finding', async () => {
    const ws = workspace();
    await ws.open('index.html');
    const img = (await pageProblems()).find((r) => r.data?.ref === 'images/logoo.png')!;
    const fix = {
      ...startFix(img, fixActionOf(explain(img, { projectFiles: await files() }))!),
      phase: 'checking' as const,
    };
    expect(await ws.host.stillReported(fix)).toBe(true); // nothing applied yet: still reported
    expect(nextPhase(fix, true, [])).toBe('still-reported');
  });
});
