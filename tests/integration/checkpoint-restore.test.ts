import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCheckpointsIpcHandlers } from '../../src/main/checkpoints-ipc';
import { CheckpointStore } from '../../src/recovery/checkpoints';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import {
  planRestore,
  restoreFromCheckpoint,
  type CheckpointRestoreHost,
} from '../../src/renderer/checkpoints/checkpoint-restore';
import { CHECKPOINT_CHANNELS, type CheckpointsApi } from '../../src/shared/ipc/checkpoints-contract';
import { ProjectService } from '../../src/workspace/project-service';

/**
 * S56.2 integration: restoring a checkpoint over the real main side (checkpoint IPC handlers, ProjectService's atomic
 * save path, local history, a fake OS trash) with editor tabs simulated the way the workbench drives them (a tab's
 * save goes through ProjectService.write with the version it knows). Paths with Chinese characters and spaces.
 */
const ORIGIN = 'noobide://app';
const event = { senderFrame: { url: `${ORIGIN}/index.html`, parent: null }, sender: { id: 1 } } as unknown as IpcMainInvokeEvent; // prettier-ignore

let tmp: string;
let root: string;
let trashDir: string;
let projects: ProjectService;
let history: SnapshotStore;
let checkpoints: CheckpointStore;
let api: CheckpointsApi;
let projectId: string;
let saved: string[];

interface Tab {
  text: string;
  /** Text as last saved (the tab's known disk version). */
  savedText: string;
  readOnly?: boolean;
  failSave?: boolean;
  bom?: boolean;
}
let tabs: Map<string, Tab>;
let log: string[];

const read = (rel: string) => readFile(path.join(root, rel), 'utf8');
const exists = (p: string) => stat(p).then(
  () => true,
  () => false,
); // prettier-ignore

async function saveTab(relPath: string): Promise<boolean> {
  const tab = tabs.get(relPath);
  if (!tab) return false;
  if (tab.failSave) return false;
  if (tab.text === tab.savedText) return true;
  const result = await projects.write({ projectId, relPath, text: tab.text, bom: false });
  log.push(`tab-save ${relPath}`);
  if (result.ok) tab.savedText = tab.text;
  return result.ok;
}

function host(): CheckpointRestoreHost {
  return {
    projectId,
    checkpoints: api,
    workspace: {
      trashEntry: (request) =>
        projects.trashEntry(request, async (full) => {
          await mkdir(trashDir, { recursive: true });
          await rename(full, path.join(trashDir, path.basename(full)));
        }),
    },
    fileOps: {
      beforeChange: async (relPath) => saveTab(relPath).then((okay) => okay || !tabs.has(relPath)),
      afterChange: (change) => {
        log.push(`after ${change.type}`);
        if (change.type === 'deleted') tabs.delete(change.relPath);
      },
      cancelled: () => undefined,
    },
    openTab: (relPath) => {
      const tab = tabs.get(relPath);
      return tab
        ? { text: tab.text, readOnly: tab.readOnly ?? false, dirty: tab.text !== tab.savedText, bom: tab.bom ?? false }
        : undefined;
    },
    saveOpen: saveTab,
    replaceOpenText: async (relPath, before, text) => {
      const tab = tabs.get(relPath);
      if (!tab || tab.text !== before) return { code: 'changed-since' };
      tab.text = text; // one undo step in the real editor
      log.push(`tab-replace ${relPath}`);
      return (await saveTab(relPath)) ? null : { code: 'save-failed' };
    },
  };
}

