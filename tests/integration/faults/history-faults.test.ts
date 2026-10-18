import { mkdtemp, readdir, readFile, realpath, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from '../real-io';
import { SnapshotStore } from '../../../src/recovery/history';
import { faults, isTempFile, under } from './fault-fs';

vi.mock('node:fs/promises', async (importOriginal) => (await import('./fault-fs')).faultyFs(await importOriginal()));

/**
 * S26.1 fault suite — local history (PLAN §6). History is a safety net: when its own storage fails (disk full, locked
 * or damaged index, a crash mid-write) the versions it already holds must stay readable, and it must never overwrite
 * an index it could not read.
 */
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const REL = '样式/主 样式.css';

let tmp: string;
let dir: string;
let root: string;
let clock: number;
let stores: SnapshotStore[];

const open = () => {
  const store = new SnapshotStore({ dir, now: () => (clock += 60_000), retryDelayMs: 1 });
  stores.push(store);
  return store;
};

async function versions(store: SnapshotStore): Promise<string[]> {
  const list = await store.list(root, REL);
  if (!list.ok) return [`<${list.code}>`];
  const out: string[] = [];
  for (const meta of list.value) {
    const data = await store.read(root, REL, meta.id);
    out.push(data.ok ? decode(data.value) : `<${data.code}>`);
  }
  return out;
}

async function tempFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (isTempFile(full)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

beforeEach(async () => {
  faults.reset();
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-history-faults-')));
  dir = path.join(tmp, 'app data', 'NoobIDE', 'history');
  root = path.join(tmp, '网页 练习', '我的 网页');
  clock = 1_000_000;
  stores = [];
}, REAL_IO.timeout);

afterEach(async () => {
  faults.reset();
  for (const s of stores) await s.idle().catch(() => undefined);
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const indexFile = (p: string) => under(() => path.join(dir, 'index'))(p);
const blobFile = (p: string) => under(() => path.join(dir, 'objects'))(p);

describe('S26.1 local history faults', REAL_IO, () => {
  it.each([
    ['disk full writing the version (ENOSPC on the blob)', blobFile, 'ENOSPC'],
    ['disk full writing the index (ENOSPC)', indexFile, 'ENOSPC'],
    ['permission denied in app data (EACCES)', (p: string) => under(() => dir)(p), 'EACCES'],
  ] as const)('%s: earlier versions stay readable, no temp file, later snapshots work', async (_n, where, code) => {
    const store = open();
    await store.snapshot(root, REL, encode('a { color: red; }'), 'before-save');
    faults.add({ op: 'open', code, where: (p) => isTempFile(p) && where(p) });
    expect(await store.snapshot(root, REL, encode('a { color: blue; }'), 'after-save')).toMatchObject({
      ok: false,
      code: 'write-failed',
    });
    faults.restart();
    expect(await versions(store)).toEqual(['a { color: red; }']);
    expect(await tempFiles()).toEqual([]);
    expect(await store.snapshot(root, REL, encode('a { color: green; }'), 'after-save')).toMatchObject({ ok: true });
    expect(await versions(open())).toEqual(['a { color: green; }', 'a { color: red; }']);
  });

  it('the process dies while the index is written: the old index is intact after restart', async () => {
    const store = open();
    await store.snapshot(root, REL, encode('v1'), 'before-save');
    await store.snapshot(root, REL, encode('v2'), 'after-save');
    faults.add({ op: 'write', crash: true, where: (p) => isTempFile(p) && indexFile(p) });
    await store.snapshot(root, REL, encode('v3'), 'before-format').catch(() => undefined);
    expect(faults.crashed).toBe(true);
    faults.restart();
    const leftovers = await tempFiles();
    expect(leftovers).toHaveLength(1);
    const old = new Date(Date.now() - 10 * 60_000);
    for (const file of leftovers) await utimes(file, old, old);
    const restarted = open();
    expect(await versions(restarted)).toEqual(['v2', 'v1']);
    expect(await restarted.snapshot(root, REL, encode('v4'), 'after-save')).toMatchObject({ ok: true });
    expect(await tempFiles()).toEqual([]);
  });

  it('a briefly locked index (Windows scanner, EBUSY) is retried and read', async () => {
    const store = open();
    await store.snapshot(root, REL, encode('kept'), 'before-save');
    faults.add({ op: 'readFile', code: 'EBUSY', where: indexFile, times: 2 });
    expect(await versions(open())).toEqual(['kept']);
  });

  it('an index that stays unreadable is reported unavailable and never overwritten', async () => {
    const store = open();
    await store.snapshot(root, REL, encode('old version'), 'before-save');
    faults.add({ op: 'readFile', code: 'EACCES', where: indexFile });
    const blocked = open();
    expect(await blocked.list(root, REL)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await blocked.snapshot(root, REL, encode('new'), 'after-save')).toMatchObject({
      ok: false,
      code: 'write-failed',
    });
    faults.restart();
    expect(await versions(open())).toEqual(['old version']);
  });

  it('a torn index is quarantined, its versions are never deleted, and new versions are recorded', async () => {
    const store = open();
    await store.snapshot(root, REL, encode('before the power cut'), 'before-save');
    await store.idle();
    const [name] = await readdir(path.join(dir, 'index'));
    if (!name) throw new Error('index missing');
    const file = path.join(dir, 'index', name);
    await writeFile(file, (await readFile(file, 'utf8')).slice(0, 60));
    const restarted = open();
    expect(await restarted.snapshot(root, REL, encode('after'), 'after-save')).toMatchObject({ ok: true });
    expect(await versions(restarted)).toEqual(['after']);
    expect(await readdir(path.join(dir, 'quarantine'))).toHaveLength(1);
    // The old blob is still there (protected while a quarantined index may reference it).
    const cleaned = await restarted.cleanup();
    expect(cleaned.removedBlobs).toBe(0);
  });
});
