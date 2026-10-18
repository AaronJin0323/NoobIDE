import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore, isCheckpointPath, type CheckpointOptions } from '../../src/recovery/checkpoints';
import { LEGACY_PIN_KEY, SnapshotStore, type HistoryOptions } from '../../src/recovery/history';
import { projectKey, sha256Hex } from '../../src/recovery/keys';

/**
 * S56.1 integration: whole-project checkpoints on the real filesystem, sharing local history's content-addressed blob
 * store. A project with Chinese names and spaces, hidden and ignored files, and a binary file.
 */
let tmp: string;
let root: string;
let appData: string;
let historyDir: string;
let checkpointsDir: string;
let clock: number;
let logs: string[];

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255, 254]);

function history(extra: Partial<HistoryOptions> = {}) {
  return new SnapshotStore({ dir: historyDir, now: () => clock, retryDelayMs: 1, ...extra });
}

function checkpoints(h: SnapshotStore, extra: Partial<CheckpointOptions> = {}) {
  return new CheckpointStore({
    dir: checkpointsDir,
    history: h,
    now: () => clock,
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
    ...extra,
  });
}

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '').catch(() => undefined);
  return out.sort();
}

async function snapshotOfProject(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await tree(dir)) out[rel] = sha256Hex(await readFile(path.join(dir, rel)));
  return out;
}

