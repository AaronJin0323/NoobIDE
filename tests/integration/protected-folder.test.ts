import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S25.3: macOS privacy protection (TCC) and Windows Controlled Folder Access errors reach the UI as
 * `protected-folder`, never as a plain "read-only" or a generic failure — and nothing the user typed is lost.
 *
 * Neither protection can be switched on by a test (both need the OS settings app), so they are simulated: the
 * platform adapter is configured as macOS or Windows with this temp folder as the user's home, and node:fs refuses
 * operations below a "blocked" folder the way each OS does — TCC with EPERM for reads and writes, Controlled Folder
 * Access with EPERM/EACCES for writes only. The error carries `path`, as real Node fs errors do. The adapter's probe
 * (can the folder be listed? is the file read-only?) sees the same simulated block.
 */
type Block = { readonly dir: string; readonly code: 'EPERM' | 'EACCES'; readonly reads: boolean } | null;
const state = vi.hoisted(() => ({ block: null as Block }));

function denied(target: unknown, write: boolean): void {
  const block = state.block;
  if (!block || typeof target !== 'string' || (!write && !block.reads)) return;
  const rel = path.relative(block.dir, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw Object.assign(new Error(`${block.code}: operation not permitted, '${target}'`), {
      code: block.code,
      path: target,
    });
  }
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>, write: boolean | ((...args: A) => boolean)) =>
    async (...args: A): Promise<R> => {
      denied(args[0], typeof write === 'function' ? write(...args) : write);
      return fn(...args);
    };
  const mocked = {
    readdir: wrap(actual.readdir as (...a: unknown[]) => Promise<unknown>, false),
    open: wrap(
      actual.open as (...a: unknown[]) => Promise<unknown>,
      (_p, flags) => flags !== undefined && flags !== 'r',
    ),
    mkdir: wrap(actual.mkdir as (...a: unknown[]) => Promise<unknown>, true),
    rename: wrap(actual.rename as (...a: unknown[]) => Promise<unknown>, true),
    link: wrap(actual.link as (...a: unknown[]) => Promise<unknown>, true),
    unlink: wrap(actual.unlink as (...a: unknown[]) => Promise<unknown>, true),
    copyFile: wrap(actual.copyFile as (...a: unknown[]) => Promise<unknown>, (_from, to) => {
      denied(to, true);
      return false;
    }),
  };
  return { ...actual, ...mocked, default: { ...actual, ...mocked } };
});

const { configureProtectedFolders, nodeDiskProbe } = await import('../../src/platform/protected-folders');

const probe = {
  listError(dir: string): string | null {
    try {
      denied(dir, false);
    } catch (e) {
      return (e as { code: string }).code;
    }
    return nodeDiskProbe.listError(dir);
  },
  isReadOnlyFile: (file: string) => nodeDiskProbe.isReadOnlyFile(file),
};
const { ProjectService } = await import('../../src/workspace/project-service');
const { createProjectFromTemplate } = await import('../../src/workspace/create-project');

let home: string;
let documents: string;
let root: string;
let elsewhere: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-home-')));
  documents = path.join(home, 'Documents');
  root = path.join(documents, '我的 网页');
  elsewhere = path.join(home, 'Projects', '练习 一');
  for (const dir of [root, elsewhere]) {
    await mkdir(path.join(dir, 'css'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<h1>旧</h1>');
  }
});

afterEach(async () => {
  state.block = null;
  configureProtectedFolders(null);
  await rm(home, { recursive: true, force: true });
});

async function opened(service: InstanceType<typeof ProjectService>, dir: string): Promise<string> {
  const result = await service.open(dir);
  if (!result.ok) throw new Error(result.code);
  return result.value.projectId;
}

const text = { text: '<h1>新的内容</h1>', bom: false } as const;

