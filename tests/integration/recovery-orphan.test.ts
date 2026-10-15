import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRecoveryHandlers } from '../../src/main/recovery-ipc';
import { RecoveryJournal } from '../../src/recovery/journal';
import { fileKey, projectKey } from '../../src/recovery/keys';
import { CHANNELS } from '../../src/shared/ipc/contract';
import { ProjectService } from '../../src/workspace/project-service';

/**
 * Decision 0033 integration: crash copies stay reachable after the project folder was moved or renamed (or its
 * drive letter changed). Real journal, real ProjectService, real filesystem; paths with Chinese characters and
 * spaces. The handlers are registered with a `handle` that applies each channel's payload parser, like ipc.ts.
 */
const BUF_A = '0b4e7c5e-6a43-4f7e-9d7e-1c2b3a4d5e6f';
const BUF_B = '1c5f8d6f-7b54-4a8f-8e8f-2d3c4b5e6f70';
const UNSAVED = '<p>一个小时没保存的工作 unsaved work</p>\n';

type Result = { ok: boolean; code?: string; value?: unknown };
type Handler = (payload: unknown, event: IpcMainInvokeEvent) => Promise<Result>;

let tmp: string;
let oldRoot: string;
let newRoot: string;
let journalDir: string;
let saveAnswer: string | null;
let folderAnswer: string | null;
let opened: ReturnType<typeof vi.fn<(projectId: string, root: string, sender: unknown) => void>>;

const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

/** A fresh "next run": new journal and project service over the same app-data directory. */
function nextRun() {
  const handlers = new Map<string, Handler>();
  const journal = new RecoveryJournal({ dir: journalDir });
  const projects = new ProjectService();
  opened = vi.fn();
  registerRecoveryHandlers(
    (channel, parse, run) =>
      void handlers.set(channel, async (payload, e) => {
        const parsed = parse(payload);
        if (parsed === null) return { ok: false, code: 'invalid-request' };
        return (await run(parsed, e)) as Result;
      }),
    projects,
    journal,
    opened,
    {
      chooseFolder: async () => folderAnswer,
      chooseSaveFile: async (_e, fileName) => (saveAnswer === null ? null : path.join(saveAnswer, fileName)),
    },
  );
  const call = (channel: string, payload?: unknown) => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(payload, event);
  };
  return { call, journal, projects };
}