const blobs = async () => (await tree(path.join(historyDir, 'objects'))).filter((n) => !n.endsWith('.noobide-tmp'));
const blobPath = (hash: string) => path.join(historyDir, 'objects', hash.slice(0, 2), hash);

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-checkpoints-'));
  root = path.join(tmp, '我的 网站');
  appData = path.join(tmp, 'app data');
  historyDir = path.join(appData, 'history');
  checkpointsDir = path.join(appData, 'checkpoints');
  clock = 1_700_000_000_000;
  logs = [];
  await mkdir(path.join(root, '样式 文件'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'lib'), { recursive: true });
  await mkdir(path.join(root, 'images'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<h1>你好</h1>');
  await writeFile(path.join(root, '样式 文件', '主 样式.css'), 'h1 { color: red; }');
  await writeFile(path.join(root, 'app.js'), 'console.log(1);');
  await writeFile(path.join(root, 'images', 'logo.png'), PNG);
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  await writeFile(path.join(root, '.git', 'config'), '[core]');
  await writeFile(path.join(root, 'node_modules', 'lib', 'index.js'), 'module.exports = 1;');
  await writeFile(path.join(root, 'Thumbs.db'), 'x');
  await writeFile(path.join(root, 'page.html.noobide-tmp'), 'temp');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Real file-system I/O: a starved hosted Windows runner can take well over Vitest's 5 s default (S58.10, as S58.9).
const REAL_IO = { timeout: 60_000 };

describe('S56.1 checkpoint store', REAL_IO, () => {
  it('records the whole project with the ignore rules applied, in app data only', async () => {
    const before = await snapshotOfProject(root);
    const h = history();
    const c = checkpoints(h);
    const made = await c.create(root, { name: '第一版 首页', kind: 'named', cause: 'manual' });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.deduped).toBe(false);
    expect(made.value.checkpoint).toMatchObject({ name: '第一版 首页', kind: 'named', cause: 'manual', fileCount: 4 });

    const record = await c.get(root, made.value.checkpoint.id);
    expect(record.ok && record.value.files.map((f) => f.path)).toEqual([
      'app.js',
      'images/logo.png',
      'index.html',
      '样式 文件/主 样式.css',
    ]);
    // Nothing was written into the project: same files, same contents (hidden ones included).
    expect(await snapshotOfProject(root)).toEqual(before);
    // The manifest is in app data, under the project's hashed key (no user path in the file name).
    expect(await tree(checkpointsDir)).toEqual([`${projectKey(root)}/${made.value.checkpoint.id}.json`]);

    // Every file comes back byte for byte, the binary one included.
    const png = await c.readFile(root, made.value.checkpoint.id, 'images/logo.png');
    expect(png.ok && [...png.value]).toEqual([...PNG]);
    const css = await c.readFile(root, made.value.checkpoint.id, '样式 文件/主 样式.css');
    expect(css.ok && text(css.value)).toBe('h1 { color: red; }');
    // Ignored files were never read into app data.
    const env = await c.readFile(root, made.value.checkpoint.id, '.env');
    expect(env.ok).toBe(false);
    const stored = await Promise.all((await blobs()).map((b) => readFile(path.join(historyDir, 'objects', b), 'utf8')));
    expect(stored.some((s) => s.includes('SECRET') || s.includes('module.exports') || s.includes('[core]'))).toBe(
      false,
    );
  });

  it('reuses the S21 blobs: unchanged files and versions history already keeps are stored once', async () => {
    const h = history();
    const c = checkpoints(h);
    // Local history already keeps index.html's current content.
    await h.snapshot(root, 'index.html', bytes('<h1>你好</h1>'), 'after-save');
    expect(await blobs()).toHaveLength(1);

    const first = await c.create(root, { name: 'one', kind: 'named', cause: 'manual' });
    expect(first.ok).toBe(true);
    expect(await blobs()).toHaveLength(4); // 4 files, index.html's blob shared with history

    await writeFile(path.join(root, 'app.js'), 'console.log(2);');
    clock += 1000;
    const second = await c.create(root, { name: 'two', kind: 'named', cause: 'manual' });
    expect(second.ok).toBe(true);
    expect(await blobs()).toHaveLength(5); // only the changed file was added

    // A checkpoint of the same content in another project shares the blobs too.
    const other = path.join(tmp, 'copy');
    await mkdir(other);
    await writeFile(path.join(other, 'index.html'), '<h1>你好</h1>');
    expect((await c.create(other, { name: 'other', kind: 'named', cause: 'manual' })).ok).toBe(true);
    expect(await blobs()).toHaveLength(5);

    const usage = await c.usage(root);
    expect(usage.named).toBe(2);
    expect(usage.projectBytes).toBe(
      ['<h1>你好</h1>', 'h1 { color: red; }', 'console.log(1);', 'console.log(2);'].reduce(
        (n, s) => n + bytes(s).length,
        0,
      ) + PNG.length,
    );
    expect(usage.totalBytes).toBe(usage.projectBytes);
  });

  it('an automatic checkpoint of an unchanged project is not stored again', async () => {
    const c = checkpoints(history());
    const first = await c.create(root, { name: 'auto', kind: 'auto', cause: 'before-ai' });
    clock += 1000;
    const again = await c.create(root, { name: 'auto', kind: 'auto', cause: 'before-history-restore' });
    if (!first.ok || !again.ok) throw new Error('create failed');
    expect(again.value).toEqual({ checkpoint: first.value.checkpoint, deduped: true });
    // A named checkpoint is always stored: the user asked for it.
    const named = await c.create(root, { name: 'mine', kind: 'named', cause: 'manual' });
    expect(named.ok && named.value.deduped).toBe(false);
  });

  it('lists, renames and deletes; deleting frees blobs nothing else references', async () => {
    const h = history();
    const c = checkpoints(h);
    await h.snapshot(root, 'index.html', bytes('<h1>你好</h1>'), 'after-save');
    const made = await c.create(root, { name: 'a', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    const renamed = await c.rename(root, made.value.checkpoint.id, '  首页   完成 ');
    expect(renamed.ok && renamed.value.name).toBe('首页 完成');
    const listed = await c.list(root);
    expect(listed.ok && listed.value.checkpoints.map((x) => x.name)).toEqual(['首页 完成']);
    // A fresh store (next start of the app) reads the same.
    const reread = await checkpoints(history()).list(root);
    expect(reread.ok && reread.value.checkpoints.map((x) => x.name)).toEqual(['首页 完成']);

    expect(await c.delete(root, made.value.checkpoint.id)).toEqual({ ok: true, value: null });
    // index.html's blob stays: local history still keeps it.
    expect(await blobs()).toEqual([
      `${sha256Hex(bytes('<h1>你好</h1>')).slice(0, 2)}/${sha256Hex(bytes('<h1>你好</h1>'))}`,
    ]);
    const after = await c.list(root);
    expect(after.ok && after.value.checkpoints).toEqual([]);
  });

  it('history limits, cleanup and "clear all history" never delete a checkpoint blob', async () => {
    const h = history({ limits: { maxVersionsPerFile: 1 } });
    const c = checkpoints(h);
    await c.load();
    const made = await c.create(root, { name: 'keep', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    const indexHash = sha256Hex(bytes('<h1>你好</h1>'));
    // History keeps the same content, then evicts it (one version per file): the blob is still the checkpoint's.
    await h.snapshot(root, 'index.html', bytes('<h1>你好</h1>'), 'after-save');
    await h.snapshot(root, 'index.html', bytes('<h1>new</h1>'), 'before-format');
    await expect(stat(blobPath(indexHash))).resolves.toBeTruthy();
    await h.cleanup();
    await expect(stat(blobPath(indexHash))).resolves.toBeTruthy();
    expect((await h.clear()).ok).toBe(true);
    // History is gone, the checkpoint is whole.
    expect((await h.files(root)).ok && (await h.files(root))).toEqual({ ok: true, value: [] });
    const compare = await c.compare(root, made.value.checkpoint.id);
    expect(compare.ok && compare.value.entries.every((e) => e.available)).toBe(true);
    const back = await c.readFile(root, made.value.checkpoint.id, 'index.html');
    expect(back.ok && text(back.value)).toBe('<h1>你好</h1>');
    // History's own blob ("new") went with the clear.
    await expect(stat(blobPath(sha256Hex(bytes('<h1>new</h1>'))))).rejects.toThrow();
  });
});

describe('S56.1 size limits (refused with an explanation, never truncated)', REAL_IO, () => {
  async function refused(limits: NonNullable<CheckpointOptions['limits']>, kind: 'named' | 'auto' = 'named') {
    const c = checkpoints(history(), { limits });
    const result = await c.create(root, { name: 'x', kind, cause: 'manual' });
    return { c, result };
  }

  it('a file over the per-file limit refuses the checkpoint and names the file', async () => {
    await writeFile(path.join(root, 'images', '大 视频.mp4'), new Uint8Array(2048));
    const { c, result } = await refused({ maxFileBytes: 1024 });
    expect(result).toMatchObject({
      ok: false,
      code: 'file-too-large',
      detail: { relPath: 'images/大 视频.mp4', bytes: 2048, limit: 1024 },
    });
    // Nothing was stored: no manifest, no blob.
    expect(await tree(checkpointsDir)).toEqual([]);
    expect(await blobs()).toEqual([]);
    const listed = await c.list(root);
    expect(listed.ok && listed.value.checkpoints).toEqual([]);
  });

  it('too many files, a checkpoint too large, and too many named checkpoints are refused', async () => {
    expect((await refused({ maxFiles: 3 })).result).toMatchObject({ code: 'too-many-files', detail: { limit: 3 } });
    expect((await refused({ maxCheckpointBytes: 20 })).result).toMatchObject({
      code: 'checkpoint-too-large',
      detail: { limit: 20 },
    });
    const c = checkpoints(history(), { limits: { maxNamed: 1 } });
    expect((await c.create(root, { name: 'a', kind: 'named', cause: 'manual' })).ok).toBe(true);
    expect(await c.create(root, { name: 'b', kind: 'named', cause: 'manual' })).toMatchObject({
      code: 'too-many-named',
      detail: { limit: 1 },
    });
    expect(await blobs()).toHaveLength(4);
  });

  it('the storage limit first drops older automatic checkpoints, never named ones, then refuses', async () => {
    const total = (await snapshotTotal()) + 20;
    const c = checkpoints(history(), { limits: { maxTotalBytes: total } });
    const auto = await c.create(root, { name: 'auto', kind: 'auto', cause: 'before-ai' });
    expect(auto.ok).toBe(true);
    // A changed file needs room: the automatic checkpoint makes it.
    await writeFile(path.join(root, 'app.js'), 'console.log("a longer line");');
    clock += 1000;
    const named = await c.create(root, { name: 'named', kind: 'named', cause: 'manual' });
    expect(named.ok).toBe(true);
    let listed = await c.list(root);
    expect(listed.ok && listed.value.checkpoints.map((x) => x.kind)).toEqual(['named']);
    // Now only a named checkpoint is left: the next one that needs room is refused, the named one stays.
    await writeFile(path.join(root, 'index.html'), '<h1>a much longer heading than before</h1>');
    clock += 1000;
    const refusedOne = await c.create(root, { name: 'more', kind: 'auto', cause: 'before-ai' });
    expect(refusedOne).toMatchObject({ ok: false, code: 'storage-full', detail: { limit: total } });
    listed = await c.list(root);
    expect(listed.ok && listed.value.checkpoints.map((x) => x.name)).toEqual(['named']);
    const usage = await c.usage(root);
    expect(usage).toMatchObject({ named: 1, automatic: 0, limits: { maxTotalBytes: total } });
    expect(usage.totalBytes).toBeLessThanOrEqual(total);
  });

  async function snapshotTotal(): Promise<number> {
    let n = 0;
    for (const rel of ['index.html', '样式 文件/主 样式.css', 'app.js', 'images/logo.png']) {
      n += (await stat(path.join(root, rel))).size;
    }
    return n;
  }
});

describe('S56.1 corruption tolerance (fault tests)', REAL_IO, () => {
  it('a damaged blob makes only that file of that checkpoint unavailable, and it is reported', async () => {
    const h = history();
    const c = checkpoints(h);
    const first = await c.create(root, { name: 'one', kind: 'named', cause: 'manual' });
    await writeFile(path.join(root, 'app.js'), 'console.log(2);');
    clock += 1000;
    const second = await c.create(root, { name: 'two', kind: 'named', cause: 'manual' });
    if (!first.ok || !second.ok) throw new Error('setup');
    await h.snapshot(root, 'index.html', bytes('<h1>history</h1>'), 'after-save');
    // Bit rot in the first checkpoint's app.js, and its CSS blob is missing.
    await writeFile(blobPath(sha256Hex(bytes('console.log(1);'))), 'garbage');
    await rm(blobPath(sha256Hex(bytes('h1 { color: red; }'))));
    // The project changed everywhere, so a restore would need every copy.
    await writeFile(path.join(root, 'index.html'), 'broken');
    await writeFile(path.join(root, '样式 文件', '主 样式.css'), 'broken');
    await writeFile(path.join(root, 'images', 'logo.png'), 'broken');
    await writeFile(path.join(root, 'app.js'), 'broken');

    const compare = await c.compare(root, first.value.checkpoint.id);
    if (!compare.ok) throw new Error(compare.code);
    expect(compare.value.entries.map((e) => [e.relPath, e.status, e.available])).toEqual([
      ['app.js', 'changed', false],
      ['images/logo.png', 'changed', true],
      ['index.html', 'changed', true],
      ['样式 文件/主 样式.css', 'changed', false],
    ]);
    expect(logs.some((l) => l.startsWith('checkpoint.files-unavailable {"count":2}'))).toBe(true);
    expect(await c.readFile(root, first.value.checkpoint.id, 'app.js')).toMatchObject({ ok: false, code: 'corrupt' });
    expect(await c.readFile(root, first.value.checkpoint.id, '样式 文件/主 样式.css')).toMatchObject({
      ok: false,
      code: 'missing',
    });
    const index = await c.readFile(root, first.value.checkpoint.id, 'index.html');
    expect(index.ok && text(index.value)).toBe('<h1>你好</h1>');
    // The second checkpoint's own app.js is intact (only the shared CSS blob is gone).
    const other = await c.compare(root, second.value.checkpoint.id);
    expect(other.ok && other.value.entries.filter((e) => !e.available).map((e) => e.relPath)).toEqual([
      '样式 文件/主 样式.css',
    ]);
    // Local history still works.
    const versions = await h.list(root, 'index.html');
    expect(versions.ok && versions.value).toHaveLength(1);
    // Saving a new checkpoint repairs nothing behind the user's back but stores the project as it is now.
    clock += 1000;
    expect((await c.create(root, { name: 'three', kind: 'named', cause: 'manual' })).ok).toBe(true);
  });

  it('a damaged manifest affects only its checkpoint; others and local history keep working', async () => {
    const h = history();
    const c = checkpoints(h);
    const good = await c.create(root, { name: 'good', kind: 'named', cause: 'manual' });
    await writeFile(path.join(root, 'app.js'), 'console.log(2);');
    clock += 1000;
    const bad = await c.create(root, { name: 'bad', kind: 'named', cause: 'manual' });
    if (!good.ok || !bad.ok) throw new Error('setup');
    const badFile = path.join(checkpointsDir, projectKey(root), `${bad.value.checkpoint.id}.json`);
    const raw = await readFile(badFile, 'utf8');
    await writeFile(badFile, raw.slice(0, raw.length - 40)); // truncated by a crash

    const fresh = checkpoints(history());
    const listed = await fresh.list(root);
    expect(listed.ok && listed.value.checkpoints.map((x) => x.name)).toEqual(['good']);
    expect(listed.ok && listed.value.damaged).toEqual([{ id: bad.value.checkpoint.id, reason: 'corrupt' }]);
    expect(await fresh.compare(root, bad.value.checkpoint.id)).toMatchObject({ ok: false, code: 'damaged' });
    expect((await fresh.compare(root, good.value.checkpoint.id)).ok).toBe(true);
    expect(logs.some((l) => l.startsWith('checkpoint.manifest-corrupt'))).toBe(true);
    // Its blobs are kept (the truncated text still names them) until the user deletes it.
    expect(await blobs()).toHaveLength(5);
    expect((await fresh.delete(root, bad.value.checkpoint.id)).ok).toBe(true);
    expect(await blobs()).toHaveLength(4); // only "console.log(2);" was the damaged checkpoint's alone
  });

  it('an unreadable manifest is listed as unreadable and stops history from deleting any blob', async () => {
    const h = history({ limits: { maxVersionsPerFile: 1 } });
    const c = checkpoints(h);
    const made = await c.create(root, { name: 'locked', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    const locked = path.join(checkpointsDir, projectKey(root), `${made.value.checkpoint.id}.json`);
    const h2 = history({ limits: { maxVersionsPerFile: 1 } });
    const c2 = checkpoints(h2, {
      readFile: async (file) => {
        if (file === locked) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return readFile(file);
      },
    });
    const listed = await c2.list(root);
    expect(listed.ok && listed.value.damaged).toEqual([{ id: made.value.checkpoint.id, reason: 'unreadable' }]);
    expect(c2.pins().uncertain).toBe(true);
    // History evicts a version whose blob only the unreadable checkpoint might need: the blob is not deleted.
    await h2.snapshot(root, 'x.html', bytes('one'), 'after-save');
    await h2.snapshot(root, 'x.html', bytes('two'), 'after-save');
    await h2.snapshot(root, 'x.html', bytes('three'), 'before-format');
    await h2.cleanup();
    await expect(stat(blobPath(sha256Hex(bytes('one'))))).resolves.toBeTruthy();
    // And no checkpoint blob went either.
    for (const f of ['console.log(1);', 'h1 { color: red; }']) {
      await expect(stat(blobPath(sha256Hex(bytes(f))))).resolves.toBeTruthy();
    }
  });

  it('a stale temporary manifest from a crash is ignored and removed', async () => {
    const c = checkpoints(history());
    const dir = path.join(checkpointsDir, projectKey(root));
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, '.1700000000000-abcdef01.json.x.noobide-tmp');
    await writeFile(temp, '{');
    const { utimes } = await import('node:fs/promises');
    await utimes(temp, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const listed = await c.list(root);
    expect(listed.ok && listed.value).toEqual({ checkpoints: [], damaged: [] });
    await expect(stat(temp)).rejects.toThrow();
  });
});

describe('S56.1 review follow-ups (2026-10-17)', REAL_IO, () => {
  it('a refused checkpoint never costs an older automatic one', async () => {
    const c = checkpoints(history(), { limits: { maxTotalBytes: 200 } });
    const auto = await c.create(root, { name: 'auto', kind: 'auto', cause: 'before-ai' });
    expect(auto.ok).toBe(true);
    // Far more than even an empty store could hold: refused, and the automatic checkpoint is still there.
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(500));
    clock += 1000;
    expect(await c.create(root, { name: 'n', kind: 'named', cause: 'manual' })).toMatchObject({ code: 'storage-full' });
    const listed = await c.list(root);
    expect(listed.ok && listed.value.checkpoints.map((x) => x.kind)).toEqual(['auto']);
  });

  it('a file changing while the checkpoint is stored refuses it; nothing is kept', async () => {
    const h = history();
    const changing: CheckpointOptions['history'] = {
      setPins: (p) => h.setPins(p),
      withBlobs: async (task) => {
        await writeFile(path.join(root, 'app.js'), 'console.log("changed meanwhile, and much longer");');
        return h.withBlobs(task);
      },
    };
    const c = checkpoints(h, { history: changing });
    await c.load();
    const result = await c.create(root, { name: 'x', kind: 'named', cause: 'manual' });
    expect(result).toMatchObject({ ok: false, code: 'project-changed', detail: { relPath: 'app.js' } });
    expect(await tree(checkpointsDir)).toEqual([]);
    expect(await blobs()).toEqual([]);
  });

  it('a failed manifest write releases only blobs nothing else references', async () => {
    const h = history();
    const c = checkpoints(h);
    await c.load();
    await h.snapshot(root, 'index.html', bytes('<h1>你好</h1>'), 'after-save');
    // The project's manifest folder cannot be created (a file is in the way).
    await mkdir(checkpointsDir, { recursive: true });
    await writeFile(path.join(checkpointsDir, projectKey(root)), 'in the way');
    const result = await c.create(root, { name: 'x', kind: 'named', cause: 'manual' });
    expect(result).toMatchObject({ ok: false, code: 'write-failed' });
    // History's blob stays, the checkpoint's own ones are gone.
    expect(await blobs()).toEqual([
      `${sha256Hex(bytes('<h1>你好</h1>')).slice(0, 2)}/${sha256Hex(bytes('<h1>你好</h1>'))}`,
    ]);
    const versions = await h.list(root, 'index.html');
    expect(versions.ok && versions.value).toHaveLength(1);
  });

  it('history deletes no blob before the checkpoints are loaded', async () => {
    const first = checkpoints(history());
    const made = await first.create(root, { name: 'keep', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    // Next start: history works before the checkpoint store has read its manifests.
    const h = history({ limits: { maxVersionsPerFile: 1 } });
    const c = checkpoints(h);
    expect(c.pins().uncertain).toBe(true);
    await h.snapshot(root, 'index.html', bytes('<h1>你好</h1>'), 'after-save');
    await h.snapshot(root, 'index.html', bytes('other'), 'before-format');
    await h.cleanup();
    await expect(stat(blobPath(sha256Hex(bytes('<h1>你好</h1>'))))).resolves.toBeTruthy();
    await c.load();
    expect(c.pins().uncertain).toBe(false);
  });

  it("clearing one project's history keeps the blobs its checkpoints use", async () => {
    const h = history();
    const c = checkpoints(h);
    await h.snapshot(root, 'index.html', bytes('<h1>你好</h1>'), 'after-save');
    const made = await c.create(root, { name: 'keep', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    expect((await h.clear(root)).ok).toBe(true);
    const back = await c.readFile(root, made.value.checkpoint.id, 'index.html');
    expect(back.ok && text(back.value)).toBe('<h1>你好</h1>');
  });

  it('keeps a marker that older versions read as a newer index naming every checkpoint blob', async () => {
    const h = history();
    const c = checkpoints(h);
    const made = await c.create(root, { name: 'keep', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    const markerFile = path.join(historyDir, 'index', `${LEGACY_PIN_KEY}.json`);
    const marker = JSON.parse(await readFile(markerFile, 'utf8')) as { format: string; v: number; hashes: string[] };
    expect(marker.format).toBe('noobide-history');
    expect(marker.v).toBeGreaterThan(2);
    expect(marker.hashes).toHaveLength(4);
    // This version ignores it: no extra project, no unavailable history.
    expect(await h.projects()).toEqual([]);
    expect((await h.usage()).unavailable).toBe(0);
    // "Clear all history" keeps the marker (the checkpoint still needs those blobs).
    await h.clear();
    expect((JSON.parse(await readFile(markerFile, 'utf8')) as { hashes: string[] }).hashes).toHaveLength(4);
    // Deleting the last checkpoint removes it.
    await c.delete(root, made.value.checkpoint.id);
    await expect(stat(markerFile)).rejects.toThrow();
  });

  it('a crafted manifest path can never name a file outside what the walk produces', async () => {
    for (const bad of [
      '../x.html',
      '.git/hooks/pre-commit',
      '.noobide/project.json',
      'node_modules/a.js',
      'a/./b',
      'C:/x',
      'con.txt',
      'dir./a',
      'a ',
      'a\b',
      '/abs',
      'e\u0301.html', // NFD
    ]) {
      expect(isCheckpointPath(bad), bad).toBe(false);
    }
    expect(isCheckpointPath('样式 文件/主 样式.css')).toBe(true);
    // A name the manifest could not hold is refused when saving, never stored and rejected later.
    await writeFile(path.join(root, 'con.js'), 'x');
    expect(await checkpoints(history()).create(root, { name: 'x', kind: 'named', cause: 'manual' })).toMatchObject({
      ok: false,
      code: 'unsupported-path',
      detail: { relPath: 'con.js' },
    });
    await rm(path.join(root, 'con.js'));

    const c = checkpoints(history());
    const made = await c.create(root, { name: 'x', kind: 'named', cause: 'manual' });
    if (!made.ok) throw new Error(made.code);
    const file = path.join(checkpointsDir, projectKey(root), `${made.value.checkpoint.id}.json`);
    const record = JSON.parse(await readFile(file, 'utf8')) as { files: { path: string }[] };
    (record.files[0] as { path: string }).path = '.git/config';
    await writeFile(file, JSON.stringify(record));
    const listed = await checkpoints(history()).list(root);
    expect(listed.ok && listed.value.damaged).toEqual([{ id: made.value.checkpoint.id, reason: 'corrupt' }]);
  });
});
