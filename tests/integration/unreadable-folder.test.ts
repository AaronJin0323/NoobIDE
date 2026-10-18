import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';

/**
 * Security review of S03, finding 3: one unreadable subfolder must not make the whole project unopenable, and the
 * lazy tree (S07.2) reports it for that folder only. Permission bits cannot deny reading on Windows without ACL
 * tools, so readdir is made to fail with EACCES for folders named `locked`.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const readdir = (async (p: Parameters<typeof actual.readdir>[0], ...rest: unknown[]) => {
    if (path.basename(String(p)) === 'locked') {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
    return (actual.readdir as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

const { ProjectService } = await import('../../src/workspace/project-service');

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-locked-')));
  root = path.join(tmp, '项目');
  await mkdir(path.join(root, 'locked'), { recursive: true });
  await writeFile(path.join(root, 'locked', 'a.html'), '');
  await writeFile(path.join(root, 'index.html'), '');
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

describe('unreadable subfolders', REAL_IO, () => {
  it('the project still opens; the folder is listed and only its own listing fails', async () => {
    const service = new ProjectService();
    const opened = await service.open(root);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.files.map((f) => f.relPath)).toEqual(['index.html']);
    const projectId = opened.value.projectId;
    const top = await service.listDir({ projectId, relPath: '' });
    expect(top.ok && top.value.entries.map((e) => e.name)).toEqual(['locked', 'index.html']);
    expect(await service.listDir({ projectId, relPath: 'locked' })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
  });
});
