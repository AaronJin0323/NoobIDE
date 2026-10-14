import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toIpcResult } from '../../../src/shared/ipc/contract';
import { RecoveryJournal } from '../../../src/recovery/journal';
import { SnapshotStore } from '../../../src/recovery/history';
import { HistoryTriggers } from '../../../src/recovery/history-triggers';
import { ProjectService } from '../../../src/workspace/project-service';
import { DocumentSaver } from '../../../src/renderer/workbench/save-controller';
import { saveStatus } from '../../../src/renderer/workbench/save-machine';
import { faults, isTempFile, under, type Fault } from './fault-fs';

vi.mock('node:fs/promises', async (importOriginal) => (await import('./fault-fs')).faultyFs(await importOriginal()));

/**
 * S26.1 fault suite — the save pipeline (PLAN §7, §11 "failed saves", "read-only directories", "recovery after forced
 * termination"). Wired like the app: the editor's DocumentSaver writes through ProjectService (atomic temp + rename,
 * S11.1 version check, S21 local history) and journals unsaved text to the recovery journal in app data, which is
 * discarded only after a confirmed save. Every fault must end with: the editor still has the text, the file on disk
 * is exactly the old or exactly the new version, no temp file is left, the recovery copy still exists, and a retry
 * after the cause is gone saves the kept text. Paths contain Chinese characters and spaces.
 */
const ORIGINAL = '<h1>原来的标题</h1>\n<p>旧内容</p>\n';
const EDITED = '<h1>新的标题</h1>\n<p>用户刚刚输入的内容，一个字也不能丢。</p>\n';
const REL = '页面 一.html';
const BUFFER = '0f0e0d0c-0b0a-4908-8706-050403020100';

let tmp: string;
let root: string;
let appData: string;
/** Background work (history snapshots, journal discards) of every run, drained before the temp folder goes. */
let idle: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  faults.reset();
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-faults-')));
  root = path.join(tmp, '网页 练习', '我的 第一个 网页');
  appData = path.join(tmp, 'app data', 'NoobIDE');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, REL), ORIGINAL);
});

