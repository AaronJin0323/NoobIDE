import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers, type SaveHistoryHook } from '../../src/recovery/history-triggers';
import { HISTORY_CAPTURE_TIMEOUT_MS, ProjectService } from '../../src/workspace/project-service';

/** S21.2 integration: snapshots around saves (through the real ProjectService) and before format, delete, restore. */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');
const NESTED = '子 文件夹/页面 二.html';

let tmp: string;
let root: string;
let clock: number;
let logs: string[];
let store: SnapshotStore;
let triggers: HistoryTriggers;
let service: ProjectService;
let projectId: string;

const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const log = (event: string, fields: object) => logs.push(`${event} ${JSON.stringify(fields)}`);

async function contents(relPath: string): Promise<{ reason: string; text: string }[]> {
  await triggers.whenIdle();
  const list = await store.list(root, relPath);
  if (!list.ok) throw new Error(list.message);
  const out = [];
  for (const v of list.value) {
    const data = await store.read(root, relPath, v.id);
    out.push({ reason: v.reason, text: data.ok ? decode(data.value) : `<${data.code}>` });
  }
  return out;
}

async function historyFiles(): Promise<string[]> {
  await triggers.whenIdle();
  const files = await store.files(root);
  if (!files.ok) throw new Error(files.message);
  return files.value;
}

async function openWith(options: ConstructorParameters<typeof ProjectService>[0]) {
  const s = new ProjectService(options);
  const opened = await s.open(root);
  if (!opened.ok) throw new Error(opened.message);
  return { s, id: opened.value.projectId };
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-triggers-'));
  await mkdir(path.join(tmp, '网页 练习'), { recursive: true });
  await cp(FIXTURE, path.join(tmp, '网页 练习', '中文 路径 项目'), { recursive: true });
  clock = 1_000_000;
  logs = [];
  store = new SnapshotStore({ dir: path.join(tmp, 'app data', 'history'), now: () => clock, log });
  triggers = new HistoryTriggers(store, log);
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  const opened = await openWith({ history: triggers });
  service = opened.s;
  projectId = opened.id;
  root = service.rootOf(projectId) ?? '';
}, REAL_IO.timeout);