beforeEach(async () => {
  // The real path: on hosted Windows runners TEMP is an 8.3 short name (C:UsersRUNNER~1...) and the store
  // keys projects by the real root ProjectService opens, so the raw mkdtemp path would never be found.
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-cp-restore-')));
  root = path.join(tmp, '我的 网站');
  trashDir = path.join(tmp, 'trash');
  await mkdir(path.join(root, '样式 文件'), { recursive: true });
  await mkdir(path.join(root, 'images'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<h1>旧的 页面</h1>');
  await writeFile(path.join(root, '样式 文件', '主 样式.css'), 'h1 { color: green; }');
  await writeFile(path.join(root, 'app.js'), 'console.log("old");');
  await writeFile(path.join(root, 'images', 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0, 255]));
  history = new SnapshotStore({ dir: path.join(tmp, 'app data', 'history') });
  checkpoints = new CheckpointStore({ dir: path.join(tmp, 'app data', 'checkpoints'), history });
  projects = new ProjectService({ history: new HistoryTriggers(history) });
  const opened = await projects.open(root);
  if (!opened.ok) throw new Error(opened.code);
  projectId = opened.value.projectId;
  saved = [];
  projects.onSaved((file) => saved.push(file.relPath));
  const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
  registerCheckpointsIpcHandlers(
    { handle: (ch: string, fn: unknown) => void handlers.set(ch, fn as never) } as unknown as IpcMain,
    {
      allowedOrigin: ORIGIN,
      store: checkpoints,
      projects,
    },
  );
  const call =
    (channel: string) =>
    (request: unknown): Promise<never> =>
      handlers.get(channel)?.(event, request) as Promise<never>;
  api = {
    list: call(CHECKPOINT_CHANNELS.list),
    create: call(CHECKPOINT_CHANNELS.create),
    rename: call(CHECKPOINT_CHANNELS.rename),
    delete: call(CHECKPOINT_CHANNELS.delete),
    compare: call(CHECKPOINT_CHANNELS.compare),
    readText: call(CHECKPOINT_CHANNELS.readText),
    restoreFile: call(CHECKPOINT_CHANNELS.restoreFile),
  };
  tabs = new Map();
  log = [];
});

afterEach(async () => {
  await history.idle();
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function saveCheckpoint(name = '能用的 版本'): Promise<string> {
  const made = await api.create({ projectId, name, kind: 'named', cause: 'manual' });
  if (!made.ok) throw new Error(made.code);
  return made.value.checkpoint.id;
}

async function breakProject(): Promise<void> {
  await writeFile(path.join(root, 'index.html'), 'broken');
  await writeFile(path.join(root, 'images', 'logo.png'), 'not a png');
  await rm(path.join(root, '样式 文件', '主 样式.css'));
  await writeFile(path.join(root, 'new page.html'), '<p>added later</p>');
}

async function plan(id: string, only?: string) {
  const compared = await api.compare({ projectId, id });
  if (!compared.ok) throw new Error(compared.code);
  return planRestore(compared.value, host().openTab, only);
}

// Real file-system I/O: a starved hosted Windows runner can take well over Vitest's 5 s default (S58.10, as S58.9).
const REAL_IO = { timeout: 60_000 };

describe('S56.2 restore through the atomic save path', REAL_IO, () => {
  it('restores every file (text, binary, deleted) atomically and keeps added files without confirmation', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const p = await plan(id);
    expect(p.write.map((e) => [e.relPath, e.status])).toEqual([
      ['images/logo.png', 'changed'],
      ['index.html', 'changed'],
      ['样式 文件/主 样式.css', 'removed'],
    ]);
    expect(p.added.map((e) => e.relPath)).toEqual(['new page.html']);

    const report = await restoreFromCheckpoint(host(), p, { unsaved: 'save', trashAdded: false }, 'Before restoring');
    expect([...report.restored].sort()).toEqual(['images/logo.png', 'index.html', '样式 文件/主 样式.css']);
    expect(report.skipped).toEqual([{ relPath: 'new page.html', reason: 'added-kept' }]);
    expect(await read('index.html')).toBe('<h1>旧的 页面</h1>');
    expect(await read('样式 文件/主 样式.css')).toBe('h1 { color: green; }');
    expect([...(await readFile(path.join(root, 'images', 'logo.png')))]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 0, 255,
    ]);
    // The added file was not touched without the user's confirmation.
    expect(await read('new page.html')).toBe('<p>added later</p>');
    // Every write went through the save path: "saved" listeners (preview refresh) ran after each rename.
    expect(saved.sort()).toEqual(['images/logo.png', 'index.html', '样式 文件/主 样式.css']);
    // The broken state was kept first: an automatic checkpoint, and history versions of the replaced files.
    const listed = await api.list({ projectId });
    expect(listed.ok && listed.value.checkpoints.map((c) => [c.kind, c.cause])).toEqual([
      ['auto', 'before-checkpoint-restore'],
      ['named', 'manual'],
    ]);
    expect(report.safetyId).toBe(listed.ok ? listed.value.checkpoints[0]?.id : null);
    await history.idle();
    const versions = await history.list(root, 'index.html');
    expect(versions.ok && versions.value.some((v) => v.reason === 'before-save')).toBe(true);
    // No temp file is left in the project.
    expect(await exists(path.join(root, 'index.html.noobide-tmp'))).toBe(false);
  });

  it('files added since the checkpoint go to the trash only after confirmation', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const report = await restoreFromCheckpoint(
      host(),
      await plan(id),
      { unsaved: 'save', trashAdded: true },
      'Before restoring',
    );
    expect(report.trashed).toEqual(['new page.html']);
    expect(await exists(path.join(root, 'new page.html'))).toBe(false);
    expect(await readFile(path.join(trashDir, 'new page.html'), 'utf8')).toBe('<p>added later</p>');
    // A local-history copy was kept before the trash, too.
    await history.idle();
    const kept = await history.list(root, 'new page.html');
    expect(kept.ok && kept.value[0]?.reason).toBe('before-delete');
  });

  it('dirty buffers: "save first" saves them before the safety checkpoint, then restores through the tab', async () => {
    const id = await saveCheckpoint();
    await writeFile(path.join(root, 'index.html'), 'on disk');
    tabs.set('index.html', { text: 'typed, not saved', savedText: 'on disk' });
    const p = await plan(id);
    expect(p.dirty).toEqual(['index.html']);
    const report = await restoreFromCheckpoint(host(), p, { unsaved: 'save', trashAdded: false }, 'Before restoring');
    expect(report.restored).toContain('index.html');
    // Saved first, then replaced through the tab (one undo step) and saved by it.
    expect(log).toEqual(['tab-save index.html', 'tab-replace index.html', 'tab-save index.html']);
    expect(tabs.get('index.html')?.text).toBe('<h1>旧的 页面</h1>');
    expect(await read('index.html')).toBe('<h1>旧的 页面</h1>');
    // What was typed is in the safety checkpoint.
    const safety = await checkpoints.readFile(root, report.safetyId ?? '', 'index.html');
    expect(safety.ok && new TextDecoder().decode(safety.value)).toBe('typed, not saved');
  });

  it('dirty buffers: "keep" leaves those files and their unsaved edits alone', async () => {
    const id = await saveCheckpoint();
    await writeFile(path.join(root, 'index.html'), 'on disk');
    await writeFile(path.join(root, 'app.js'), 'changed too');
    tabs.set('index.html', { text: 'typed, not saved', savedText: 'on disk' });
    const report = await restoreFromCheckpoint(
      host(),
      await plan(id),
      { unsaved: 'keep', trashAdded: false },
      'Before restoring',
    );
    expect(report.skipped).toEqual([{ relPath: 'index.html', reason: 'unsaved-kept' }]);
    expect(report.restored).toEqual(['app.js']);
    expect(tabs.get('index.html')?.text).toBe('typed, not saved');
    expect(await read('index.html')).toBe('on disk');
    expect(await read('app.js')).toBe('console.log("old");');
  });

  it('restores one file only', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const report = await restoreFromCheckpoint(
      host(),
      await plan(id, 'index.html'),
      { unsaved: 'save', trashAdded: false },
      'Before restoring',
    );
    expect(report.restored).toEqual(['index.html']);
    expect(await read('index.html')).toBe('<h1>旧的 页面</h1>');
    expect(await read('images/logo.png')).toBe('not a png');
    expect(await exists(path.join(root, '样式 文件', '主 样式.css'))).toBe(false);
  });

  it('never writes over a file that changed after the comparison, nor over one that appeared again', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const p = await plan(id);
    const entry = p.write.find((e) => e.relPath === 'index.html');
    // Changed again after the comparison: main refuses, nothing is written.
    await writeFile(path.join(root, 'index.html'), 'edited elsewhere meanwhile');
    const refused = await api.restoreFile({
      projectId,
      id,
      relPath: 'index.html',
      expectedHash: entry?.currentHash ?? null,
    });
    expect(refused).toMatchObject({ ok: false, code: 'changed-on-disk' });
    expect(await read('index.html')).toBe('edited elsewhere meanwhile');
    // A removed file that exists again is never replaced.
    await writeFile(path.join(root, '样式 文件', '主 样式.css'), 'mine now');
    const again = await api.restoreFile({ projectId, id, relPath: '样式 文件/主 样式.css', expectedHash: null });
    expect(again).toMatchObject({ ok: false, code: 'changed-on-disk' });
    expect(await read('样式 文件/主 样式.css')).toBe('mine now');
  });

  it('a file whose checkpoint copy is damaged is skipped and reported; the rest is restored', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const record = await checkpoints.get(root, id);
    const css = record.ok ? record.value.files.find((f) => f.path === '样式 文件/主 样式.css') : undefined;
    await rm(path.join(tmp, 'app data', 'history', 'objects', css?.hash.slice(0, 2) ?? '', css?.hash ?? ''));
    const report = await restoreFromCheckpoint(
      host(),
      await plan(id),
      { unsaved: 'save', trashAdded: false },
      'Before restoring',
    );
    expect(report.skipped).toContainEqual({ relPath: '样式 文件/主 样式.css', reason: 'unavailable' });
    expect([...report.restored].sort()).toEqual(['images/logo.png', 'index.html']);
  });

  it('nothing is restored when the safety checkpoint cannot be taken', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const p = await plan(id);
    const failing: CheckpointRestoreHost = {
      ...host(),
      checkpoints: {
        ...api,
        create: async () => ({ ok: false, code: 'storage-full', message: 'full', detail: { limit: 1 } }),
      },
    };
    const report = await restoreFromCheckpoint(failing, p, { unsaved: 'save', trashAdded: true }, 'Before');
    expect(report).toMatchObject({ restored: [], trashed: [], aborted: { code: 'storage-full' } });
    expect(await read('index.html')).toBe('broken');
    expect(await exists(path.join(root, 'new page.html'))).toBe(true);
  });

  it('main rejects paths outside the listing and unknown projects', async () => {
    const id = await saveCheckpoint();
    for (const relPath of ['../outside.html', '/abs.html', '']) {
      expect(await api.restoreFile({ projectId, id, relPath, expectedHash: null })).toMatchObject({
        ok: false,
        code: 'invalid-request',
      });
    }
    expect(
      await api.restoreFile({
        projectId: '00000000-0000-4000-8000-000000000000',
        id,
        relPath: 'index.html',
        expectedHash: null,
      }),
    ).toMatchObject({ ok: false, code: 'unknown-project' });
  });
});

