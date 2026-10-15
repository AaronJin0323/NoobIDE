import { mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryJournal, type JournalTarget } from '../../../src/recovery/journal';
import { fileKey } from '../../../src/recovery/keys';
import { faults, isTempFile, under } from './fault-fs';

vi.mock('node:fs/promises', async (importOriginal) => (await import('./fault-fs')).faultyFs(await importOriginal()));

/**
 * S26.1 fault suite — the crash-recovery journal (PLAN §6, §11 "recovery after forced termination"). The journal is
 * the safety net for unsaved text, so its own failures must never destroy a copy it already holds: disk full, a
 * locked or unreadable record, a crash in the middle of writing, damaged records. Logs carry codes, never text.
 */
const BUF = '11111111-2222-4333-8444-555555555555';
const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const TEXT = (n: number) => `<p>未保存的第 ${n} 版 secret-${n}</p>`;

let tmp: string;
let dir: string;
let target: JournalTarget;
let logs: string[];
let journals: RecoveryJournal[];

const open = () => {
  const journal = new RecoveryJournal({ dir, log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`) });
  journals.push(journal);
  return journal;
};
const snap = (revision: number, bufferId = BUF) => ({ bufferId, revision, text: TEXT(revision), bom: false });
const inJournal = (p: string) => under(() => dir)(p) && !isTempFile(p) && p.endsWith('.json');

async function files(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else out.push(path.relative(dir, path.join(d, e.name)));
    }
  };
  await walk(dir);
  return out.sort();
}

/** What a restarted app offers to recover. */
async function offered(): Promise<string[]> {
  const next = open();
  const texts: string[] = [];
  for (const project of await next.listPending()) {
    for (const file of project.files) {
      const entry = await next.read({ rootPath: project.rootPath, relPath: file.relPath }, file.bufferId);
      if (entry.ok) texts.push(entry.value.text);
    }
  }
  return texts.sort();
}

beforeEach(async () => {
  faults.reset();
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-journal-faults-')));
  dir = path.join(tmp, 'app data', 'NoobIDE', 'recovery');
  target = { rootPath: path.join(tmp, '网页 练习', '我的 网页'), relPath: '子 文件夹/页面 二.html' };
  logs = [];
  journals = [];
});

afterEach(async () => {
  faults.reset();
  for (const j of journals) await j.usage().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

describe('S26.1 recovery journal faults', () => {
  it.each(['ENOSPC', 'EDQUOT', 'EACCES', 'EIO'])(
    'a %s while recording keeps the previous copy intact and leaves no temp file',
    async (code) => {
      const journal = open();
      await journal.record(target, snap(1));
      faults.add({ op: 'write', code, where: isTempFile });
      expect(await journal.record(target, snap(2))).toMatchObject({ ok: false, code: 'write-failed', message: code });
      faults.restart();
      expect(await journal.read(target, BUF)).toMatchObject({ ok: true, value: { revision: 1, text: TEXT(1) } });
      expect((await files()).filter(isTempFile)).toEqual([]);
      // Once there is space again the next debounced record goes through.
      expect(await journal.record(target, snap(2))).toMatchObject({ ok: true, value: { written: true } });
      expect(logs.join('\n')).not.toContain('secret');
    },
  );

  it('the process dies mid-record: the previous copy is offered after restart; the stale leftover is removed', async () => {
    const journal = open();
    await journal.record(target, snap(1));
    faults.add({ op: 'write', crash: true, where: isTempFile });
    await journal.record(target, snap(2)).catch(() => undefined);
    expect(faults.crashed).toBe(true);
    faults.restart();
    const leftovers = (await files()).filter(isTempFile);
    expect(leftovers).toHaveLength(1);
    const old = new Date(Date.now() - 10 * 60_000);
    for (const rel of leftovers) await utimes(path.join(dir, rel), old, old);
    expect(await offered()).toEqual([TEXT(1)]);
    expect((await files()).filter(isTempFile)).toEqual([]);
  });

  it('dying while the directory is created leaves nothing half-made that blocks the next run', async () => {
    const journal = open();
    faults.add({ op: 'mkdir', crash: true });
    await journal.record(target, snap(1)).catch(() => undefined);
    faults.restart();
    const next = open();
    expect(await next.record(target, snap(1, OTHER))).toMatchObject({ ok: true });
  });

  it('a record that cannot be read right now (locked by a scanner) is skipped, kept, and offered later', async () => {
    const journal = open();
    await journal.record(target, snap(3));
    faults.add({ op: 'readFile', code: 'EBUSY', where: inJournal });
    expect(await offered()).toEqual([]);
    faults.restart();
    expect(await offered()).toEqual([TEXT(3)]);
    expect(logs.join('\n')).not.toContain('secret');
  });

  it('damaged records are quarantined, never offered as text, and the healthy ones are still offered', async () => {
    const journal = open();
    await journal.record(target, snap(1));
    await journal.record({ ...target, relPath: 'index.html' }, snap(2, OTHER));
    const [damaged] = (await files()).filter((f) => f.includes(BUF));
    if (!damaged) throw new Error('record missing');
    const full = path.join(dir, damaged);
    await writeFile(full, (await readFile(full, 'utf8')).slice(0, 40)); // torn by a power cut
    expect(await offered()).toEqual([TEXT(2)]);
    expect((await files()).some((f) => f.startsWith('quarantine'))).toBe(true);
  });

  it('a tampered record whose relPath leaves the project is quarantined, never offered (decision 0033)', async () => {
    const journal = open();
    await journal.record(target, snap(1));
    await journal.record({ ...target, relPath: 'index.html' }, snap(2, OTHER));
    const [tampered] = (await files()).filter((f) => f.includes(BUF));
    if (!tampered) throw new Error('record missing');
    const full = path.join(dir, tampered);
    const record = JSON.parse(await readFile(full, 'utf8')) as { relPath: string; bufferId: string };
    // A consistent forgery: the file name matches the escaping relPath, so only the record check can refuse it.
    const escaping = '../../别处/secret.txt';
    await rm(full);
    await writeFile(
      path.join(path.dirname(full), `${fileKey(escaping)}-${record.bufferId}.json`),
      JSON.stringify({ ...record, relPath: escaping }),
    );
    expect(await offered()).toEqual([TEXT(2)]);
    expect((await files()).some((f) => f.startsWith('quarantine'))).toBe(true);
  });

  it('a discard that fails (record locked) keeps the record; it is offered again rather than lost', async () => {
    const journal = open();
    await journal.record(target, snap(4));
    faults.add({ op: 'rm', code: 'EPERM', where: inJournal });
    expect(await journal.discardSaved(target, BUF, 4)).toEqual({ ok: true, value: { removed: false } });
    faults.restart();
    expect(await offered()).toEqual([TEXT(4)]);
  });

  it('newer edits journaled during a save survive a discard that cannot read the record (bug found by S26.1)', async () => {
    const journal = open();
    // Revision 5 was typed while revision 4 was being saved.
    await journal.record(target, snap(5));
    faults.add({ op: 'readFile', code: 'EBUSY', where: inJournal });
    faults.add({ op: 'stat', code: 'EBUSY', where: inJournal });
    await journal.discardSaved(target, BUF, 4);
    faults.restart();
    expect(await offered()).toEqual([TEXT(5)]);
  });

  it('an unreadable journal folder never throws at startup; nothing is offered and nothing is deleted', async () => {
    const journal = open();
    await journal.record(target, snap(1));
    faults.add({ op: 'readdir', code: 'EACCES', where: under(() => dir) });
    expect(await open().listPending()).toEqual([]);
    faults.restart();
    expect(await offered()).toEqual([TEXT(1)]);
    expect(logs.some((l) => l.startsWith('recovery.scan-failed'))).toBe(true);
  });
});