afterEach(async () => {
  await triggers.whenIdle();
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const save = (relPath: string, text: string) => service.write({ projectId, relPath, text, bom: false });

// S21.5: these tests do real, fsynced saves and snapshot writes. A save plus its snapshots takes ~20 ms on an idle
// machine but 1-2 s with the CPU saturated, so a burst of 6-8 saves outlasts vitest's 5 s default. The timeout is only
// a hang guard; every behaviour check below is independent of machine speed.
describe('snapshots around save batches (S21.2)', REAL_IO, () => {
  it('a save keeps the version before and after it; identical content is not duplicated', async () => {
    const original = await readFile(path.join(root, NESTED), 'utf8');
    expect(await save(NESTED, '<p>第一次保存</p>')).toMatchObject({ ok: true });
    expect(await contents(NESTED)).toEqual([
      { reason: 'after-save', text: '<p>第一次保存</p>' },
      { reason: 'before-save', text: original },
    ]);
    clock += 120_000;
    expect(await save(NESTED, '<p>第一次保存</p>')).toMatchObject({ ok: true }); // nothing changed
    expect(await contents(NESTED)).toHaveLength(2);
  });

  it('rapid save batches (autosave) are coalesced into one version per burst', async () => {
    for (let i = 1; i <= 5; i += 1) {
      clock += 1000;
      await save('index.html', `<p>autosave ${i}</p>`);
      await triggers.whenIdle(); // snapshots are stored after the save returns; read the test clock in order
    }
    clock += 120_000;
    await save('index.html', '<p>later</p>');
    const texts = (await contents('index.html')).map((c) => c.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe('<p>later</p>');
    expect(texts[1]).toBe('<p>autosave 5</p>');
    expect(texts[2]).toContain('你好，我是林小雨'); // the file as it was before the burst
  });

  it('back-to-back saves are stored in save order, so before-save versions dedupe against the previous save', async () => {
    const original = await readFile(path.join(root, 'index.html'), 'utf8');
    // (Concurrent saves of one file are serialised by the save pipeline, S10; here they follow each other.)
    for (let i = 1; i <= 8; i += 1) await save('index.html', `<p>quick ${i}</p>`);
    const list = await contents('index.html');
    expect(list.at(-1)).toEqual({ reason: 'before-save', text: original });
    expect(list[0]?.reason).toBe('after-save');
    expect(list).toHaveLength(2); // one coalesced burst after the original
  });

  it('a save that fails while replacing the file records only the version before it', async () => {
    const file = path.join(root, 'index.html');
    const original = await readFile(file, 'utf8');
    const failing = await openWith({
      history: triggers,
      replaceFile: async () => {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      },
    });
    const result = await failing.s.write({
      projectId: failing.id,
      relPath: 'index.html',
      text: '<p>x</p>',
      bom: false,
    });
    expect(result).toMatchObject({ ok: false, code: 'busy' });
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await contents('index.html')).toEqual([{ reason: 'before-save', text: original }]);
  });

  it('a throwing history hook never fails the save', async () => {
    const throwing: SaveHistoryHook = {
      captureBeforeSave: async () => {
        throw new Error('boom');
      },
      recordSave: () => {
        throw new Error('boom');
      },
    };
    const { s, id } = await openWith({ history: throwing });
    expect(await s.write({ projectId: id, relPath: 'style.css', text: 'p{}', bom: false })).toMatchObject({ ok: true });
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe('p{}');
  });

  // S21.5: proven structurally (a capture that never answers, a controlled clock, a store that never finishes) rather
  // than by elapsed milliseconds, which a loaded machine stretches arbitrarily.
  it('a hanging capture delays the save by exactly the timeout, never forever', async () => {
    let captureCalled!: () => void;
    const reachedCapture = new Promise<void>((resolve) => (captureCalled = resolve));
    const recorded: [Uint8Array | null, Uint8Array | null][] = [];
    const hanging: SaveHistoryHook = {
      captureBeforeSave: () => {
        captureCalled();
        return new Promise<Uint8Array | null>(() => undefined);
      },
      recordSave: (_root, _rel, before, after) => {
        recorded.push([before, after]);
      },
    };
    const { s, id } = await openWith({ history: hanging });
    // Only the timer is faked; file I/O and setImmediate stay real, so "still pending" below means "waiting on the
    // capture", not "waiting on the disk".
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const saving = s.write({ projectId: id, relPath: 'style.css', text: 'a{}', bom: false });
      void saving.finally(() => (settled = true));
      await reachedCapture;
      const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
      for (let i = 0; i < 5; i += 1) await turn();
      expect(settled).toBe(false); // the save waits for the capture …
      vi.advanceTimersByTime(HISTORY_CAPTURE_TIMEOUT_MS - 1);
      for (let i = 0; i < 5; i += 1) await turn();
      expect(settled).toBe(false); // … up to the timeout …
      vi.advanceTimersByTime(1);
      vi.useRealTimers(); // the rest of the save (Windows rename retries) runs on real timers
      expect(await saving).toMatchObject({ ok: true }); // … and then goes ahead without the before-save version
    } finally {
      vi.useRealTimers();
    }
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe('a{}');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.[0]).toBeNull();
    expect(decode(recorded[0]?.[1] ?? new Uint8Array())).toBe('a{}');
  });

  it('storing snapshots is never awaited by the save: a store that never finishes does not hold it up', async () => {
    let snapshotCalls = 0;
    const stuckStore = {
      limits: store.limits,
      snapshot: () => {
        snapshotCalls += 1;
        return new Promise<never>(() => undefined);
      },
    } as unknown as SnapshotStore;
    const stuck = await openWith({ history: new HistoryTriggers(stuckStore) });
    expect(await stuck.s.write({ projectId: stuck.id, relPath: 'style.css', text: 'b{}', bom: false })).toMatchObject({
      ok: true,
    });
    expect(snapshotCalls).toBe(2); // before-save and after-save were handed to the store, which never answers
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe('b{}');
  });

  it('the before-save version is the bytes the save already read: no second disk read that load could time out', async () => {
    const bytes = new TextEncoder().encode('<p>已读取</p>');
    // A path that does not exist: the version can only come from the bytes handed over, never from disk.
    const missing = path.join(root, 'gone.html');
    expect(await triggers.captureBeforeSave(missing, bytes)).toBe(bytes);
    const small = new HistoryTriggers(
      new SnapshotStore({ dir: path.join(tmp, 'small'), limits: { maxSnapshotBytes: 10 } }),
      log,
    );
    expect(await small.captureBeforeSave(missing, bytes)).toBeNull(); // over the size limit: skipped and logged
    expect(logs.some((l) => l.startsWith('history.snapshot-skipped'))).toBe(true);
  });

  it('a broken history store never fails the save', async () => {
    await mkdir(path.join(tmp, 'blocked'), { recursive: true });
    await writeFile(path.join(tmp, 'blocked', 'history'), 'a file where the history folder should be');
    const broken = new HistoryTriggers(new SnapshotStore({ dir: path.join(tmp, 'blocked', 'history'), log }), log);
    const { s, id } = await openWith({ history: broken });
    expect(await s.write({ projectId: id, relPath: 'style.css', text: 'p{}', bom: false })).toMatchObject({ ok: true });
    await broken.whenIdle();
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe('p{}');
    // The failure is logged either way; which way depends on the OS: reading `history/index` below a file is ENOENT
    // on Windows (no history yet → the write fails: snapshot-failed) and ENOTDIR on macOS (history unreadable → the
    // store refuses to write into it: snapshot-refused).
    expect(logs.some((l) => /^history\.snapshot-(failed|refused) /.test(l))).toBe(true);
  });
});

