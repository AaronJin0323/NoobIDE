import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore } from '../../src/recovery/history';
import { projectKey, sha256Hex } from '../../src/recovery/keys';
import { ProjectService } from '../../src/workspace/project-service';

/** S21.1 integration: the content-addressed snapshot store on the real filesystem, Chinese paths with spaces. */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');
const REL = '子 文件夹/页面 二.html';

let tmp: string;
let root: string;
let historyDir: string;
let clock: number;
let logs: string[];

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

function store(limits = {}) {
  return new SnapshotStore({
    dir: historyDir,
    limits,
    now: () => clock,
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
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

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-history-'));
  await mkdir(path.join(tmp, '网页 练习'), { recursive: true });
  await cp(FIXTURE, path.join(tmp, '网页 练习', '中文 路径 项目'), { recursive: true });
  const opened = await new ProjectService().open(path.join(tmp, '网页 练习', '中文 路径 项目'));
  if (!opened.ok) throw new Error(opened.message);
  root = opened.value.rootPath;
  historyDir = path.join(tmp, 'app data', 'NoobIDE', 'history');
  clock = 1_000_000;
  logs = [];
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('snapshot store (S21.1)', () => {
  it('stores content-addressed blobs and a JSON index in app data, never in the project', async () => {
    const before = await tree(root);
    const s = store();
    const result = await s.snapshot(root, REL, bytes('<p>版本一</p>'), 'before-save');
    expect(result).toMatchObject({ ok: true, value: { deduped: false } });
    expect(await tree(root)).toEqual(before);
    const hash = sha256Hex(bytes('<p>版本一</p>'));
    expect(await tree(historyDir)).toEqual([`index/${projectKey(root)}.json`, `objects/${hash.slice(0, 2)}/${hash}`]);
    const index = JSON.parse(await readFile(path.join(historyDir, 'index', `${projectKey(root)}.json`), 'utf8'));
    expect(index).toMatchObject({ format: 'noobide-history', v: 1, rootPath: root });
    expect(Object.keys(index.files)).toEqual([REL]);
  });

  it('lists versions newest first and reads them back, verified by hash', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('v1'), 'before-save');
    clock += 1000;
    await s.snapshot(root, REL, bytes('v2'), 'after-save');
    const versions = await s.list(root, REL);
    expect(versions.map((v) => v.reason)).toEqual(['after-save', 'before-save']);
    const first = versions[1];
    if (!first) throw new Error('missing version');
    const read = await s.read(root, REL, first.id);
    expect(read.ok && text(read.value)).toBe('v1');
    expect(await s.read(root, REL, 'nope')).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('dedupes: content equal to the newest version adds nothing, equal blobs are stored once', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('same'), 'before-save');
    expect(await s.snapshot(root, REL, bytes('same'), 'after-save')).toMatchObject({ value: { deduped: true } });
    expect(await s.list(root, REL)).toHaveLength(1);
    await s.snapshot(root, 'index.html', bytes('same'), 'before-save');
    const usage = await s.usage();
    expect(usage).toMatchObject({ blobs: 1, files: 2, versions: 2, totalBytes: 4 });
  });

  it('enforces the per-file version and byte limits, oldest first, and reports per-file usage', async () => {
    const s = store({ maxVersionsPerFile: 3, maxBytesPerFile: 1000 });
    for (let i = 1; i <= 5; i += 1) {
      clock += 1000;
      await s.snapshot(root, REL, bytes(`version ${i}`), 'before-save');
    }
    expect((await s.list(root, REL)).length).toBe(3);
    const newest = (await s.list(root, REL))[0];
    expect(newest && (await s.read(root, REL, newest.id))).toMatchObject({ ok: true });
    expect(await s.fileUsage(root, REL)).toEqual({ versions: 3, bytes: 27, maxVersions: 3, maxBytes: 1000 });
    // Unreferenced blobs of dropped versions were deleted.
    expect((await s.usage()).blobs).toBe(3);
    expect((await tree(path.join(historyDir, 'objects'))).length).toBe(3);

    const big = store({ maxBytesPerFile: 25 });
    clock += 1000;
    await big.snapshot(root, 'big.html', bytes('a'.repeat(20)), 'before-save');
    clock += 1000;
    await big.snapshot(root, 'big.html', bytes('b'.repeat(20)), 'before-save');
    expect((await big.list(root, 'big.html')).map((v) => v.size)).toEqual([20]);
  });

  it('enforces the total limit across projects by dropping the globally oldest versions', async () => {
    const s = store({ maxTotalBytes: 100 });
    const other = path.join(tmp, '另一个 项目');
    clock += 1;
    await s.snapshot(other, 'a.html', bytes('o'.repeat(40)), 'before-save');
    clock += 1;
    await s.snapshot(root, REL, bytes('r'.repeat(40)), 'before-save');
    clock += 1;
    await s.snapshot(root, REL, bytes('s'.repeat(40)), 'after-save');
    const usage = await s.usage();
    expect(usage.totalBytes).toBeLessThanOrEqual(100);
    expect(usage.limits.maxTotalBytes).toBe(100);
    expect(await s.list(other, 'a.html')).toHaveLength(0);
    expect(await s.list(root, REL)).toHaveLength(2);
    expect(logs.some((l) => l.startsWith('history.trimmed-total'))).toBe(true);
  });

  it('coalesces rapid after-save versions into one per save batch', async () => {
    const s = store({ coalesceMs: 60_000 });
    await s.snapshot(root, REL, bytes('on disk before'), 'before-save');
    clock += 1000;
    await s.snapshot(root, REL, bytes('autosave 1'), 'after-save');
    clock += 1000;
    await s.snapshot(root, REL, bytes('autosave 1'), 'before-save'); // deduped
    await s.snapshot(root, REL, bytes('autosave 2'), 'after-save'); // replaces autosave 1
    clock += 120_000;
    await s.snapshot(root, REL, bytes('much later'), 'after-save'); // new batch
    const versions = await s.list(root, REL);
    const contents = await Promise.all(versions.map(async (v) => s.read(root, REL, v.id)));
    expect(contents.map((c) => c.ok && text(c.value))).toEqual(['much later', 'autosave 2', 'on disk before']);
  });

  it('skips contents over the snapshot size limit', async () => {
    const s = store({ maxSnapshotBytes: 10 });
    expect(await s.snapshot(root, REL, bytes('x'.repeat(11)), 'before-save')).toMatchObject({
      ok: false,
      code: 'too-large',
    });
    expect(await s.list(root, REL)).toEqual([]);
  });

  it('survives a corrupt index (moved aside, logged) and a corrupt blob (refused, not returned)', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('good'), 'before-save');
    const [meta] = await s.list(root, REL);
    if (!meta) throw new Error('missing version');
    await writeFile(path.join(historyDir, 'objects', meta.hash.slice(0, 2), meta.hash), 'tampered');
    expect(await s.read(root, REL, meta.id)).toMatchObject({ ok: false, code: 'corrupt' });

    await writeFile(path.join(historyDir, 'index', `${projectKey(root)}.json`), '{"format":"noobide-hist');
    expect(await s.list(root, REL)).toEqual([]);
    expect(logs.some((l) => l.startsWith('history.index-corrupt'))).toBe(true);
    expect(await readdir(path.join(historyDir, 'quarantine'))).toHaveLength(1);
    expect(await s.snapshot(root, REL, bytes('after corruption'), 'before-save')).toMatchObject({ ok: true });
  });

  it('a file literally named __proto__ is an ordinary key', async () => {
    const s = store();
    await s.snapshot(root, '__proto__', bytes('p'), 'before-save');
    expect(await s.list(root, '__proto__')).toHaveLength(1);
    expect(await store().files(root)).toEqual(['__proto__']);
  });

  it('cleanup removes unreferenced blobs and temp files; clear removes one project or everything', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('keep'), 'before-save');
    const other = path.join(tmp, '另一个 项目');
    await s.snapshot(other, 'a.html', bytes('other'), 'before-save');
    const orphan = sha256Hex('orphan');
    await mkdir(path.join(historyDir, 'objects', orphan.slice(0, 2)), { recursive: true });
    await writeFile(path.join(historyDir, 'objects', orphan.slice(0, 2), orphan), 'orphan');
    expect(await s.cleanup()).toEqual({ removedBlobs: 1, removedBytes: 6 });

    expect(await s.clear(other)).toEqual({ ok: true, value: null });
    expect(await s.list(other, 'a.html')).toEqual([]);
    expect(await s.list(root, REL)).toHaveLength(1);
    expect((await s.usage()).blobs).toBe(1);
    expect((await tree(path.join(historyDir, 'objects'))).length).toBe(1);

    expect(await s.clear()).toEqual({ ok: true, value: null });
    expect(await tree(historyDir)).toEqual([]);
    expect(await s.usage()).toMatchObject({ totalBytes: 0, versions: 0 });
  });

  it('never logs file contents or user paths', async () => {
    const s = store({ maxSnapshotBytes: 5, maxTotalBytes: 1 });
    await s.snapshot(root, REL, bytes('secret-content-123'), 'before-save');
    await s.snapshot(root, REL, bytes('abc'), 'before-save');
    await writeFile(path.join(historyDir, 'index', `${projectKey(root)}.json`), 'garbage');
    await s.list(root, REL);
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join('\n');
    expect(all).not.toContain('secret-content');
    expect(all).not.toContain('中文');
  });
});