describe('macOS privacy protection (TCC), simulated', () => {
  beforeEach(() => configureProtectedFolders({ platform: 'darwin', home, probe }));

  it('opening a project in Documents explains the privacy setting instead of "could not open"', async () => {
    state.block = { dir: documents, code: 'EPERM', reads: true };
    const result = await new ProjectService().open(root);
    expect(result).toMatchObject({ ok: false, code: 'protected-folder', message: 'EPERM' });
  });

  it('a save refused by TCC is protected-folder, the file is untouched and no temp file is left', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    state.block = { dir: documents, code: 'EPERM', reads: true };
    const result = await service.write({ projectId, relPath: 'index.html', ...text });
    expect(result).toMatchObject({ ok: false, code: 'protected-folder' });
    state.block = null;
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('<h1>旧</h1>');
    expect((await readdir(root)).sort()).toEqual(['css', 'index.html']);
  });

  it('tree listing and file operations in the blocked folder say protected-folder', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    state.block = { dir: documents, code: 'EPERM', reads: true };
    expect(await service.listDir({ projectId, relPath: 'css' })).toMatchObject({ ok: false, code: 'protected-folder' });
    expect(await service.createEntry({ projectId, relPath: 'about.html', kind: 'file' })).toMatchObject({
      ok: false,
      code: 'protected-folder',
    });
    expect(await service.createEntry({ projectId, relPath: 'img', kind: 'directory' })).toMatchObject({
      ok: false,
      code: 'protected-folder',
    });
    expect(await service.renameEntry({ projectId, from: 'index.html', to: 'home.html' })).toMatchObject({
      ok: false,
      code: 'protected-folder',
    });
  });

  it('a file locked in Finder (EPERM, but the folder can still be listed) stays permission-denied', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    state.block = { dir: documents, code: 'EPERM', reads: false };
    expect(await service.write({ projectId, relPath: 'index.html', ...text })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
  });

  it('plain read-only permissions (EACCES) stay permission-denied, also inside Documents', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    state.block = { dir: documents, code: 'EACCES', reads: false };
    expect(await service.write({ projectId, relPath: 'index.html', ...text })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
  });

  it('EPERM outside the protected folders stays permission-denied', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, elsewhere);
    state.block = { dir: elsewhere, code: 'EPERM', reads: false };
    expect(await service.write({ projectId, relPath: 'index.html', ...text })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
  });
});

describe('Windows Controlled Folder Access, simulated', () => {
  // The adapter compares with Windows path rules; this host's real paths are only used as data.
  beforeEach(() => configureProtectedFolders({ platform: 'win32', home, probe }));

  it.each(['EPERM', 'EACCES'] as const)('a save blocked with %s is protected-folder; nothing changes', async (code) => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    state.block = { dir: documents, code, reads: false };
    expect(await service.write({ projectId, relPath: 'index.html', ...text })).toMatchObject({
      ok: false,
      code: 'protected-folder',
    });
    state.block = null;
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('<h1>旧</h1>');
    expect((await readdir(root)).sort()).toEqual(['css', 'index.html']);
  });

  it('creating a project in Documents explains Controlled Folder Access and leaves nothing behind', async () => {
    const templateDir = path.join(home, 'template');
    await mkdir(templateDir);
    await writeFile(path.join(templateDir, 'index.html'), '<p>t</p>');
    state.block = { dir: documents, code: 'EPERM', reads: false };
    const result = await createProjectFromTemplate(
      { dir: templateDir, files: ['index.html'] },
      { parentDir: documents, name: '新 项目' },
    );
    expect(result).toMatchObject({ ok: false, code: 'protected-folder' });
    state.block = null;
    expect((await readdir(documents)).sort()).toEqual(['我的 网页']);
  });

  it('a file with the read-only attribute in Documents stays permission-denied', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    await chmod(path.join(root, 'index.html'), 0o444);
    expect(await service.write({ projectId, relPath: 'index.html', ...text })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('<h1>旧</h1>');
  });

  it('reads are never blamed on Controlled Folder Access (it only blocks changes)', async () => {
    const service = new ProjectService();
    const projectId = await opened(service, root);
    state.block = { dir: documents, code: 'EPERM', reads: true };
    expect(await service.listDir({ projectId, relPath: 'css' })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
  });
});
