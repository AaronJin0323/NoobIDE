import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { ProjectService } from '../../src/workspace/project-service';
import { importEntry, inspectSources } from '../../src/workspace/import-files';
import { registerFileOpsIpcHandlers } from '../../src/main/file-ops-ipc';
import {
  FILE_OPS_CHANNELS,
  parseImportEntriesRequest,
  parseRegisterDroppedRequest,
  type ImportCandidate,
  type ImportEntriesResult,
} from '../../src/shared/ipc/file-ops-contract';
import { MAX_IMPORT_FILE_BYTES } from '../../src/shared/import-rules';

/**
 * S52.4 integration: "Add files…" / "Add image…" copy chosen files into the selected project folder (never link or
 * move them, never overwrite), under Chinese paths with spaces on both sides; refused types and sizes are named.
 */
let tmp: string;
let root: string;
let outside: string;
let service: ProjectService;
let projectId: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff]);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-import-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  outside = path.join(tmp, '下载 文件夹', '我的 图片');
  await mkdir(path.join(root, '图片 素材'), { recursive: true });
  await mkdir(path.join(outside, '素材 包', '小 图'), { recursive: true });
  await writeFile(path.join(outside, '猫 咪.png'), PNG);
  await writeFile(path.join(outside, '说明 文档.txt'), '说明\r\n');
  await writeFile(path.join(outside, 'setup.exe'), 'MZ');
  await writeFile(path.join(outside, '素材 包', 'a.css'), 'a {}');
  await writeFile(path.join(outside, '素材 包', '小 图', 'b.png'), PNG);
  service = new ProjectService();
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const src = (...s: string[]) => path.join(outside, ...s);

describe('import into the project (S52.4)', REAL_IO, () => {
  it('copies (never moves or links) a file into the chosen folder, byte for byte', async () => {
    expect(await importEntry(root, src('猫 咪.png'), '图片 素材', '猫 咪.png', 'image')).toEqual({
      ok: true,
      value: { relPath: '图片 素材/猫 咪.png', skippedLinks: 0 },
    });
    expect(await readFile(path.join(root, '图片 素材', '猫 咪.png'))).toEqual(PNG);
    expect(await readFile(src('猫 咪.png'))).toEqual(PNG); // the original stays where it was
    expect((await lstat(path.join(root, '图片 素材', '猫 咪.png'))).isSymbolicLink()).toBe(false);
    expect((await lstat(path.join(root, '图片 素材', '猫 咪.png'))).nlink).toBe(1); // not a hard link either
  });

  it('a folder is copied recursively', async () => {
    expect(await importEntry(root, src('素材 包'), '', '素材 包', 'files')).toMatchObject({ ok: true });
    expect(await readFile(path.join(root, '素材 包', '小 图', 'b.png'))).toEqual(PNG);
  });

  it('a name collision is refused with the existing name (also differing only in case), nothing is overwritten', async () => {
    await writeFile(path.join(root, '图片 素材', '猫 咪.png'), 'mine');
    expect(await importEntry(root, src('猫 咪.png'), '图片 素材', '猫 咪.png', 'files')).toEqual({
      ok: false,
      code: 'exists',
      message: '猫 咪.png',
    });
    await writeFile(path.join(root, 'README.TXT'), 'mine');
    expect(await importEntry(root, src('说明 文档.txt'), '', 'readme.txt', 'files')).toMatchObject({
      ok: false,
      code: 'case-conflict',
      message: 'README.TXT',
    });
    expect(await readFile(path.join(root, '图片 素材', '猫 咪.png'), 'utf8')).toBe('mine');
    // The user renames: that name is used.
    expect(await importEntry(root, src('猫 咪.png'), '图片 素材', '猫 咪 2.png', 'files')).toMatchObject({
      ok: true,
      value: { relPath: '图片 素材/猫 咪 2.png' },
    });
  });

  it('refused types, wrong kinds and invalid new names are explained; nothing is copied', async () => {
    expect(await importEntry(root, src('setup.exe'), '', 'setup.exe', 'files')).toMatchObject({
      ok: false,
      code: 'refused-type',
    });
    expect(await importEntry(root, src('setup.exe'), '', 'setup.txt', 'files')).toMatchObject({
      ok: false,
      code: 'refused-type',
    });
    expect(await importEntry(root, src('说明 文档.txt'), '', '说明 文档.txt', 'image')).toMatchObject({
      ok: false,
      code: 'not-an-image',
    });
    expect(await importEntry(root, src('猫 咪.png'), '', '猫 咪.exe', 'files')).toMatchObject({
      ok: false,
      code: 'refused-type',
    });
    expect(await importEntry(root, src('猫 咪.png'), '', 'CON.png', 'files')).toMatchObject({
      ok: false,
      code: 'invalid-name',
    });
    expect(await readdir(root)).toEqual(['图片 素材']);
  });

  it('files over the size cap are refused with "too-large"', async () => {
    const big = src('大 视频.mp4');
    await writeFile(big, Buffer.alloc(0));
    const { truncate } = await import('node:fs/promises');
    await truncate(big, MAX_IMPORT_FILE_BYTES + 1); // sparse: no real disk use
    expect((await inspectSources([big], 'files'))[0]?.refusal).toBe('too-large');
    expect(await importEntry(root, big, '', '大 视频.mp4', 'files')).toMatchObject({ ok: false, code: 'too-large' });
  });

  it('the destination is realpath-checked inside the project; links are never imported', async () => {
    const elsewhere = path.join(tmp, '别处');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(root, '外链'), 'junction');
    expect(await importEntry(root, src('猫 咪.png'), '外链', '猫 咪.png', 'files')).toMatchObject({
      ok: false,
      code: 'outside-project',
    });
    expect(await readdir(elsewhere)).toEqual([]);
    await symlink(src('素材 包'), src('链接 包'), 'junction');
    expect((await inspectSources([src('链接 包')], 'files'))[0]?.refusal).toBe('not-a-file');
  });

  it('the project folder (or a folder above it) cannot be imported into itself', async () => {
    expect(await importEntry(root, root, '图片 素材', '中文 路径 项目', 'files')).toMatchObject({
      ok: false,
      code: 'into-itself',
    });
  });
});

