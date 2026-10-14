import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

afterEach(async () => {
  await triggers.whenIdle();
  await rm(tmp, { recursive: true, force: true });
});

const save = (relPath: string, text: string) => service.write({ projectId, relPath, text, bom: false });

describe('snapshots around save batches (S21.2)', () => {
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

  it('a hanging capture delays the save by at most the timeout; storing snapshots is never awaited', async () => {
    let recorded = 0;
    const hanging: SaveHistoryHook = {
      captureBeforeSave: () => new Promise<Uint8Array | null>(() => undefined),
      recordSave: () => {
        recorded += 1;
      },
    };
    const { s, id } = await openWith({ history: hanging });
    const started = Date.now();
    expect(await s.write({ projectId: id, relPath: 'style.css', text: 'a{}', bom: false })).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(HISTORY_CAPTURE_TIMEOUT_MS + 700);
    expect(recorded).toBe(1);

    // A store that takes 2 s per snapshot does not slow the save down.
    const slowStore = {
      limits: store.limits,
      snapshot: () => new Promise<never>(() => undefined),
    } as unknown as SnapshotStore;
    const slow = await openWith({ history: new HistoryTriggers(slowStore) });
    const t0 = Date.now();
    expect(await slow.s.write({ projectId: slow.id, relPath: 'style.css', text: 'b{}', bom: false })).toMatchObject({
      ok: true,
    });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a broken history store never fails the save', async () => {
    await mkdir(path.join(tmp, 'blocked'), { recursive: true });
    await writeFile(path.join(tmp, 'blocked', 'history'), 'a file where the history folder should be');
    const broken = new HistoryTriggers(new SnapshotStore({ dir: path.join(tmp, 'blocked', 'history'), log }), log);
    const { s, id } = await openWith({ history: broken });
    expect(await s.write({ projectId: id, relPath: 'style.css', text: 'p{}', bom: false })).toMatchObject({ ok: true });
    await broken.whenIdle();
    expect(await readFile(path.join(root, 'style.css'), 'utf8')).toBe('p{}');
    expect(logs.some((l) => l.startsWith('history.snapshot-failed'))).toBe(true);
  });
});

describe('snapshots before format, delete and restore (S21.2)', () => {
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
