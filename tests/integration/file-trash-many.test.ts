import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from '../../src/workspace/project-service';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import { parseTrashEntriesRequest } from '../../src/shared/ipc/file-ops-contract';

/**
 * S52.3 integration: a selection goes to the OS trash item by item (never a permanent delete), each item is kept in
 * local history first, and a partial failure lists exactly which items were not moved. Chinese paths with spaces.
 */
let tmp: string;
let root: string;
let service: ProjectService;
let store: SnapshotStore;
let projectId: string;
const p = (...s: string[]) => path.join(root, ...s);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-trash-many-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(p('子 文件夹'), { recursive: true });
  await writeFile(p('index.html'), '<p>首页</p>\n');
  await writeFile(p('样式 表.css'), 'h1 {}\n');
  await writeFile(p('子 文件夹', '页面 二.html'), '<p>二</p>\n');
  store = new SnapshotStore({ dir: path.join(tmp, 'app data', 'history') });
  service = new ProjectService({ history: new HistoryTriggers(store) });
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A stand-in for shell.trashItem that records the exact paths and moves them out of the project. */
function fakeTrash(failFor: (full: string) => boolean = () => false) {
  const bin = path.join(tmp, '回收站');
  const calls: string[] = [];
  const trashItem = vi.fn(async (full: string) => {
    calls.push(full);
    if (failFor(full)) throw new Error('The file is open in another program');
    await mkdir(bin, { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(full, path.join(bin, `${calls.length}-${path.basename(full)}`));
  });
  return { trashItem, calls, bin };
}

describe('trash a selection (S52.3)', () => {
  it('every item goes to the OS trash by its exact path; nothing is deleted permanently', async () => {
    const trash = fakeTrash();
    const result = await service.trashEntries(
      { projectId, relPaths: ['index.html', '子 文件夹', '子 文件夹/页面 二.html'] },
      trash.trashItem,
    );
    expect(result).toEqual({ ok: true, value: { trashed: ['index.html', '子 文件夹'], failed: [] } });
    // The file inside the selected folder went with its folder: two trash calls, not three.
    expect(trash.calls).toEqual([p('index.html'), p('子 文件夹')]);
    expect((await readdir(root)).sort()).toEqual(['样式 表.css']);
    expect(await readFile(path.join(trash.bin, '2-子 文件夹', '页面 二.html'), 'utf8')).toBe('<p>二</p>\n');
  });

  it('a partial failure lists which items were not moved, and those stay where they are', async () => {
    const trash = fakeTrash((full) => full.endsWith('样式 表.css'));
    const result = await service.trashEntries(
      { projectId, relPaths: ['index.html', '样式 表.css', '子 文件夹'] },
      trash.trashItem,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        trashed: ['index.html', '子 文件夹'],
        failed: [{ relPath: '样式 表.css', code: 'trash-failed', message: 'The file is open in another program' }],
      },
    });
    expect(await readFile(p('样式 表.css'), 'utf8')).toBe('h1 {}\n');
  });

  it('missing entries and paths outside the project are listed, never touched', async () => {
    const trash = fakeTrash();
    const result = await service.trashEntries({ projectId, relPaths: ['不存在.html', 'index.html'] }, trash.trashItem);
    expect(result).toMatchObject({
      value: { trashed: ['index.html'], failed: [{ relPath: '不存在.html', code: 'not-found' }] },
    });
    expect(parseTrashEntriesRequest({ projectId, relPaths: ['../外面.txt'] })).toBeNull();
    expect(parseTrashEntriesRequest({ projectId, relPaths: [] })).toBeNull();
    expect(parseTrashEntriesRequest({ projectId, relPaths: ['a', 'a'] })).toBeNull();
  });

  it('each trashed file is kept in local history first', async () => {
    await service.trashEntries({ projectId, relPaths: ['index.html', '子 文件夹'] }, fakeTrash().trashItem);
    expect(await store.files(root)).toEqual({ ok: true, value: ['index.html', '子 文件夹/页面 二.html'] });
  });
});