describe('folders from outside are checked inside too (S52.4 review)', REAL_IO, () => {
  it('a folder holding a program, or a file over the cap, is refused and names that file', async () => {
    await mkdir(src('工具 包', '安装'), { recursive: true });
    await writeFile(src('工具 包', '安装', 'setup.exe'), 'MZ');
    const [tools] = await inspectSources([src('工具 包')], 'files');
    expect(tools).toMatchObject({ refusal: 'contains-refused', detail: '安装/setup.exe' });
    const { truncate } = await import('node:fs/promises');
    await mkdir(src('视频 包'));
    await writeFile(src('视频 包', '大.mp4'), '');
    await truncate(src('视频 包', '大.mp4'), MAX_IMPORT_FILE_BYTES + 1);
    expect((await inspectSources([src('视频 包')], 'files'))[0]).toMatchObject({
      refusal: 'contains-too-large',
      detail: '大.mp4',
    });
    expect(await importEntry(root, src('工具 包'), '', '工具 包', 'files')).toMatchObject({
      ok: false,
      code: 'contains-refused',
    });
    expect(await readdir(root)).toEqual(['图片 素材']);
  });

  it('a macOS program bundle (a folder named .app) is refused like a program', async () => {
    await mkdir(src('Tool.app', 'Contents'), { recursive: true });
    expect((await inspectSources([src('Tool.app')], 'files'))[0]?.refusal).toBe('refused-type');
  });

  it('a project folder whose child starts with ".." is still a real child (into-itself check)', async () => {
    await mkdir(path.join(root, '..x 文件夹'));
    expect(await importEntry(root, src('猫 咪.png'), '..x 文件夹', '猫 咪.png', 'files')).toMatchObject({ ok: true });
  });
});