async function journalFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(journalDir).catch(() => [] as string[])) {
    if (d === 'quarantine') continue;
    for (const name of await readdir(path.join(journalDir, d)).catch(() => [] as string[])) out.push(`${d}/${name}`);
  }
  return out;
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-orphan-')));
  oldRoot = path.join(tmp, '网页 练习', '我的 网站');
  newRoot = path.join(tmp, '移动 之后', '我的 网站 2');
  await mkdir(path.join(oldRoot, '子 文件夹'), { recursive: true });
  await mkdir(path.dirname(newRoot), { recursive: true });
  await writeFile(path.join(oldRoot, 'index.html'), '<p>old</p>\n');
  await writeFile(path.join(oldRoot, '子 文件夹', '页面 二.html'), '<p>二</p>\n');
  journalDir = path.join(tmp, '应用 数据', 'recovery');
  saveAnswer = path.join(tmp, '备份 文件夹');
  await mkdir(saveAnswer);
  folderAnswer = newRoot;
  // The run that crashed: two unsaved buffers of the project.
  const crashed = new RecoveryJournal({ dir: journalDir });
  await crashed.record(
    { rootPath: oldRoot, relPath: 'index.html' },
    { bufferId: BUF_A, revision: 3, text: UNSAVED, bom: true },
  );
  await crashed.record(
    { rootPath: oldRoot, relPath: '子 文件夹/页面 二.html' },
    { bufferId: BUF_B, revision: 7, text: '<p>二 改过</p>\n', bom: false },
  );
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('copies of a project whose folder was moved (decision 0033)', () => {
  it('the old channels fail; the copies are still readable, savable and discardable by key', async () => {
    await rename(oldRoot, newRoot);
    const { call } = nextRun();
    const pending = (await call(CHANNELS.recoveryListPending)) as {
      value: { projects: { key: string; files: { bufferId: string }[] }[] };
    };
    const [project] = pending.value.projects;
    if (!project) throw new Error('no pending project');
    expect(project.key).toBe(projectKey(oldRoot));
    expect(project.files).toHaveLength(2);
    // This is the defect: reopening fails, so the old read path is out of reach.
    expect(await call(CHANNELS.recoveryOpenProject, { key: project.key })).toMatchObject({ ok: false });

    // Read without an open project.
    expect(await call(CHANNELS.recoveryReadPending, { key: project.key, bufferId: BUF_A })).toEqual({
      ok: true,
      value: {
        relPath: 'index.html',
        bufferId: BUF_A,
        revision: 3,
        updatedAt: expect.any(Number),
        text: UNSAVED,
        bom: true,
      },
    });

    // "Save as…": main asks for the destination, writes atomically (BOM kept), and the copy is emptied.
    expect(await call(CHANNELS.recoverySavePendingAs, { key: project.key, bufferId: BUF_A })).toEqual({
      ok: true,
      value: { path: path.join(saveAnswer ?? '', 'index.html'), removed: true },
    });
    const saved = await readFile(path.join(saveAnswer ?? '', 'index.html'));
    expect(saved.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(saved.subarray(3).toString('utf8')).toBe(UNSAVED);
    expect(await readdir(saveAnswer ?? '')).toEqual(['index.html']); // no temp file left behind
    expect(await call(CHANNELS.recoveryReadPending, { key: project.key, bufferId: BUF_A })).toMatchObject({
      ok: false,
      code: 'not-found',
    });

    // A cancelled save dialog writes nothing and keeps the copy.
    saveAnswer = null;
    expect(await call(CHANNELS.recoverySavePendingAs, { key: project.key, bufferId: BUF_B })).toEqual({
      ok: true,
      value: null,
    });
    expect(await journalFiles()).toHaveLength(1);

    // Discard the other one: nothing is left, and the moved project was never touched.
    expect(await call(CHANNELS.recoveryDiscardPending, { key: project.key, bufferId: BUF_B })).toEqual({
      ok: true,
      value: { removed: true },
    });
    expect(await journalFiles()).toEqual([]);
    expect((await call(CHANNELS.recoveryListPending)) as { value: { projects: unknown[] } }).toMatchObject({
      value: { projects: [] },
    });
    expect(await readFile(path.join(newRoot, 'index.html'), 'utf8')).toBe('<p>old</p>\n');
  });

  it('a failed save keeps the copy', async () => {
    await rename(oldRoot, newRoot);
    saveAnswer = path.join(tmp, 'does not exist');
    const { call } = nextRun();
    const key = projectKey(oldRoot);
    expect(await call(CHANNELS.recoverySavePendingAs, { key, bufferId: BUF_A })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    expect(await journalFiles()).toHaveLength(2);
  });

  it('choosing the new location re-targets every copy and opens the project for the normal review', async () => {
    await rename(oldRoot, newRoot);
    const { call, journal } = nextRun();
    const key = projectKey(oldRoot);
    const result = (await call(CHANNELS.recoveryRelocate, { key })) as {
      ok: boolean;
      value: { status: string; project: { projectId: string; rootPath: string } };
    };
    expect(result).toMatchObject({ ok: true, value: { status: 'opened', project: { rootPath: newRoot } } });
    expect(opened).toHaveBeenCalledWith(result.value.project.projectId, newRoot, event.sender);
    // The copies now belong to the new folder: listed under its key, nothing left under the old one.
    const pending = await journal.listPending();
    expect(pending.map((p) => p.key)).toEqual([projectKey(newRoot)]);
    expect(pending[0]?.files.map((f) => f.bufferId).sort()).toEqual([BUF_A, BUF_B].sort());
    expect((await journalFiles()).every((f) => f.startsWith(projectKey(newRoot)))).toBe(true);
    // The normal review works through the opened project: recovered text plus the file on disk to compare with.
    const read = await call(CHANNELS.recoveryRead, {
      projectId: result.value.project.projectId,
      relPath: '子 文件夹/页面 二.html',
      bufferId: BUF_B,
    });
    expect(read).toMatchObject({ ok: true, value: { text: '<p>二 改过</p>\n', disk: { text: '<p>二</p>\n' } } });
  });

  it('a folder without the recovered files needs a confirmation; the choice stays in main', async () => {
    const elsewhere = path.join(tmp, '别的 文件夹');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'index.html'), '<p>其他</p>\n');
    await rm(oldRoot, { recursive: true });
    folderAnswer = elsewhere;
    const { call, journal } = nextRun();
    const key = projectKey(oldRoot);
    const asked = (await call(CHANNELS.recoveryRelocate, { key })) as {
      ok: boolean;
      value: { status: string; choiceId: string; folderName: string; missing: string[] };
    };
    expect(asked).toMatchObject({
      ok: true,
      value: { status: 'confirm', folderName: '别的 文件夹', missing: ['子 文件夹/页面 二.html'] },
    });
    expect(opened).not.toHaveBeenCalled();
    expect((await journal.listPending()).map((p) => p.key)).toEqual([key]); // nothing moved yet
    // A choice is bound to its key and used once.
    expect(
      await call(CHANNELS.recoveryRelocateConfirm, { key: 'f'.repeat(32), choiceId: asked.value.choiceId }),
    ).toMatchObject({ ok: false, code: 'expired' });
    expect(await call(CHANNELS.recoveryRelocateConfirm, { key, choiceId: asked.value.choiceId })).toMatchObject({
      ok: true,
      value: { status: 'opened', project: { rootPath: elsewhere } },
    });
    expect((await journal.listPending()).map((p) => p.key)).toEqual([projectKey(elsewhere)]);
    expect(await call(CHANNELS.recoveryRelocateConfirm, { key, choiceId: asked.value.choiceId })).toMatchObject({
      ok: false,
      code: 'expired',
    });
  });

  it('a cancelled folder dialog moves nothing', async () => {
    await rename(oldRoot, newRoot);
    folderAnswer = null;
    const { call, journal } = nextRun();
    const key = projectKey(oldRoot);
    expect(await call(CHANNELS.recoveryRelocate, { key })).toEqual({ ok: true, value: { status: 'cancelled' } });
    expect((await journal.listPending()).map((p) => p.key)).toEqual([key]);
  });
});

