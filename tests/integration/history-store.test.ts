import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SnapshotStore, type HistoryOptions, type SnapshotMeta } from '../../src/recovery/history';
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

function store(limits: HistoryOptions['limits'] = {}, extra: Partial<HistoryOptions> = {}) {
  return new SnapshotStore({
    dir: historyDir,
    limits,
    now: () => clock,
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
    retryDelayMs: 1,
    ...extra,
  });
}

async function versions(s: SnapshotStore, rootPath: string, rel: string): Promise<SnapshotMeta[]> {
  const result = await s.list(rootPath, rel);
  if (!result.ok) throw new Error(`history unavailable: ${result.message}`);
  return result.value;
}

async function texts(s: SnapshotStore, rootPath: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const v of await versions(s, rootPath, rel)) {
    const data = await s.read(rootPath, rel, v.id);
    out.push(data.ok ? text(data.value) : `<${data.code}>`);
  }
  return out;
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

const indexFile = (rootPath: string) => path.join(historyDir, 'index', `${projectKey(rootPath)}.json`);
const blobFile = (hash: string) => path.join(historyDir, 'objects', hash.slice(0, 2), hash);

/** A read failure for one file, as a virus scanner or indexer holding it on Windows would cause. */
function lockedRead(file: () => string, code = 'EBUSY', times = Infinity) {
  let failures = 0;
  return async (f: string) => {
    if (f === file() && failures < times) {
      failures += 1;
      throw Object.assign(new Error(`${code}: resource busy or locked`), { code });
    }
    return readFile(f);
  };
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
    const index = JSON.parse(await readFile(indexFile(root), 'utf8'));
    expect(index).toMatchObject({ format: 'noobide-history', v: 1, rootPath: root });
    expect(Object.keys(index.files)).toEqual([REL]);
  });

  it('lists versions newest first and reads them back, verified by hash', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('v1'), 'before-save');
    clock += 1000;
    await s.snapshot(root, REL, bytes('v2'), 'after-save');
    expect((await versions(s, root, REL)).map((v) => v.reason)).toEqual(['after-save', 'before-save']);
    expect(await texts(store(), root, REL)).toEqual(['v2', 'v1']); // a fresh instance reads the same from disk
    expect(await s.read(root, REL, 'nope')).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('keys file names in Unicode NFC (macOS may report NFD names)', async () => {
    const s = store();
    const nfd = '子 文件夹/café.html'.normalize('NFD');
    await s.snapshot(root, nfd, bytes('x'), 'before-save');
    expect(await versions(s, root, '子 文件夹/café.html'.normalize('NFC'))).toHaveLength(1);
  });

  it('dedupes: content equal to the newest version adds nothing, equal blobs are stored once', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('same'), 'before-save');
    expect(await s.snapshot(root, REL, bytes('same'), 'after-save')).toMatchObject({ value: { deduped: true } });
    expect(await versions(s, root, REL)).toHaveLength(1);
    await s.snapshot(root, 'index.html', bytes('same'), 'before-save');
    expect(await s.usage()).toMatchObject({ blobs: 1, files: 2, versions: 2, totalBytes: 4 });
  });

  it('enforces the per-file version and byte limits, oldest first, and reports per-file usage', async () => {
    const s = store({ maxVersionsPerFile: 3, maxBytesPerFile: 1000 });
    for (let i = 1; i <= 5; i += 1) {
      clock += 1000;
      await s.snapshot(root, REL, bytes(`version ${i}`), 'before-save');
    }
    expect(await texts(s, root, REL)).toEqual(['version 5', 'version 4', 'version 3']);
    expect(await s.fileUsage(root, REL)).toEqual({ versions: 3, bytes: 27, maxVersions: 3, maxBytes: 1000 });
    expect((await tree(path.join(historyDir, 'objects'))).length).toBe(3); // dropped versions' blobs deleted

    const big = store({ maxBytesPerFile: 25 });
    await big.snapshot(root, 'big.html', bytes('a'.repeat(20)), 'before-save');
    await big.snapshot(root, 'big.html', bytes('b'.repeat(20)), 'before-save');
    expect((await versions(big, root, 'big.html')).map((v) => v.size)).toEqual([20]);
  });

  it("enforces the total limit by sequence (not the wall clock) and keeps every file's newest version", async () => {
    const s = store({ maxTotalBytes: 100 });
    const other = path.join(tmp, '另一个 项目');
    await s.snapshot(other, 'a.html', bytes('o'.repeat(30)), 'before-save');
    clock -= 500_000; // the system clock jumps backwards: "oldest" must still mean "stored first"
    await s.snapshot(other, 'a.html', bytes('p'.repeat(30)), 'before-save');
    await s.snapshot(root, REL, bytes('r'.repeat(30)), 'before-save');
    await s.snapshot(root, REL, bytes('s'.repeat(30)), 'after-save');
    const usage = await s.usage();
    expect(usage.totalBytes).toBeLessThanOrEqual(100);
    expect(await texts(s, other, 'a.html')).toEqual(['p'.repeat(30)]);
    expect(await texts(s, root, REL)).toEqual(['s'.repeat(30), 'r'.repeat(30)]);
    // Only newest versions left: nothing more is evicted even if they alone exceed the limit.
    await s.snapshot(root, 'c.html', bytes('c'.repeat(90)), 'before-save');
    expect(await versions(s, other, 'a.html')).toHaveLength(1);
    expect(await versions(s, root, 'c.html')).toHaveLength(1);
    expect(logs.some((l) => l.startsWith('history.trimmed-total'))).toBe(true);
  });

  it('coalesces a save burst, but a long session keeps one version per window', async () => {
    const s = store({ coalesceMs: 60_000, maxVersionsPerFile: 500 });
    await s.snapshot(root, REL, bytes('on disk before'), 'before-save');
    for (let i = 1; i <= 5; i += 1) {
      clock += 1000;
      await s.snapshot(root, REL, bytes(`burst ${i}`), 'after-save');
    }
    expect(await texts(s, root, REL)).toEqual(['burst 5', 'on disk before']);

    // Saving every 30 s for an hour (120 saves): the window does not slide, so ~one version per minute survives.
    for (let i = 1; i <= 120; i += 1) {
      clock += 30_000;
      await s.snapshot(root, REL, bytes(`minute ${i / 2}`), 'after-save');
    }
    const kept = await versions(s, root, REL);
    expect(kept.length).toBeGreaterThanOrEqual(60);
    expect(kept.length).toBeLessThanOrEqual(63);
  }, 30_000); // 125 atomic snapshot writes: a correctness check, not a speed check (slow on CI Windows disks).

  it('skips contents over the snapshot size limit and clamps inconsistent limits', async () => {
    const s = store({ maxSnapshotBytes: 10 });
    expect(await s.snapshot(root, REL, bytes('x'.repeat(11)), 'before-save')).toMatchObject({ code: 'too-large' });
    expect(await versions(s, root, REL)).toEqual([]);
    const odd = store({ maxSnapshotBytes: 1000, maxTotalBytes: 50, maxVersionsPerFile: -3, coalesceMs: Number.NaN });
    expect(odd.limits.maxSnapshotBytes).toBe(50);
    expect(odd.limits.maxVersionsPerFile).toBe(50);
    expect(odd.limits.coalesceMs).toBe(60_000);
  });

  it('a file literally named __proto__ is an ordinary key', async () => {
    const s = store();
    await s.snapshot(root, '__proto__', bytes('p'), 'before-save');
    expect(await versions(s, root, '__proto__')).toHaveLength(1);
    expect(await store().files(root)).toEqual({ ok: true, value: ['__proto__'] });
  });

  it('cleanup removes orphan blobs and caps the quarantine; usage reports on-disk bytes; clear works', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('keep'), 'before-save');
    const other = path.join(tmp, '另一个 项目');
    await s.snapshot(other, 'a.html', bytes('other'), 'before-save');
    const orphan = sha256Hex('orphan');
    await mkdir(path.dirname(blobFile(orphan)), { recursive: true });
    await writeFile(blobFile(orphan), 'orphan');
    expect(await s.cleanup()).toEqual({ removedBlobs: 1, removedBytes: 6 });
    const usage = await s.usage();
    expect(usage.onDiskBytes).toBeGreaterThan(usage.totalBytes);

    expect(await s.clear(other)).toEqual({ ok: true, value: null });
    expect(await versions(s, other, 'a.html')).toEqual([]);
    expect(await versions(s, root, REL)).toHaveLength(1);
    expect((await tree(path.join(historyDir, 'objects'))).length).toBe(1);

    expect(await s.clear()).toEqual({ ok: true, value: null });
    expect(await tree(historyDir)).toEqual([]);
    expect(await s.usage()).toMatchObject({ totalBytes: 0, versions: 0, onDiskBytes: 0 });
  });

  it('never logs file contents or user paths', async () => {
    const s = store({ maxSnapshotBytes: 5, maxTotalBytes: 6 });
    await s.snapshot(root, REL, bytes('secret-content-123'), 'before-save');
    await s.snapshot(root, REL, bytes('abc'), 'before-save');
    await s.snapshot(root, REL, bytes('abcd'), 'before-save');
    await writeFile(indexFile(root), 'garbage secret-content');
    await store().list(root, REL);
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join('\n');
    expect(all).not.toContain('secret-content');
    expect(all).not.toContain('中文');
  });
});