describe('import IPC (S52.4)', REAL_IO, () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const win = (id: number) =>
    ({ senderFrame: { url: 'noobide://app/index.html', parent: null }, sender: { id } }) as unknown as IpcMainInvokeEvent; // prettier-ignore
  let chosen: string[] | null = [];
  let n = 0;

  beforeEach(() => {
    handlers.clear();
    n = 0;
    registerFileOpsIpcHandlers({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) } as never, {
      allowedOrigin: 'noobide://app',
      projects: service,
      trashItem: async () => undefined,
      rootOf: (id) => service.rootOf(id),
      chooseImportPaths: async () => chosen,
      newId: () => `pick-id-${(n += 1).toString().padStart(4, '0')}`,
    });
  });

  const choose = (event = win(1)) =>
    handlers.get(FILE_OPS_CHANNELS.chooseImport)?.(event, { projectId, kind: 'files', title: '添加文件', filterName: '图片' }) as Promise<{ ok: true; value: ImportCandidate[] | null }>; // prettier-ignore
  const importIt = (items: { id: string; name: string }[], event = win(1), toFolder = '图片 素材') =>
    handlers.get(FILE_OPS_CHANNELS.importEntries)?.(event, { projectId, toFolder, items }) as Promise<{ ok: true; value: ImportEntriesResult }>; // prettier-ignore

  it('lists every chosen entry (refused ones with why) and imports by id; the paths stay in main', async () => {
    chosen = [src('猫 咪.png'), src('setup.exe')];
    const candidates = (await choose()).value ?? [];
    expect(candidates.map(({ name, refusal }) => ({ name, refusal }))).toEqual([
      { name: '猫 咪.png', refusal: null },
      { name: 'setup.exe', refusal: 'refused-type' },
    ]);
    expect(JSON.stringify(candidates)).not.toContain(outside);
    const result = await importIt([{ id: candidates[0]?.id ?? '', name: '猫 咪.png' }]);
    expect(result.value).toEqual({
      imported: [{ id: candidates[0]?.id, relPath: '图片 素材/猫 咪.png', skippedLinks: 0 }],
      failed: [],
    });
  });

  it('a cancelled dialog changes nothing; another window or project cannot use the ids', async () => {
    chosen = null;
    expect(await choose()).toEqual({ ok: true, value: null });
    chosen = [src('猫 咪.png')];
    const [candidate] = (await choose()).value ?? [];
    const other = await importIt([{ id: candidate?.id ?? '', name: '猫 咪.png' }], win(2));
    expect(other.value.failed).toEqual([{ id: candidate?.id, code: 'unknown-id', message: 'chosen entry expired' }]);
    expect(await readdir(path.join(root, '图片 素材'))).toEqual([]);
  });

  it('a name Windows or macOS cannot use fails that item only (the user is asked to rename it)', async () => {
    chosen = [src('猫 咪.png'), src('说明 文档.txt')];
    const [cat, doc] = (await choose()).value ?? [];
    const result = await importIt([
      { id: cat?.id ?? '', name: 'aux.png' },
      { id: doc?.id ?? '', name: '说明 文档.txt' },
    ]);
    expect(result.value.failed).toMatchObject([{ id: cat?.id, code: 'invalid-name' }]);
    expect(result.value.imported).toMatchObject([{ id: doc?.id, relPath: '图片 素材/说明 文档.txt' }]);
  });

  it('S52.5: dropped paths are registered like chosen ones; relative or empty paths are ignored', async () => {
    const drop = (paths: string[], event = win(1)) =>
      handlers.get(FILE_OPS_CHANNELS.registerDropped)?.(event, { projectId, paths }) as Promise<{ ok: true; value: ImportCandidate[] }>; // prettier-ignore
    const dropped = await drop([src('猫 咪.png'), 'relative/x.png', '', src('素材 包')]);
    expect(dropped.value.map((c) => [c.name, c.kind, c.refusal])).toEqual([
      ['猫 咪.png', 'file', null],
      ['素材 包', 'directory', null],
    ]);
    expect(JSON.stringify(dropped.value)).not.toContain(outside);
    const result = await importIt(dropped.value.map((c) => ({ id: c.id, name: c.name })));
    expect(result.value.imported.map((i) => i.relPath).sort()).toEqual(['图片 素材/猫 咪.png', '图片 素材/素材 包']);
    expect(await readFile(src('猫 咪.png'))).toEqual(PNG); // copied, the dropped original stays
    expect(parseRegisterDroppedRequest({ projectId, paths: [1] })).toBeNull();
    expect(parseRegisterDroppedRequest({ projectId, paths: ['a\0b'] })).toBeNull();
    expect(parseRegisterDroppedRequest({ projectId, paths: Array(201).fill('C:/x') })).toBeNull();
  });

  it('refuses malformed requests: paths instead of names, duplicates, bad ids', () => {
    const ok = { projectId, toFolder: '', items: [{ id: 'pick-id-0001', name: '猫 咪.png' }] };
    expect(parseImportEntriesRequest(ok)).toEqual(ok);
    expect(parseImportEntriesRequest({ ...ok, items: [{ id: 'pick-id-0001', name: 'a/b.png' }] })).toBeNull();
    expect(parseImportEntriesRequest({ ...ok, items: [{ id: 'pick-id-0001', name: '..' }] })).toBeNull();
    expect(parseImportEntriesRequest({ ...ok, items: [{ id: 'pick-id-0001', name: 'a\\b.png' }] })).toBeNull();
    expect(parseImportEntriesRequest({ ...ok, items: [{ id: 'x', name: 'b.png' }] })).toBeNull();
    expect(parseImportEntriesRequest({ ...ok, items: [ok.items[0], ok.items[0]] })).toBeNull();
    expect(
      parseImportEntriesRequest({ ...ok, items: [{ id: 'pick-id-0001', name: 'b.png', path: 'C:/x' }] }),
    ).toBeNull();
  });
});
