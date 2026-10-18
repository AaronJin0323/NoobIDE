import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryJournal, type JournalTarget } from '../../src/recovery/journal';
import { fileKey, projectKey } from '../../src/recovery/keys';
import { ProjectService } from '../../src/workspace/project-service';

/**
 * S12.1 / S12.3 integration: the crash-recovery journal on the real filesystem, with a project whose path has
 * Chinese characters and spaces. The journal directory stands in for `<userData>/recovery`.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');
const BUF_A = '11111111-2222-4333-8444-555555555555';
const BUF_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const SECRET = '<p>未保存的秘密内容 unsaved-secret-text</p>';

let tmp: string;
let root: string;
let journalDir: string;
let logs: { event: string; fields: Record<string, unknown> }[];
let journal: RecoveryJournal;
let target: JournalTarget;

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

function newJournal(limits = {}) {
  return new RecoveryJournal({
    dir: journalDir,
    limits,
    log: (event, fields) => logs.push({ event, fields: { ...fields } }),
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-journal-'));
  const projectParent = path.join(tmp, '网页 练习');
  await mkdir(projectParent, { recursive: true });
  await cp(FIXTURE, path.join(projectParent, '中文 路径 项目'), { recursive: true });
  // The journal stores the project's real path, exactly as ProjectService resolves it.
  const opened = await new ProjectService().open(path.join(projectParent, '中文 路径 项目'));
  if (!opened.ok) throw new Error(opened.message);
  root = opened.value.rootPath;
  journalDir = path.join(tmp, 'app data', 'NoobIDE', 'recovery');
  logs = [];
  journal = newJournal();
  target = { rootPath: root, relPath: '子 文件夹/页面 二.html' };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const snapshot = (revision: number, text = SECRET, bufferId = BUF_A) => ({ bufferId, revision, text, bom: false });

describe('recovery journal in app data (S12.1)', () => {
  it('writes a record outside the project and leaves the project folder untouched', async () => {
    const before = await tree(root);
    expect(await journal.record(target, snapshot(1))).toEqual({ ok: true, value: { written: true } });
    expect(await tree(root)).toEqual(before);
    const files = await tree(journalDir);
    expect(files).toEqual([`${projectKey(root)}/${fileKey(target.relPath)}-${BUF_A}.json`]);
    // Hashed file names: neither the user's path nor the file name appears in app-data names.
    expect(files[0]).not.toContain('中文');
    const read = await journal.read(target, BUF_A);
    expect(read).toMatchObject({ ok: true, value: { text: SECRET, revision: 1, relPath: target.relPath } });
  });

  it('replaces the record atomically: no temporary files remain and the newest revision wins', async () => {
    for (let r = 1; r <= 5; r += 1) await journal.record(target, snapshot(r, `${SECRET} v${r}`));
    expect(await tree(journalDir)).toHaveLength(1);
    expect(await journal.read(target, BUF_A)).toMatchObject({ value: { text: `${SECRET} v5`, revision: 5 } });
  });

  it('drops writes that arrive out of order', async () => {
    await journal.record(target, snapshot(4, 'newer'));
    expect(await journal.record(target, snapshot(3, 'older'))).toEqual({ ok: true, value: { written: false } });
    expect(await journal.read(target, BUF_A)).toMatchObject({ value: { text: 'newer' } });
  });

  it('an interrupted write (temp file left by a crash) keeps the previous record and is cleaned up', async () => {
    await journal.record(target, snapshot(1));
    const dir = path.join(journalDir, projectKey(root));
    const stale = path.join(dir, `.${fileKey(target.relPath)}-${BUF_A}.json.dead.noobide-tmp`);
    await writeFile(stale, '{"format":"noob');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);
    // A fresh temp file may belong to a write in flight in another process: it is left alone.
    const fresh = path.join(dir, `.${fileKey('index.html')}-${BUF_B}.json.live.noobide-tmp`);
    await writeFile(fresh, '{"format":"noob');
    const restarted = newJournal();
    const pending = await restarted.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.files[0]).toMatchObject({ relPath: target.relPath, bufferId: BUF_A, revision: 1 });
    expect((await readdir(dir)).sort()).toEqual(
      [path.basename(fresh), `${fileKey(target.relPath)}-${BUF_A}.json`].sort(),
    );
  });

  it('is removed after a successful save of the journaled revision', async () => {
    await journal.record(target, snapshot(3));
    expect(await journal.discardSaved(target, BUF_A, 3)).toEqual({ ok: true, value: { removed: true } });
    expect(await tree(journalDir)).toEqual([]);
    // A debounced write of an already saved revision arriving late does not resurrect the record.
    expect(await journal.record(target, snapshot(3))).toEqual({ ok: true, value: { written: false } });
    expect(await tree(journalDir)).toEqual([]);
  });

  it('keeps the record when newer edits were journaled while the save ran', async () => {
    await journal.record(target, snapshot(5, 'typed during save'));
    expect(await journal.discardSaved(target, BUF_A, 4)).toEqual({ ok: true, value: { removed: false } });
    expect(await journal.read(target, BUF_A)).toMatchObject({ value: { text: 'typed during save' } });
  });

  it("never overwrites another buffer's copy of the same file (a postponed crash copy survives)", async () => {
    await journal.record(target, snapshot(7, 'crash copy', BUF_A));
    const nextRun = newJournal();
    await nextRun.record(target, snapshot(1, 'new edits', BUF_B));
    await nextRun.discardSaved(target, BUF_B, 1);
    expect(await nextRun.read(target, BUF_A)).toMatchObject({ value: { text: 'crash copy' } });
    expect(await nextRun.listPending()).toMatchObject([{ files: [{ bufferId: BUF_A }] }]);
  });

  it('lists records of earlier runs only, grouped by project', async () => {
    await journal.record(target, snapshot(1));
    await journal.record({ rootPath: root, relPath: 'index.html' }, snapshot(2, 'x', BUF_B));
    expect(await journal.listPending()).toEqual([]); // this run's own live buffers are not "left over"
    const pending = await newJournal().listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.key).toBe(projectKey(root));
    expect(pending[0]?.rootPath).toBe(root);
    expect(pending[0]?.files.map((f) => f.relPath).sort()).toEqual(['index.html', '子 文件夹/页面 二.html']);
    expect(await newJournal().rootOfPending(projectKey(root))).toBe(root);
    expect(await newJournal().rootOfPending('../../etc')).toBeUndefined();
  });

  it('the user can discard a recovered copy', async () => {
    await journal.record(target, snapshot(1));
    const nextRun = newJournal();
    expect(await nextRun.discard(target, BUF_A)).toEqual({ ok: true, value: { removed: true } });
    expect(await nextRun.listPending()).toEqual([]);
  });

  it('S52.1: a rename that only changes Unicode normalisation keeps the record (it is already in place)', async () => {
    // macOS hands out NFD names; the tab knows the file as NFC. The record's new place is its old place, so writing
    // it there and then removing the "old" record would delete the only copy of the unsaved edits.
    const nfc = { rootPath: root, relPath: 'café.html' };
    await journal.record(nfc, snapshot(4, 'unsaved café edits'));
    expect(await journal.movePath(root, 'café.html', 'café.html')).toEqual({ ok: true, value: { moved: 0 } });
    expect(await journal.read(nfc, BUF_A)).toMatchObject({ ok: true, value: { text: 'unsaved café edits' } });
    expect(await newJournal().listPending()).toMatchObject([{ files: [{ relPath: 'café.html', bufferId: BUF_A }] }]);
  });

  it('S52.1: a moved file keeps its record under the new path', async () => {
    await journal.record(target, snapshot(2, 'moved edits'));
    const moved = await journal.movePath(root, '子 文件夹', '新 文件夹');
    expect(moved).toEqual({ ok: true, value: { moved: 1 } });
    const to = { rootPath: root, relPath: '新 文件夹/页面 二.html' };
    expect(await journal.read(to, BUF_A)).toMatchObject({ ok: true, value: { text: 'moved edits' } });
    expect(await journal.read(target, BUF_A)).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('never logs buffer text or user paths', async () => {
    await journal.record(target, snapshot(1));
    await writeFile(path.join(journalDir, projectKey(root), `${fileKey('x')}-${BUF_B}.json`), `{"text":"${SECRET}"`);
    await newJournal({ maxEntryBytes: 10 }).record(target, snapshot(2));
    await newJournal().listPending();
    expect(logs.length).toBeGreaterThan(0);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('unsaved-secret-text');
    expect(logged).not.toContain('中文');
    expect(logged).not.toContain(root);
  });
});

describe('bounded, corruption-tolerant journal (S12.3)', () => {
  it('refuses a record larger than the per-entry limit without touching the previous one', async () => {
    const small = newJournal({ maxEntryBytes: 2048 });
    await small.record(target, snapshot(1, 'short'));
    const result = await small.record(target, snapshot(2, 'x'.repeat(4096)));
    expect(result).toMatchObject({ ok: false, code: 'too-large' });
    expect(await small.read(target, BUF_A)).toMatchObject({ value: { text: 'short' } });
  });

  it('refuses new records beyond the total size and entry-count limits, and reports usage', async () => {
    const bounded = newJournal({ maxTotalBytes: 3000, maxEntries: 2 });
    expect(await bounded.record({ rootPath: root, relPath: 'a.html' }, snapshot(1, 'a'.repeat(1000)))).toMatchObject({
      ok: true,
    });
    expect(
      await bounded.record({ rootPath: root, relPath: 'b.html' }, snapshot(1, 'b'.repeat(2500), BUF_B)),
    ).toMatchObject({ ok: false, code: 'quota-exceeded' });
    expect(await bounded.record({ rootPath: root, relPath: 'b.html' }, snapshot(1, 'b', BUF_B))).toMatchObject({
      ok: true,
    });
    const third = '33333333-3333-4333-8333-333333333333';
    expect(await bounded.record({ rootPath: root, relPath: 'c.html' }, snapshot(1, 'c', third))).toMatchObject({
      ok: false,
      code: 'quota-exceeded',
    });
    const usage = await bounded.usage();
    expect(usage.entries).toBe(2);
    expect(usage.bytes).toBeGreaterThan(1000);
    expect(usage.bytes).toBeLessThanOrEqual(3000);
    expect(usage.limits.maxTotalBytes).toBe(3000);
    expect(logs.filter((l) => l.event === 'recovery.record-refused')).toHaveLength(2);
  });

  it.each([
    ['truncated JSON', (good: string) => good.slice(0, good.length / 2)],
    ['garbage bytes', () => '\u0000ÿ\u0001garbage'],
    ['an empty file', () => ''],
    ['a wrong schema', () => JSON.stringify({ format: 'noobide-recovery', v: 1, text: 1 })],
    ['a checksum mismatch', (good: string) => good.replace('未保存', '已篡改')],
  ])('skips %s, logs it, quarantines it and still lists the good records', async (_name, corrupt) => {
    await journal.record(target, snapshot(1));
    const other = { rootPath: root, relPath: 'index.html' };
    await journal.record(other, snapshot(1, SECRET, BUF_B));
    const badFile = path.join(journalDir, projectKey(root), `${fileKey(other.relPath)}-${BUF_B}.json`);
    await writeFile(badFile, corrupt(await readFile(badFile, 'utf8')));

    const restarted = newJournal();
    const pending = await restarted.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.files.map((f) => f.relPath)).toEqual([target.relPath]);
    expect(logs.find((l) => l.event === 'recovery.entry-skipped')).toBeDefined();
    expect(await readdir(path.join(journalDir, 'quarantine'))).toHaveLength(1);
    expect(await restarted.read(other, BUF_B)).toMatchObject({ ok: false, code: 'not-found' });
    expect((await restarted.usage()).entries).toBe(1);
  });

  it('S28.4: a record written by a newer NoobIDE is skipped and left in place, byte for byte (downgrade)', async () => {
    await journal.record(target, snapshot(1));
    const other = { rootPath: root, relPath: 'index.html' };
    await journal.record(other, snapshot(1, SECRET, BUF_B));
    const newerFile = path.join(journalDir, projectKey(root), `${fileKey(other.relPath)}-${BUF_B}.json`);
    const newer = (await readFile(newerFile, 'utf8')).replace('"v":1', '"v":2');
    await writeFile(newerFile, newer);

    const older = newJournal();
    const pending = await older.listPending();
    expect(pending[0]?.files.map((f) => f.relPath)).toEqual([target.relPath]);
    expect(logs.some((l) => l.event === 'recovery.entry-skipped' && l.fields.reason === 'newer')).toBe(true);
    expect(await readFile(newerFile, 'utf8')).toBe(newer);
    await expect(readdir(path.join(journalDir, 'quarantine'))).rejects.toThrow();
    // Saving the same buffer in the older version never removes the newer copy; it is still counted.
    expect(await older.discardSaved(other, BUF_B, 5)).toEqual({ ok: true, value: { removed: false } });
    expect(await readFile(newerFile, 'utf8')).toBe(newer);
    expect((await older.usage()).entries).toBe(2);
  });

  it('records over a lowered size limit are skipped but kept in place, not quarantined', async () => {
    await journal.record(target, snapshot(1, 'x'.repeat(5000)));
    const strict = newJournal({ maxEntryBytes: 1000 });
    expect(await strict.listPending()).toEqual([]);
    expect(logs.some((l) => l.event === 'recovery.entry-skipped' && l.fields.reason === 'too-large')).toBe(true);
    await expect(readdir(path.join(journalDir, 'quarantine'))).rejects.toThrow();
    expect(await newJournal().listPending()).toHaveLength(1);
  });

  it('a record moved to another file name is not trusted', async () => {
    await journal.record(target, snapshot(1));
    const dir = path.join(journalDir, projectKey(root));
    const good = path.join(dir, `${fileKey(target.relPath)}-${BUF_A}.json`);
    await writeFile(path.join(dir, `${fileKey('index.html')}-${BUF_B}.json`), await readFile(good));
    const pending = await newJournal().listPending();
    expect(pending[0]?.files).toHaveLength(1);
    expect(logs.some((l) => l.event === 'recovery.entry-skipped' && l.fields.reason === 'misplaced')).toBe(true);
  });

  it('keeps the quarantine bounded', async () => {
    const dir = path.join(journalDir, projectKey(root));
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const id = `${i}${i}${i}${i}${i}${i}${i}${i}-0000-4000-8000-000000000000`;
      await writeFile(path.join(dir, `${fileKey('x')}-${id}.json`), '{broken');
    }
    await newJournal({ maxQuarantined: 2 }).listPending();
    expect(await readdir(path.join(journalDir, 'quarantine'))).toHaveLength(2);
  });

  it('survives an unreadable or missing journal directory', async () => {
    expect(await journal.listPending()).toEqual([]);
    await mkdir(path.dirname(journalDir), { recursive: true });
    await writeFile(journalDir, 'not a directory');
    const broken = newJournal();
    expect(await broken.listPending()).toEqual([]);
    expect(await broken.record(target, snapshot(1))).toMatchObject({ ok: false, code: 'write-failed' });
  });

  it('clear-data control removes every record and the quarantine', async () => {
    await journal.record(target, snapshot(1));
    await mkdir(path.join(journalDir, 'quarantine'), { recursive: true });
    await writeFile(path.join(journalDir, 'quarantine', 'old.json'), 'x');
    expect(await journal.clearAll()).toEqual({ ok: true, value: null });
    expect(await tree(journalDir)).toEqual([]);
    expect(await journal.usage()).toMatchObject({ bytes: 0, entries: 0 });
    expect(await newJournal().listPending()).toEqual([]);
    // Editing continues to be protected after a clear.
    expect(await journal.record(target, snapshot(2))).toMatchObject({ ok: true, value: { written: true } });
  });
});