describe('journal re-target (decision 0033)', () => {
  it('keeps the newer revision when the new folder already has a copy of the same buffer', async () => {
    await rename(oldRoot, newRoot);
    const journal = new RecoveryJournal({ dir: journalDir });
    // A newer copy of buffer A already exists for the new folder (e.g. a re-target interrupted earlier).
    const writer = new RecoveryJournal({ dir: journalDir });
    await writer.record(
      { rootPath: newRoot, relPath: 'index.html' },
      { bufferId: BUF_A, revision: 9, text: 'newer', bom: false },
    );
    expect(await journal.retarget(projectKey(oldRoot), newRoot)).toEqual({ ok: true, value: { moved: 2 } });
    const a = await journal.readPending(projectKey(newRoot), BUF_A);
    expect(a).toMatchObject({ ok: true, value: { revision: 9, text: 'newer', rootPath: newRoot } });
    const b = await journal.readPending(projectKey(newRoot), BUF_B);
    expect(b).toMatchObject({ ok: true, value: { revision: 7, relPath: '子 文件夹/页面 二.html', rootPath: newRoot } });
    expect(await journal.readPending(projectKey(oldRoot), BUF_A)).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('never replaces a record it cannot read and never grows a copy past the entry limit (review)', async () => {
    await rename(oldRoot, newRoot);
    // A record of buffer A for the new folder written by a newer NoobIDE (S28.4): left alone, the old copy stays.
    const newerRel = path.join(projectKey(newRoot), `${fileKey('index.html')}-${BUF_A}.json`);
    await mkdir(path.join(journalDir, projectKey(newRoot)), { recursive: true });
    await writeFile(path.join(journalDir, newerRel), JSON.stringify({ format: 'noobide-recovery', v: 99 }));
    const journal = new RecoveryJournal({ dir: journalDir });
    expect(await journal.retarget(projectKey(oldRoot), newRoot)).toEqual({ ok: true, value: { moved: 1 } });
    expect(JSON.parse(await readFile(path.join(journalDir, newerRel), 'utf8'))).toEqual({
      format: 'noobide-recovery',
      v: 99,
    });
    expect(await journal.readPending(projectKey(oldRoot), BUF_A)).toMatchObject({ ok: true, value: { text: UNSAVED } });

    // A longer root that would push the record over maxEntryBytes: the old, readable copy is kept.
    const longRoot = path.join(tmp, 'x'.repeat(120));
    const bytes = (await readFile(path.join(journalDir, projectKey(oldRoot), `${fileKey('index.html')}-${BUF_A}.json`)))
      .length;
    const tight = new RecoveryJournal({ dir: journalDir, limits: { maxEntryBytes: bytes + 10 } });
    expect(await tight.retarget(projectKey(oldRoot), longRoot)).toEqual({ ok: true, value: { moved: 0 } });
    expect(await tight.readPending(projectKey(oldRoot), BUF_A)).toMatchObject({ ok: true, value: { text: UNSAVED } });
  });

  it('re-targeting to the same folder changes nothing; unknown keys are not found', async () => {
    const journal = new RecoveryJournal({ dir: journalDir });
    expect(await journal.retarget(projectKey(oldRoot), oldRoot)).toEqual({ ok: true, value: { moved: 0 } });
    expect(await journalFiles()).toHaveLength(2);
    expect(await journal.retarget('f'.repeat(32), newRoot)).toMatchObject({ ok: false, code: 'not-found' });
    expect(await journal.retarget('../x', newRoot)).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('buffers of the running app are never pending', async () => {
    const journal = new RecoveryJournal({ dir: journalDir });
    const live = '2d6a9e7a-8c65-4b9a-9f9a-3e4d5c6f7a81';
    await journal.record(
      { rootPath: oldRoot, relPath: 'index.html' },
      { bufferId: live, revision: 1, text: 'x', bom: false },
    );
    expect(await journal.readPending(projectKey(oldRoot), live)).toMatchObject({ ok: false, code: 'not-found' });
    expect(await journal.discardPending(projectKey(oldRoot), live)).toEqual({ ok: true, value: { removed: false } });
    expect(await journalFiles()).toHaveLength(3);
  });
});