afterEach(async () => {
  faults.reset();
  for (const wait of idle) await wait().catch(() => undefined);
  idle = [];
  await chmod(root, 0o755).catch(() => undefined);
  await chmod(path.join(root, REL), 0o644).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

/** One "app run": services in main, a saver in the renderer, the journal wiring of Workbench + JournalScheduler. */
async function launch() {
  const journal = new RecoveryJournal({ dir: path.join(appData, 'recovery') });
  const store = new SnapshotStore({ dir: path.join(appData, 'history') });
  const triggers = new HistoryTriggers(store);
  const service = new ProjectService({
    history: triggers,
    atomic: { renameBackoffMs: [1, 1, 1], sleep: async () => undefined },
  });
  idle.push(
    () => triggers.whenIdle(),
    () => store.idle(),
    () => journal.listPending(),
  );
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.code);
  const { projectId, rootPath } = opened.value;
  const read = await service.read({ projectId, relPath: REL });
  if (!read.ok) throw new Error(read.code);
  let known = read.value.version.hash;
  const target = { rootPath, relPath: REL };
  const saver = new DocumentSaver({
    initialText: read.value.text,
    autosave: false,
    write: async (text) => {
      const result = toIpcResult(
        await service.write({ projectId, relPath: REL, text, bom: false, expectedHash: known }),
      );
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      known = result.value.version.hash;
      return { ok: true };
    },
  });
  const refreshed: number[] = [];
  saver.onSaved(({ revision }) => {
    refreshed.push(revision);
    void journal.discardSaved(target, BUFFER, revision);
  });
  /** Types text and journals it, as the debounced JournalScheduler does before any save. */
  const type = async (text: string) => {
    saver.edit(text);
    const recorded = await journal.record(target, {
      bufferId: BUFFER,
      revision: saver.state.revision,
      text,
      bom: false,
    });
    expect(recorded.ok).toBe(true);
  };
  return { journal, store, triggers, service, saver, refreshed, type, target };
}

const onDisk = () => readFile(path.join(root, REL), 'utf8');
const tempFiles = async () => (await readdir(root)).filter((name) => name.endsWith('.noobide-tmp'));
const inProject = under(() => root);

/** This run's own journal record (a live buffer is not "pending" until the next start). */
async function ownCopy(app: { journal: RecoveryJournal; target: { rootPath: string; relPath: string } }) {
  const entry = await app.journal.read(app.target, BUFFER);
  return entry.ok ? [entry.value.text] : [];
}

/** What the next start offers to recover. */
async function recoveryCopies(journal: RecoveryJournal): Promise<string[]> {
  const texts: string[] = [];
  for (const project of await journal.listPending()) {
    for (const file of project.files) {
      const entry = await journal.read({ rootPath: project.rootPath, relPath: file.relPath }, file.bufferId);
      if (entry.ok) texts.push(entry.value.text);
    }
  }
  return texts;
}

type Scenario = readonly [name: string, arm: () => Fault[] | Promise<Fault[]>, code: string];

const projectTemp = (target: string) => isTempFile(target) && inProject(target);
const projectFile = (target: string) => target === path.join(root, REL);

const scenarios: Scenario[] = [
  [
    'disk full while writing the temp file (ENOSPC)',
    () => [{ op: 'write', code: 'ENOSPC', where: projectTemp }],
    'disk-full',
  ],
  ['disk quota exceeded (EDQUOT)', () => [{ op: 'write', code: 'EDQUOT', where: projectTemp }], 'disk-full'],
  [
    'disk full while flushing (ENOSPC on fsync)',
    () => [{ op: 'sync', code: 'ENOSPC', where: projectTemp }],
    'disk-full',
  ],
  [
    'permission denied creating the temp file (read-only folder, EACCES)',
    () => [{ op: 'open', flags: 'wx', code: 'EACCES', where: projectTemp }],
    'permission-denied',
  ],
  [
    'read-only volume (EROFS)',
    () => [{ op: 'open', flags: 'wx', code: 'EROFS', where: projectTemp }],
    'permission-denied',
  ],
  [
    'file locked by another program through every retry (EBUSY)',
    () => [{ op: 'rename', code: 'EBUSY', where: projectTemp }],
    'busy',
  ],
  [
    'file held open without delete sharing on Windows (EPERM rename, every retry)',
    () => [{ op: 'rename', code: 'EPERM', where: projectTemp }],
    'busy',
  ],
  ['rename fails with an I/O error (EIO)', () => [{ op: 'rename', code: 'EIO', where: projectTemp }], 'write-failed'],
  [
    'rename across devices refused (EXDEV)',
    () => [{ op: 'rename', code: 'EXDEV', where: projectTemp }],
    'write-failed',
  ],
  ['fsync fails (EIO)', () => [{ op: 'sync', code: 'EIO', where: projectTemp }], 'write-failed'],
  ['closing the temp file fails (EIO)', () => [{ op: 'close', code: 'EIO', where: projectTemp }], 'write-failed'],
  [
    'the current file cannot be read for the version check (EIO)',
    () => [{ op: 'readFile', code: 'EIO', where: projectFile }],
    'write-failed',
  ],
  [
    'the file is busy when it is checked (EBUSY on stat)',
    () => [{ op: 'stat', code: 'EBUSY', where: projectFile }],
    'busy',
  ],
];

describe('S26.1 save faults: the edits are never lost', () => {
  it.each(scenarios)('%s', async (_name, arm, code) => {
    const app = await launch();
    await app.type(EDITED);
    for (const fault of await arm()) faults.add(fault);

    expect(await app.saver.save()).toBe(false);
    expect(faults.fired.length).toBeGreaterThan(0);
    faults.restart();

    expect(saveStatus(app.saver.state)).toBe('failed');
    expect(app.saver.state.error?.code).toBe(code);
    // The message is an error code, never file contents.
    expect(app.saver.state.error?.message).not.toContain('标题');
    expect(app.saver.text).toBe(EDITED);
    expect(await onDisk()).toBe(ORIGINAL);
    expect(await tempFiles()).toEqual([]);
    expect(app.refreshed).toEqual([]);
    expect(await ownCopy(app)).toEqual([EDITED]);

    // The cause is gone: retry writes exactly the kept text and only then drops the recovery copy.
    expect(await app.saver.save()).toBe(true);
    expect(await onDisk()).toBe(EDITED);
    expect(saveStatus(app.saver.state)).toBe('saved');
    expect(app.refreshed).toHaveLength(1);
    await app.journal.listPending(); // waits for the queued discard
    expect(await ownCopy(app)).toEqual([]);
  });

  it('a lock that clears during the retries (Windows antivirus scan) saves without bothering the user', async () => {
    const app = await launch();
    await app.type(EDITED);
    faults.add({ op: 'rename', code: 'EPERM', where: projectTemp, times: 2 });
    expect(await app.saver.save()).toBe(true);
    expect(faults.fired).toHaveLength(2);
    expect(await onDisk()).toBe(EDITED);
    expect(await tempFiles()).toEqual([]);
  });

  it('a failing local history (disk full in app data) never fails or blocks the save', async () => {
    const app = await launch();
    await app.type(EDITED);
    faults.add({ op: 'open', code: 'ENOSPC', where: under(() => path.join(appData, 'history')) });
    faults.add({ op: 'mkdir', code: 'ENOSPC', where: under(() => path.join(appData, 'history')) });
    expect(await app.saver.save()).toBe(true);
    await app.triggers.whenIdle();
    faults.restart();
    expect(await onDisk()).toBe(EDITED);
  });

  it('a failing recovery journal never blocks saving; the save itself is the safe copy', async () => {
    const app = await launch();
    faults.add({ op: 'mkdir', code: 'EACCES', where: under(() => path.join(appData, 'recovery')) });
    faults.add({ op: 'open', code: 'EACCES', where: under(() => path.join(appData, 'recovery')) });
    app.saver.edit(EDITED);
    const recorded = await app.journal.record(app.target, {
      bufferId: BUFFER,
      revision: app.saver.state.revision,
      text: EDITED,
      bom: false,
    });
    expect(recorded).toMatchObject({ ok: false, code: 'write-failed', message: 'EACCES' });
    expect(await app.saver.save()).toBe(true);
    faults.restart();
    expect(await onDisk()).toBe(EDITED);
  });

  it('read-only file on the real file system → permission-denied, edits kept, then saved after the fix', async () => {
    await chmod(path.join(root, REL), 0o444);
    const app = await launch();
    await app.type(EDITED);
    expect(await app.saver.save()).toBe(false);
    expect(app.saver.state.error?.code).toBe('permission-denied');
    expect(await onDisk()).toBe(ORIGINAL);
    await chmod(path.join(root, REL), 0o644);
    expect(await app.saver.save()).toBe(true);
    expect(await onDisk()).toBe(EDITED);
  });

  it.skipIf(path.sep !== '/' || process.getuid?.() === 0)(
    'read-only folder on the real file system (POSIX) → permission-denied, edits kept',
    async () => {
      const app = await launch();
      await app.type(EDITED);
      await chmod(root, 0o555);
      expect(await app.saver.save()).toBe(false);
      expect(app.saver.state.error?.code).toBe('permission-denied');
      expect(app.saver.text).toBe(EDITED);
      await chmod(root, 0o755);
      expect(await onDisk()).toBe(ORIGINAL);
      expect(await tempFiles()).toEqual([]);
      expect(await ownCopy(app)).toEqual([EDITED]);
    },
  );

  it('an external edit landing during the save is never overwritten (S11.1), and the edits stay', async () => {
    const app = await launch();
    await app.type(EDITED);
    const external = '<p>另一个程序写入的内容</p>\n';
    // Another program writes the file while NoobIDE is saving it.
    const service = app.service;
    const original = service.write.bind(service);
    service.write = async (request) => {
      const pending = original(request);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await writeFile(path.join(root, REL), external);
      return pending;
    };
    expect(await app.saver.save()).toBe(false);
    expect(app.saver.state.error?.code).toBe('changed-on-disk');
    expect(await onDisk()).toBe(external);
    expect(app.saver.text).toBe(EDITED);
    expect(await tempFiles()).toEqual([]);
    expect(await ownCopy(app)).toEqual([EDITED]);
  });
});

describe('S26.1 forced termination in the middle of a save', () => {
  it.each([
    ['while the temp file is half written', { op: 'write', crash: true, where: projectTemp }],
    ['after the temp file was flushed, right before the rename', { op: 'rename', crash: true, where: projectTemp }],
  ] satisfies [string, Fault][])(
    '%s: the file is the old version, the recovery copy is offered after restart',
    async (_name, fault) => {
      const first = await launch();
      await first.type(EDITED);
      faults.add(fault);
      await first.saver.save();
      expect(faults.crashed).toBe(true);
      faults.restart();

      // Whatever happened, the target is complete: the old text, never half of the new one.
      expect(await onDisk()).toBe(ORIGINAL);
      expect(await tempFiles()).toHaveLength(1);

      // The next run offers the journaled edits.
      const second = await launch();
      expect(await recoveryCopies(second.journal)).toEqual([EDITED]);
      // Restoring and saving writes them and removes the crash leftovers of this file.
      second.saver.restore(EDITED);
      expect(await second.saver.save()).toBe(true);
      expect(await onDisk()).toBe(EDITED);
      expect(await tempFiles()).toEqual([]);
    },
  );

  it('the journal itself dies mid-write: the previous recovery copy survives and the leftover is cleaned up', async () => {
    const first = await launch();
    await first.type('<p>第一版，已经记下</p>');
    faults.add({ op: 'write', crash: true, where: (p) => isTempFile(p) && under(() => appData)(p) });
    first.saver.edit(EDITED);
    await first.journal
      .record(first.target, { bufferId: BUFFER, revision: first.saver.state.revision, text: EDITED, bom: false })
      .catch(() => undefined);
    expect(faults.crashed).toBe(true);
    faults.restart();

    // Age the leftover past the "maybe another process is writing it" window.
    const recoveryDir = path.join(appData, 'recovery');
    const leftovers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (isTempFile(full)) leftovers.push(full);
      }
    };
    await walk(recoveryDir);
    expect(leftovers).toHaveLength(1);
    const old = new Date(Date.now() - 10 * 60_000);
    for (const file of leftovers) await utimes(file, old, old);

    const second = await launch();
    expect(await recoveryCopies(second.journal)).toEqual(['<p>第一版，已经记下</p>']);
    const after: string[] = [];
    leftovers.length = 0;
    await walk(recoveryDir);
    after.push(...leftovers);
    expect(after).toEqual([]);
    expect(await onDisk()).toBe(ORIGINAL);
  });
});
