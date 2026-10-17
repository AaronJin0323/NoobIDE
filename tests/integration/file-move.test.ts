import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectService } from '../../src/workspace/project-service';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import { RecoveryJournal } from '../../src/recovery/journal';
import { registerFileOpsIpcHandlers } from '../../src/main/file-ops-ipc';
import { FILE_OPS_CHANNELS, parseMoveEntriesRequest } from '../../src/shared/ipc/file-ops-contract';

/**
 * S52.1/S52.3 integration: moving files and folders on the real file system, in a project path with Chinese
 * characters and spaces. Nothing is ever overwritten, the destination must be a folder inside the project, and the
 * local history (decision 0006) and crash-recovery copies follow the moved paths.
 */
let tmp: string;
let root: string;
let appData: string;
let store: SnapshotStore;
let journal: RecoveryJournal;
let service: ProjectService;
let projectId: string;

const p = (...segments: string[]) => path.join(root, ...segments);
const BUFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-move-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  appData = path.join(tmp, 'app data');
  await mkdir(p('子 文件夹', '深 一层'), { recursive: true });
  await mkdir(p('图片 素材'));
  await writeFile(p('index.html'), '<p>首页</p>\n');
  await writeFile(p('样式 表.css'), 'h1 {}\n');
  await writeFile(p('子 文件夹', '页面 二.html'), '<p>二</p>\n');
  await writeFile(p('子 文件夹', '深 一层', '脚本 三.js'), 'let a = 3;\n');
  store = new SnapshotStore({ dir: path.join(appData, 'history') });
  journal = new RecoveryJournal({ dir: path.join(appData, 'recovery') });
  service = new ProjectService({ history: new HistoryTriggers(store), journal });
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const move = (from: string[], toFolder: string) => service.moveEntries({ projectId, from, toFolder });