describe('S56.2 review follow-ups (2026-10-17)', REAL_IO, () => {
  it('restoring an old automatic checkpoint never prunes it on the way', async () => {
    const pruning = new CheckpointStore({
      dir: path.join(tmp, 'app data', 'checkpoints'),
      history,
      limits: { maxAuto: 1 },
    });
    checkpoints = pruning;
    // Re-register the handlers over the store with a 1-checkpoint automatic limit.
    const handlers = new Map<string, (e: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
    registerCheckpointsIpcHandlers(
      { handle: (ch: string, fn: unknown) => void handlers.set(ch, fn as never) } as unknown as IpcMain,
      { allowedOrigin: ORIGIN, store: pruning, projects },
    );
    for (const [key, channel] of Object.entries(CHECKPOINT_CHANNELS)) {
      (api as unknown as Record<string, unknown>)[key] = (request: unknown) => handlers.get(channel)?.(event, request);
    }
    const made = await api.create({ projectId, name: 'auto', kind: 'auto', cause: 'before-ai' });
    if (!made.ok) throw new Error(made.code);
    await breakProject();
    const report = await restoreFromCheckpoint(
      host(),
      await plan(made.value.checkpoint.id),
      { unsaved: 'save', trashAdded: false },
      'Before restoring',
    );
    expect([...report.restored].sort()).toEqual(['images/logo.png', 'index.html', '样式 文件/主 样式.css']);
    expect(await read('index.html')).toBe('<h1>旧的 页面</h1>');
    // The restored checkpoint is still there (the safety one was pruned instead on the next create).
    const listed = await api.list({ projectId });
    expect(listed.ok && listed.value.checkpoints.map((c) => c.id)).toContain(made.value.checkpoint.id);
  });

  it('a file changed or recreated after the user reviewed the plan is not overwritten', async () => {
    const id = await saveCheckpoint();
    await breakProject();
    const p = await plan(id);
    // After the review, before the confirmation: another program edits one file and recreates the removed one.
    await writeFile(path.join(root, 'index.html'), 'edited elsewhere meanwhile');
    await writeFile(path.join(root, '样式 文件', '主 样式.css'), 'recreated by someone');
    const report = await restoreFromCheckpoint(host(), p, { unsaved: 'save', trashAdded: false }, 'Before');
    expect(report.skipped).toContainEqual({ relPath: 'index.html', reason: 'changed-on-disk' });
    expect(report.skipped).toContainEqual({ relPath: '样式 文件/主 样式.css', reason: 'changed-on-disk' });
    expect(report.restored).toEqual(['images/logo.png']);
    expect(await read('index.html')).toBe('edited elsewhere meanwhile');
    expect(await read('样式 文件/主 样式.css')).toBe('recreated by someone');
  });

  it('an added file with unsaved edits is saved first and then trashed when confirmed', async () => {
    const id = await saveCheckpoint();
    await writeFile(path.join(root, 'new page.html'), 'on disk');
    tabs.set('new page.html', { text: 'typed', savedText: 'on disk' });
    const p = await plan(id);
    expect(p.dirty).toEqual(['new page.html']);
    const report = await restoreFromCheckpoint(host(), p, { unsaved: 'save', trashAdded: true }, 'Before');
    expect(report.trashed).toEqual(['new page.html']);
    expect(await readFile(path.join(trashDir, 'new page.html'), 'utf8')).toBe('typed');
  });

  it('an open file with a BOM or CRLF line endings comes back byte for byte', async () => {
    const bomCrlf = '﻿<p>one</p>\r\n<p>two</p>\r\n';
    await writeFile(path.join(root, 'index.html'), bomCrlf);
    const id = await saveCheckpoint();
    await writeFile(path.join(root, 'index.html'), 'broken');
    tabs.set('index.html', { text: 'broken', savedText: 'broken' });
    const report = await restoreFromCheckpoint(
      host(),
      await plan(id, 'index.html'),
      { unsaved: 'save', trashAdded: false },
      'Before',
    );
    expect(report.restored).toEqual(['index.html']);
    expect(await read('index.html')).toBe(bomCrlf);
    // Written by main (not through the tab, which would lose the BOM / CRLF); the clean tab follows the disk (S11).
    expect(log).not.toContain('tab-replace index.html');
    // A file whose current version has a BOM (the checkpoint's has none) is written as bytes too.
    await writeFile(path.join(root, 'app.js'), '﻿broken();');
    tabs.set('app.js', { text: 'broken();', savedText: 'broken();', bom: true });
    const viaBytes = await restoreFromCheckpoint(
      host(),
      await plan(id, 'app.js'),
      { unsaved: 'save', trashAdded: false },
      'Before',
    );
    expect(viaBytes.restored).toEqual(['app.js']);
    expect(await read('app.js')).toBe('console.log("old");');
    expect(log).not.toContain('tab-replace app.js');
    const again = await api.compare({ projectId, id });
    expect(again.ok && again.value.entries.find((e) => e.relPath === 'index.html')?.status).toBe('same');
  });

  it('a failed restore of a removed nested file leaves no empty folder behind', async () => {
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b', 'deep.html'), 'deep');
    const id = await saveCheckpoint();
    await rm(path.join(root, 'a'), { recursive: true });
    const failing = new ProjectService({
      history: new HistoryTriggers(history),
      replaceFile: async () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    });
    const opened = await failing.open(root);
    if (!opened.ok) throw new Error(opened.code);
    const data = await checkpoints.readFile(root, id, 'a/b/deep.html');
    if (!data.ok) throw new Error(data.code);
    const result = await failing.restoreBytes({
      projectId: opened.value.projectId,
      relPath: 'a/b/deep.html',
      data: data.value,
      expectedHash: null,
    });
    expect(result).toMatchObject({ ok: false, code: 'disk-full' });
    expect(await exists(path.join(root, 'a'))).toBe(false);
  });
});
