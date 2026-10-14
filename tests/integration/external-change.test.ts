import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { versionChanged } from '../../src/shared/ipc/contract';
import { EMPTY_HASH, ProjectService } from '../../src/workspace/project-service';
import { nodeAtomicFs } from '../../src/workspace/atomic-write';

/**
 * S11.1 / S11.3 main side: every read and save reports the disk version (mtime + size + SHA-256), every save checks
 * the file is still the version the editor knows right before replacing it, and a deleted file is only re-created
 * when nothing with its name exists. Project path with Chinese characters and spaces.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');

let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-s11-'));
  root = path.join(tmp, '外部 修改', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(FIXTURE, root, { recursive: true });
  service = new ProjectService();
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const file = (rel: string) => path.join(root, ...rel.split('/'));

async function readVersion(relPath: string) {
  const read = await service.read({ projectId, relPath });
  if (!read.ok) throw new Error(read.code);
  return read.value.version;
}

describe('file versions (S11.1: mtime + size + hash)', () => {
  it('a read reports mtime, size and the SHA-256 of the bytes on disk', async () => {
    const bytes = await readFile(file('子 文件夹/页面 二.html'));
    const info = await stat(file('子 文件夹/页面 二.html'));
    const version = await readVersion('子 文件夹/页面 二.html');
    expect(version).toEqual({ mtimeMs: info.mtimeMs, size: bytes.length, hash: sha(bytes) });
  });

  it('a save reports the version it wrote, which equals the next read', async () => {
    const saved = await service.write({ projectId, relPath: 'index.html', text: '<p>新</p>\n', bom: false });
    if (!saved.ok) throw new Error(saved.code);
    expect(saved.value.version.hash).toBe(sha('<p>新</p>\n'));
    expect(saved.value.version.size).toBe(Buffer.byteLength('<p>新</p>\n'));
    expect(versionChanged(saved.value.version, await readVersion('index.html'))).toBe(false);
  });

  it('content decides: a new mtime alone (touch, our own atomic save of equal text) is not a change', async () => {
    const before = await readVersion('style.css');
    const later = new Date(Date.now() + 60_000);
    await utimes(file('style.css'), later, later);
    const touched = await readVersion('style.css');
    expect(touched.mtimeMs).not.toBe(before.mtimeMs);
    expect(versionChanged(before, touched)).toBe(false);
  });

  it('an external edit of the same size is a change (hash differs)', async () => {
    await writeFile(file('script.js'), 'let a = 1;\n');
    const before = await readVersion('script.js');
    await writeFile(file('script.js'), 'let b = 1;\n');
    const after = await readVersion('script.js');
    expect(after.size).toBe(before.size);
    expect(versionChanged(before, after)).toBe(true);
  });
});

describe('check before write (S11.1)', () => {
  it.each(['history', 'prepare', 'retry', 'delete'] as const)(
    'rechecks the target after %s before replacing it',
    async (phase) => {
      let renames = 0;
      let savedEvents = 0;
      // Equal size and mtime force validation to compare content, not just metadata.
      const originalInfo = await stat(file('index.html'));
      const external = 'x'.repeat(originalInfo.size);
      const editExternally = async () => {
        await writeFile(file('index.html'), external);
        await utimes(file('index.html'), originalInfo.atime, originalInfo.mtime);
      };
      service = new ProjectService({
        history: {
          captureBeforeSave: async () => {
            if (phase === 'history') await editExternally();
            return null;
          },
          recordSave: () => {},
        },
        atomic: {
          fs: {
            ...nodeAtomicFs,
            open: async (target, flags, mode) => {
              const handle = await nodeAtomicFs.open(target, flags, mode);
              return {
                writeFile: (data) => handle.writeFile(data),
                chmod: (value) => handle.chmod(value),
                sync: () => handle.sync(),
                close: async () => {
                  await handle.close();
                  if (flags === 'wx' && phase === 'prepare') await editExternally();
                },
              };
            },
            rename: async (from, to) => {
              renames += 1;
              if (renames === 1 && (phase === 'retry' || phase === 'delete')) {
                throw Object.assign(new Error('locked'), { code: 'EPERM' });
              }
              await nodeAtomicFs.rename(from, to);
            },
          },
          renameBackoffMs: [1],
          sleep: async () => {
            if (phase === 'delete') await rm(file('index.html'));
            else await editExternally();
          },
        },
      });
      const opened = await service.open(root);
      if (!opened.ok) throw new Error(opened.code);
      projectId = opened.value.projectId;
      service.onSaved(() => {
        savedEvents += 1;
      });
      const known = await readVersion('index.html');
      const result = await service.write({
        projectId,
        relPath: 'index.html',
        text: 'mine\n',
        bom: false,
        expectedHash: known.hash,
      });
      expect(result).toMatchObject({ ok: false, code: phase === 'delete' ? 'not-found' : 'changed-on-disk' });
      expect(renames).toBe(phase === 'prepare' || phase === 'history' ? 0 : 1);
      expect(savedEvents).toBe(0);
      if (phase === 'delete') await expect(readFile(file('index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(file('index.html'), 'utf8')).toBe(external);
      expect((await readdir(root)).filter((name) => name.endsWith('.noobide-tmp'))).toEqual([]);
    },
  );

  it('saves when the disk still holds the expected version', async () => {
    const known = await readVersion('index.html');
    const saved = await service.write({
      projectId,
      relPath: 'index.html',
      text: 'mine\n',
      bom: false,
      expectedHash: known.hash,
    });
    expect(saved.ok).toBe(true);
    expect(await readFile(file('index.html'), 'utf8')).toBe('mine\n');
  });

  it('refuses with changed-on-disk and leaves the external edit untouched', async () => {
    const known = await readVersion('index.html');
    await writeFile(file('index.html'), 'edited in another editor\n');
    const saved = await service.write({
      projectId,
      relPath: 'index.html',
      text: 'mine\n',
      bom: false,
      expectedHash: known.hash,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.code).toBe('changed-on-disk');
    expect(await readFile(file('index.html'), 'utf8')).toBe('edited in another editor\n');
  });

  it('chained saves stay valid: each save’s version is the expectation of the next', async () => {
    let expected = (await readVersion('index.html')).hash;
    for (const text of ['one\n', 'two\n', 'three\n']) {
      const saved = await service.write({ projectId, relPath: 'index.html', text, bom: false, expectedHash: expected });
      if (!saved.ok) throw new Error(saved.code);
      expected = saved.value.version.hash;
    }
    expect(await readFile(file('index.html'), 'utf8')).toBe('three\n');
  });
});

describe('re-creating a file deleted outside NoobIDE (S11.3)', () => {
  it('creates the file again with the buffer text', async () => {
    await rm(file('子 文件夹/页面 二.html'));
    const saved = await service.write({
      projectId,
      relPath: '子 文件夹/页面 二.html',
      text: 'kept in the editor\n',
      bom: false,
      create: true,
    });
    expect(saved.ok).toBe(true);
    expect(await readFile(file('子 文件夹/页面 二.html'), 'utf8')).toBe('kept in the editor\n');
  });

  it('never overwrites a file that appeared again in the meantime', async () => {
    await writeFile(file('index.html'), 'someone else\n');
    const saved = await service.write({ projectId, relPath: 'index.html', text: 'mine\n', bom: false, create: true });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.code).toBe('changed-on-disk');
    expect(await readFile(file('index.html'), 'utf8')).toBe('someone else\n');
  });

  it('reports a missing parent folder instead of creating folders', async () => {
    await rm(file('子 文件夹'), { recursive: true });
    const saved = await service.write({
      projectId,
      relPath: '子 文件夹/页面 二.html',
      text: 'x',
      bom: false,
      create: true,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.code).toBe('not-found');
  });

  it('EMPTY_HASH is the hash of no bytes', () => {
    expect(EMPTY_HASH).toBe(sha(''));
  });
});