describe('snapshots before format, delete and restore (S21.2)', REAL_IO, () => {
  it('before format and before restore keep the current disk content', async () => {
    const file = path.join(root, 'style.css');
    const original = await readFile(file, 'utf8');
    await triggers.beforeFormat(root, 'style.css', file);
    await writeFile(file, 'formatted');
    clock += 1000;
    await triggers.beforeRestore(root, 'style.css', file);
    expect(await contents('style.css')).toEqual([
      { reason: 'before-restore', text: 'formatted' },
      { reason: 'before-format', text: original },
    ]);
  });

  it('before delete of a file keeps it, so a deleted file can be brought back', async () => {
    const file = path.join(root, NESTED);
    const original = await readFile(file, 'utf8');
    await triggers.beforeDelete(root, NESTED, file);
    await rm(file);
    expect(await historyFiles()).toContain(NESTED);
    expect(await contents(NESTED)).toEqual([{ reason: 'before-delete', text: original }]);
  });

  it('before delete of a folder keeps the files the listing shows — never dotfiles or node_modules', async () => {
    const folder = path.join(root, '子 文件夹');
    await mkdir(path.join(folder, '图片 目录'), { recursive: true });
    await writeFile(path.join(folder, '图片 目录', '说明.txt'), '说明内容');
    await writeFile(path.join(folder, '.env'), 'API_KEY=secret');
    await mkdir(path.join(folder, '.git'), { recursive: true });
    await writeFile(path.join(folder, '.git', 'config'), '[core]');
    await mkdir(path.join(folder, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(folder, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1');
    await triggers.beforeDelete(root, '子 文件夹', folder);
    expect(await historyFiles()).toEqual(['子 文件夹/图片 目录/说明.txt', NESTED]);
    await triggers.beforeDelete(root, '.env', path.join(root, '.env'));
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    await triggers.beforeDelete(root, '.env', path.join(root, '.env'));
    expect(await historyFiles()).not.toContain('.env');
  });

  it('format within a save burst: the hand-written version survives the save of the formatted text', async () => {
    const handWritten = 'function  f( ){return 1}\n';
    const formatted = 'function f() {\n  return 1;\n}\n';
    const original = await readFile(path.join(root, 'script.js'), 'utf8');
    expect(await save('script.js', handWritten)).toMatchObject({ ok: true }); // autosaved hand-written code
    await triggers.whenIdle();
    clock += 10_000; // well inside the coalesce window
    // The buffer is clean: the text kept before formatting equals the version just saved (deduped, burst sealed).
    await triggers.beforeFormatText(root, 'script.js', new TextEncoder().encode(handWritten));
    clock += 10_000;
    expect(await save('script.js', formatted)).toMatchObject({ ok: true });
    const texts = (await contents('script.js')).map((c) => c.text);
    expect(texts[0]).toBe(formatted);
    expect(texts).toContain(handWritten);
    expect(texts.at(-1)).toBe(original);
  });

  it('format of a buffer with unsaved edits keeps that buffer text as "before-format", then the formatted save', async () => {
    expect(await save('style.css', 'a{color:red}\n')).toMatchObject({ ok: true });
    await triggers.whenIdle();
    clock += 5_000;
    const dirty = 'a{color:red}\nb{margin:0}\n'; // typed, never saved
    await triggers.beforeFormatText(root, 'style.css', new TextEncoder().encode(dirty));
    clock += 5_000;
    expect(await save('style.css', 'a {\n  color: red;\n}\nb {\n  margin: 0;\n}\n')).toMatchObject({ ok: true });
    const list = await contents('style.css');
    expect(list[0]).toEqual({ reason: 'after-save', text: 'a {\n  color: red;\n}\nb {\n  margin: 0;\n}\n' });
    expect(list).toContainEqual({ reason: 'before-format', text: dirty });
    expect(list.map((c) => c.text)).toContain('a{color:red}\n');
  });

  it('the buffer text kept before formatting is skipped (and logged) when it is larger than the history limit', async () => {
    const small = new HistoryTriggers(
      new SnapshotStore({ dir: path.join(tmp, 'small'), limits: { maxSnapshotBytes: 10 } }),
      log,
    );
    await small.beforeFormatText(root, 'index.html', new TextEncoder().encode('<p>more than ten bytes</p>'));
    expect(logs.some((l) => l.startsWith('history.snapshot-skipped'))).toBe(true);
    expect(logs.join('\n')).not.toContain('more than ten bytes'); // logs never contain source code
  });

  it('missing files, folders without files and oversized files are skipped without errors', async () => {
    await triggers.beforeDelete(root, 'gone.html', path.join(root, 'gone.html'));
    await triggers.beforeFormat(root, 'gone.html', path.join(root, 'gone.html'));
    await mkdir(path.join(root, '空 文件夹'));
    await triggers.beforeDelete(root, '空 文件夹', path.join(root, '空 文件夹'));
    const small = new HistoryTriggers(
      new SnapshotStore({ dir: path.join(tmp, 'small'), limits: { maxSnapshotBytes: 10 } }),
      log,
    );
    await small.beforeFormat(root, 'index.html', path.join(root, 'index.html'));
    expect(await historyFiles()).toEqual([]);
    expect(logs.some((l) => l.startsWith('history.snapshot-skipped'))).toBe(true);
  });
});
