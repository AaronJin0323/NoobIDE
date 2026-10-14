import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import { ProjectService } from '../../src/workspace/project-service';

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

async function contents(relPath: string): Promise<{ reason: string; text: string }[]> {
  const out = [];
  for (const v of await store.list(root, relPath)) {
    const data = await store.read(root, relPath, v.id);
    out.push({ reason: v.reason, text: data.ok ? decode(data.value) : `<${data.code}>` });
  }
  return out;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-triggers-'));
  await mkdir(path.join(tmp, '网页 练习'), { recursive: true });
  await cp(FIXTURE, path.join(tmp, '网页 练习', '中文 路径 项目'), { recursive: true });
  clock = 1_000_000;
  logs = [];
  const log = (event: string, fields: object) => logs.push(`${event} ${JSON.stringify(fields)}`);
  store = new SnapshotStore({ dir: path.join(tmp, 'app data', 'history'), now: () => clock, log });
  triggers = new HistoryTriggers(store, log);
  service = new ProjectService({ history: triggers });
  const opened = await service.open(path.join(tmp, '网页 练习', '中文 路径 项目'));
  if (!opened.ok) throw new Error(opened.message);
  root = opened.value.rootPath;
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await chmod(path.join(root, 'index.html'), 0o644).catch(() => undefined);
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
    expect(await store.list(root, NESTED)).toHaveLength(2);
  });

  it('rapid save batches (autosave) are coalesced into one version per burst', async () => {
    for (let i = 1; i <= 5; i += 1) {
      clock += 1000;
      await save('index.html', `<p>autosave ${i}</p>`);
    }
    clock += 120_000;
    await save('index.html', '<p>later</p>');
    const texts = (await contents('index.html')).map((c) => c.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe('<p>later</p>');
    expect(texts[1]).toBe('<p>autosave 5</p>');
    expect(texts[2]).toContain('你好，我是林小雨'); // the file as it was before the burst
  });

  it('a failed save records only the version before it, and the disk keeps that version', async () => {
    const file = path.join(root, 'index.html');
    const original = await readFile(file, 'utf8');
    await chmod(file, 0o444);
    const result = await save('index.html', '<p>不会写入</p>');
    expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
    expect(await readFile(file, 'utf8')).toBe(original);
    expect((await contents('index.html')).map((c) => c.reason)).not.toContain('after-save');
  });

  it('a broken history store never fails or blocks the save', async () => {
    await mkdir(path.join(tmp, 'blocked'), { recursive: true });
    await writeFile(path.join(tmp, 'blocked', 'history'), 'a file where the history folder should be');
    const broken = new HistoryTriggers(
      new SnapshotStore({ dir: path.join(tmp, 'blocked', 'history'), log: (e) => logs.push(e) }),
      (e) => logs.push(e),
    );
    const plain = new ProjectService({ history: broken });
    const opened = await plain.open(root);
    if (!opened.ok) throw new Error(opened.message);
    const result = await plain.write({
      projectId: opened.value.projectId,
      relPath: 'style.css',
      text: 'p{}',
      bom: false,
    });
    expect(result).toMatchObject({ ok: true });
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
    expect(await store.files(root)).toContain(NESTED);
    expect(await contents(NESTED)).toEqual([{ reason: 'before-delete', text: original }]);
  });

  it('before delete of a folder keeps every file inside it (Chinese names, nested)', async () => {
    const folder = path.join(root, '子 文件夹');
    await mkdir(path.join(folder, '图片 目录'), { recursive: true });
    await writeFile(path.join(folder, '图片 目录', '说明.txt'), '说明内容');
    await triggers.beforeDelete(root, '子 文件夹', folder);
    expect(await store.files(root)).toEqual(['子 文件夹/图片 目录/说明.txt', NESTED]);
    expect(await contents('子 文件夹/图片 目录/说明.txt')).toEqual([{ reason: 'before-delete', text: '说明内容' }]);
  });

  it('missing files, folders without files and oversized files are skipped without errors', async () => {
    await triggers.beforeDelete(root, 'gone.html', path.join(root, 'gone.html'));
    await triggers.beforeFormat(root, 'gone.html', path.join(root, 'gone.html'));
    await mkdir(path.join(root, '空 文件夹'));
    await triggers.beforeDelete(root, '空 文件夹', path.join(root, '空 文件夹'));
    const small = new HistoryTriggers(
      new SnapshotStore({ dir: path.join(tmp, 'small'), limits: { maxSnapshotBytes: 10 } }),
      (e) => logs.push(e),
    );
    await small.beforeFormat(root, 'index.html', path.join(root, 'index.html'));
    expect(await store.files(root)).toEqual([]);
    expect(logs).toContain('history.snapshot-skipped');
  });
});