describe('history is never lost to read errors or damage (S21.1 review)', () => {
  async function fiveVersions(s: SnapshotStore) {
    for (let i = 1; i <= 5; i += 1) {
      clock += 120_000;
      await s.snapshot(root, REL, bytes(`saved ${i}`), 'after-save');
    }
  }

  it('a locked index is not treated as empty: the snapshot fails and nothing is overwritten', async () => {
    await fiveVersions(store());
    const onDisk = await readFile(indexFile(root), 'utf8');
    const locked = store({}, { readFile: lockedRead(() => indexFile(root)) });
    const result = await locked.snapshot(root, REL, bytes('while locked'), 'after-save');
    expect(result).toMatchObject({ ok: false, code: 'write-failed' });
    expect(await locked.list(root, REL)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await readFile(indexFile(root), 'utf8')).toBe(onDisk);
    expect((await locked.usage()).unavailable).toBe(1);
    expect(logs.some((l) => l.startsWith('history.index-unreadable'))).toBe(true);
    expect(await texts(store(), root, REL)).toEqual(['saved 5', 'saved 4', 'saved 3', 'saved 2', 'saved 1']);
  });

  it("a locked index's blobs are not garbage-collected by other projects' trimming or by cleanup", async () => {
    await fiveVersions(store());
    const objectsBefore = await tree(path.join(historyDir, 'objects'));
    const locked = store({ maxVersionsPerFile: 1 }, { readFile: lockedRead(() => indexFile(root)) });
    const other = path.join(tmp, '另一个 项目');
    await locked.snapshot(other, 'a.html', bytes('one'), 'before-save');
    await locked.snapshot(other, 'a.html', bytes('two'), 'before-save'); // trims "one"
    expect(await locked.cleanup()).toEqual({ removedBlobs: 0, removedBytes: 0 });
    const objectsAfter = await tree(path.join(historyDir, 'objects'));
    for (const blob of objectsBefore) expect(objectsAfter).toContain(blob);
    expect(await texts(store(), root, REL)).toHaveLength(5);
  });

  it('a transient lock is retried and the snapshot keeps the existing versions', async () => {
    await fiveVersions(store());
    const flaky = store({}, { readFile: lockedRead(() => indexFile(root), 'EPERM', 1) });
    clock += 120_000;
    expect(await flaky.snapshot(root, REL, bytes('saved 6'), 'after-save')).toMatchObject({ ok: true });
    expect(await texts(store(), root, REL)).toHaveLength(6);
  });

  it('one damaged entry is dropped; the other versions stay readable', async () => {
    await fiveVersions(store());
    const index = JSON.parse(await readFile(indexFile(root), 'utf8'));
    index.files[REL][1] = { id: 'broken', hash: 'not-a-hash', size: -1 };
    await writeFile(indexFile(root), JSON.stringify(index));
    expect(await texts(store(), root, REL)).toEqual(['saved 5', 'saved 4', 'saved 3', 'saved 1']);
    expect(logs.some((l) => l.startsWith('history.entries-dropped'))).toBe(true);
  });

  it('an index from a newer NoobIDE is left untouched and its blobs survive', async () => {
    await fiveVersions(store());
    const index = JSON.parse(await readFile(indexFile(root), 'utf8'));
    index.v = 3;
    const newer = JSON.stringify(index);
    await writeFile(indexFile(root), newer);
    const s = store({ maxTotalBytes: 10 });
    expect(await s.snapshot(root, REL, bytes('old app'), 'after-save')).toMatchObject({ ok: false });
    await s.snapshot(path.join(tmp, '另一个 项目'), 'a.html', bytes('xx'), 'before-save');
    await s.cleanup();
    expect(await readFile(indexFile(root), 'utf8')).toBe(newer);
    for (const meta of index.files[REL]) expect(await readFile(blobFile(meta.hash), 'utf8')).toMatch(/^saved /);
  });

  it('an unparseable index is quarantined, its blobs survive cleanup until history is cleared', async () => {
    await fiveVersions(store());
    const hashes = (await tree(path.join(historyDir, 'objects'))).map((f) => f.split('/')[1] ?? '');
    const raw = await readFile(indexFile(root), 'utf8');
    await writeFile(indexFile(root), raw.slice(0, Math.floor(raw.length * 0.7))); // truncated JSON
    const s = store();
    expect(await versions(s, root, REL)).toEqual([]);
    expect(logs.some((l) => l.startsWith('history.index-corrupt'))).toBe(true);
    expect(await s.cleanup()).toEqual({ removedBlobs: 0, removedBytes: 0 });
    const q = await readdir(path.join(historyDir, 'quarantine'));
    expect(q).toHaveLength(1);
    expect(await readFile(path.join(historyDir, 'quarantine', q[0] ?? ''), 'utf8')).toBe(
      raw.slice(0, Math.floor(raw.length * 0.7)),
    );
    // Every version's content is still on disk and intact (recoverable from the quarantined index).
    for (const hash of hashes) expect(sha256Hex(await readFile(blobFile(hash)))).toBe(hash);
    expect((await s.usage()).quarantined).toBe(1);
    await s.snapshot(root, REL, bytes('after corruption'), 'before-save');
    expect(await texts(s, root, REL)).toEqual(['after corruption']);
  });

  it('the quarantine is capped and reported; no blob is deleted while damaged indexes are kept', async () => {
    const s = store({ maxQuarantined: 1 });
    for (let i = 0; i < 3; i += 1) {
      const project = path.join(tmp, `项目 ${i}`);
      await s.snapshot(project, 'a.html', bytes(`content ${i}`), 'before-save');
      await writeFile(indexFile(project), '{"format":"noobide-history",');
    }
    const fresh = store({ maxQuarantined: 1 });
    await fresh.cleanup();
    expect(await readdir(path.join(historyDir, 'quarantine'))).toHaveLength(1);
    expect((await fresh.usage()).quarantined).toBe(1);
    expect((await tree(path.join(historyDir, 'objects'))).length).toBe(3);
    expect(logs.some((l) => l.startsWith('history.gc-deferred'))).toBe(true);
  });

  it('a bit-flipped blob is detected on read and repaired by the next snapshot of the same content', async () => {
    const s = store();
    await s.snapshot(root, REL, bytes('good content'), 'before-save');
    const [meta] = await versions(s, root, REL);
    if (!meta) throw new Error('missing version');
    await writeFile(blobFile(meta.hash), 'gooD content');
    expect(await s.read(root, REL, meta.id)).toMatchObject({ ok: false, code: 'corrupt' });
    await s.snapshot(root, 'index.html', bytes('good content'), 'before-save');
    expect(await texts(s, root, REL)).toEqual(['good content']);
    expect(logs.some((l) => l.startsWith('history.blob-repaired'))).toBe(true);
  });
});