describe('move files and folders (S52.1)', () => {
  it('moves a file into a folder and keeps its bytes', async () => {
    expect(await move(['样式 表.css'], '子 文件夹/深 一层')).toEqual({
      ok: true,
      value: { moved: [{ from: '样式 表.css', to: '子 文件夹/深 一层/样式 表.css' }], failed: [] },
    });
    expect(await readFile(p('子 文件夹', '深 一层', '样式 表.css'), 'utf8')).toBe('h1 {}\n');
    expect(await readdir(root)).not.toContain('样式 表.css');
  });

  it('moves a folder with everything inside, to another folder and to the project root', async () => {
    expect(await move(['子 文件夹/深 一层'], '图片 素材')).toMatchObject({ ok: true, value: { failed: [] } });
    expect(await readFile(p('图片 素材', '深 一层', '脚本 三.js'), 'utf8')).toBe('let a = 3;\n');
    expect(await move(['图片 素材/深 一层'], '')).toMatchObject({
      ok: true,
      value: { moved: [{ from: '图片 素材/深 一层', to: '深 一层' }] },
    });
    expect(await readFile(p('深 一层', '脚本 三.js'), 'utf8')).toBe('let a = 3;\n');
  });

  it('an existing target is refused with its name and both entries stay unchanged', async () => {
    await writeFile(p('图片 素材', 'index.html'), '<p>另一个</p>\n');
    expect(await move(['index.html'], '图片 素材')).toEqual({
      ok: true,
      value: { moved: [], failed: [{ relPath: 'index.html', code: 'exists', message: 'index.html' }] },
    });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
    expect(await readFile(p('图片 素材', 'index.html'), 'utf8')).toBe('<p>另一个</p>\n');
  });

  it('a target differing only in case is refused, never merged or replaced', async () => {
    await writeFile(p('图片 素材', 'INDEX.html'), 'x');
    expect(await move(['index.html'], '图片 素材')).toMatchObject({
      value: { failed: [{ code: 'case-conflict', message: 'INDEX.html' }] },
    });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('a folder cannot be moved into itself or a descendant, also through a junction', async () => {
    expect(await move(['子 文件夹'], '子 文件夹')).toMatchObject({ value: { failed: [{ code: 'into-itself' }] } });
    expect(await move(['子 文件夹'], '子 文件夹/深 一层')).toMatchObject({
      value: { failed: [{ code: 'into-itself' }] },
    });
    await symlink(p('子 文件夹'), p('跳转'), 'junction');
    expect(await move(['子 文件夹'], '跳转/深 一层')).toMatchObject({ value: { failed: [{ code: 'into-itself' }] } });
    expect(await readFile(p('子 文件夹', '页面 二.html'), 'utf8')).toBe('<p>二</p>\n');
  });

  it('the destination must be a folder inside the project (realpath-checked)', async () => {
    const outside = path.join(tmp, '外面 文件夹');
    await mkdir(outside);
    await symlink(outside, p('外链'), 'junction');
    expect(await move(['index.html'], '外链')).toMatchObject({ value: { failed: [{ code: 'outside-project' }] } });
    expect(await readdir(outside)).toEqual([]);
    expect(await move(['index.html'], '样式 表.css')).toMatchObject({
      value: { failed: [{ code: 'not-a-folder' }] },
    });
    expect(await move(['index.html'], '不存在')).toMatchObject({ value: { failed: [{ code: 'not-found' }] } });
    expect(await readFile(p('index.html'), 'utf8')).toBe('<p>首页</p>\n');
  });

  it('a destination reached through a link inside the project reports the real path (one identity)', async () => {
    await symlink(p('图片 素材'), p('素材 捷径'), 'junction');
    expect(await move(['index.html'], '素材 捷径')).toEqual({
      ok: true,
      value: { moved: [{ from: 'index.html', to: '图片 素材/index.html' }], failed: [] },
    });
    expect(await readFile(p('图片 素材', 'index.html'), 'utf8')).toBe('<p>首页</p>\n');
    expect(await move(['图片 素材/index.html'], '素材 捷径')).toEqual({ ok: true, value: { moved: [], failed: [] } });
  });

  it('moving into the folder an entry is already in changes nothing', async () => {
    expect(await move(['子 文件夹/页面 二.html'], '子 文件夹')).toEqual({ ok: true, value: { moved: [], failed: [] } });
    expect(await readdir(p('子 文件夹'))).toContain('页面 二.html');
  });

  it('refuses requests the contract does not allow: absolute paths, `..`, duplicates, an empty selection', () => {
    const ok = { projectId, from: ['index.html'], toFolder: '' };
    expect(parseMoveEntriesRequest(ok)).toEqual(ok);
    expect(parseMoveEntriesRequest({ ...ok, toFolder: '../外面' })).toBeNull();
    expect(parseMoveEntriesRequest({ ...ok, toFolder: 'C:/Users' })).toBeNull();
    expect(parseMoveEntriesRequest({ ...ok, from: ['/etc/passwd'] })).toBeNull();
    expect(parseMoveEntriesRequest({ ...ok, from: ['a/../../b'] })).toBeNull();
    expect(parseMoveEntriesRequest({ ...ok, from: ['index.html', 'index.html'] })).toBeNull();
    expect(parseMoveEntriesRequest({ ...ok, from: [] })).toBeNull();
    expect(parseMoveEntriesRequest({ ...ok, extra: 1 })).toBeNull();
  });

  it('an unknown project is refused as a whole', async () => {
    expect(
      await service.moveEntries({ projectId: '00000000-0000-4000-8000-000000000000', from: ['a'], toFolder: '' }),
    ).toMatchObject({ ok: false, code: 'unknown-project' });
  });
});

describe('a selection moves entry by entry (S52.3)', () => {
  it('moves the others when one is refused, and lists which one was not moved and why', async () => {
    await writeFile(p('图片 素材', '样式 表.css'), 'other');
    const result = await move(['index.html', '样式 表.css', '子 文件夹'], '图片 素材');
    expect(result).toMatchObject({
      ok: true,
      value: {
        moved: [
          { from: 'index.html', to: '图片 素材/index.html' },
          { from: '子 文件夹', to: '图片 素材/子 文件夹' },
        ],
        failed: [{ relPath: '样式 表.css', code: 'exists' }],
      },
    });
    expect(await readFile(p('图片 素材', '样式 表.css'), 'utf8')).toBe('other');
    expect(await readFile(p('样式 表.css'), 'utf8')).toBe('h1 {}\n');
  });

  it('an entry inside a selected folder moves with its folder, not on its own', async () => {
    const result = await move(['子 文件夹', '子 文件夹/页面 二.html'], '图片 素材');
    expect(result).toMatchObject({ value: { moved: [{ from: '子 文件夹' }], failed: [] } });
    expect(await readFile(p('图片 素材', '子 文件夹', '页面 二.html'), 'utf8')).toBe('<p>二</p>\n');
  });
});

describe('history and recovery copies follow a move (S52.1, decision 0006)', () => {
  it('local-history versions of a moved folder are listed under the new paths', async () => {
    await store.snapshot(root, '子 文件夹/页面 二.html', Buffer.from('<p>旧</p>\n'), 'before-save');
    await store.snapshot(root, '子 文件夹/深 一层/脚本 三.js', Buffer.from('let a = 1;\n'), 'before-save');
    await move(['子 文件夹'], '图片 素材');
    expect(await store.files(root)).toEqual({
      ok: true,
      value: ['图片 素材/子 文件夹/深 一层/脚本 三.js', '图片 素材/子 文件夹/页面 二.html'],
    });
    const versions = await store.list(root, '图片 素材/子 文件夹/页面 二.html');
    expect(versions.ok && versions.value.map((v) => v.reason)).toEqual(['before-save']);
    const id = versions.ok ? (versions.value[0]?.id ?? '') : '';
    const bytes = await store.read(root, '图片 素材/子 文件夹/页面 二.html', id);
    expect(bytes.ok && Buffer.from(bytes.value).toString('utf8')).toBe('<p>旧</p>\n');
  });

  it('a rename carries the history over too, merging with history already at the new path', async () => {
    await store.snapshot(root, 'index.html', Buffer.from('v1'), 'before-save');
    await store.snapshot(root, '首页.html', Buffer.from('deleted earlier'), 'before-delete');
    expect(await service.renameEntry({ projectId, from: 'index.html', to: '首页.html' })).toMatchObject({ ok: true });
    const versions = await store.list(root, '首页.html'); // newest first, in the order they were taken
    expect(versions.ok && versions.value.map((v) => v.reason)).toEqual(['before-delete', 'before-save']);
    expect(await store.files(root)).toEqual({ ok: true, value: ['首页.html'] });
  });

  it('a crash copy of a moved file is offered under its new path with the same text', async () => {
    // A copy left by an earlier run (another journal instance = another process).
    const earlier = new RecoveryJournal({ dir: path.join(appData, 'recovery') });
    await earlier.record(
      { rootPath: root, relPath: '子 文件夹/页面 二.html' },
      { bufferId: BUFFER, revision: 3, text: '<p>没保存的</p>\n', bom: false },
    );
    await move(['子 文件夹'], '图片 素材');
    const pending = await journal.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.files.map((f) => f.relPath)).toEqual(['图片 素材/子 文件夹/页面 二.html']);
    const read = await journal.read({ rootPath: root, relPath: '图片 素材/子 文件夹/页面 二.html' }, BUFFER);
    expect(read).toMatchObject({ ok: true, value: { text: '<p>没保存的</p>\n', revision: 3 } });
    expect(await journal.read({ rootPath: root, relPath: '子 文件夹/页面 二.html' }, BUFFER)).toMatchObject({
      ok: false,
      code: 'not-found',
    });
  });

  it("this run's unsaved buffer record follows, so the tab continues it at the new path", async () => {
    await journal.record(
      { rootPath: root, relPath: 'index.html' },
      { bufferId: BUFFER, revision: 2, text: '<p>编辑中</p>\n', bom: false },
    );
    await move(['index.html'], '子 文件夹');
    const target = { rootPath: root, relPath: '子 文件夹/index.html' };
    expect(await journal.read(target, BUFFER)).toMatchObject({ ok: true, value: { text: '<p>编辑中</p>\n' } });
    // A late copy of an older revision is still ignored at the new path; a newer one is written.
    expect(await journal.record(target, { bufferId: BUFFER, revision: 2, text: 'old', bom: false })).toEqual({
      ok: true,
      value: { written: false },
    });
    expect(await journal.record(target, { bufferId: BUFFER, revision: 3, text: 'new', bom: false })).toEqual({
      ok: true,
      value: { written: true },
    });
  });

  it('a refused move leaves history and recovery copies where they were', async () => {
    await store.snapshot(root, 'index.html', Buffer.from('v1'), 'before-save');
    await writeFile(p('子 文件夹', 'index.html'), 'x');
    await move(['index.html'], '子 文件夹');
    expect(await store.files(root)).toEqual({ ok: true, value: ['index.html'] });
  });
});

describe('IPC (S52.1)', () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const eventFrom = (url: string, isTop = true) =>
    ({ senderFrame: { url, parent: isTop ? null : {} }, sender: { id: 1 } }) as unknown as IpcMainInvokeEvent;

  beforeEach(() => {
    handlers.clear();
    registerFileOpsIpcHandlers({ handle: (channel: string, fn: Handler) => void handlers.set(channel, fn) } as never, {
      allowedOrigin: 'noobide://app',
      projects: service,
      trashItem: async () => undefined,
    });
  });

  it('moves for the workbench and refuses other senders and malformed payloads before touching anything', async () => {
    const call = handlers.get(FILE_OPS_CHANNELS.moveEntries) as Handler;
    const request = { projectId, from: ['index.html'], toFolder: '子 文件夹' };
    expect(await call(eventFrom('https://evil.example/'), request)).toMatchObject({ code: 'forbidden-sender' });
    expect(await call(eventFrom('noobide://app/index.html', false), request)).toMatchObject({
      code: 'forbidden-sender',
    });
    expect(await call(eventFrom('noobide://app/index.html'), { ...request, toFolder: '..' })).toMatchObject({
      code: 'invalid-request',
    });
    expect(await readdir(root)).toContain('index.html');
    expect(await call(eventFrom('noobide://app/index.html'), request)).toMatchObject({
      ok: true,
      value: { moved: [{ from: 'index.html', to: '子 文件夹/index.html' }] },
    });
  });
});
