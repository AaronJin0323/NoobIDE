import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import {
  FileInUseError,
  isOwnTempFile,
  nodeAtomicFs,
  replaceFileAtomic,
  writeFileAtomic,
  type AtomicFs,
} from '../../src/workspace/atomic-write';

/** S10.1: atomic replacement on the real file system, plus failure paths through an injected file system. */
let dir: string;
let target: string;
const bytes = (text: string) => new TextEncoder().encode(text);
const fsError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-atomic-'));
  target = path.join(dir, '页面 一.html');
  await writeFile(target, 'old');
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(dir);
}, REAL_IO.timeout);

/** Records every call and lets a test replace single operations. */
function recordingFs(overrides: Partial<AtomicFs> = {}) {
  const calls: string[] = [];
  const fs: AtomicFs = {
    stat: (p) => (calls.push(`stat ${path.basename(p)}`), (overrides.stat ?? nodeAtomicFs.stat)(p)),
    readdir: (p) => (calls.push('readdir'), (overrides.readdir ?? nodeAtomicFs.readdir)(p)),
    rm: (p, o) => (calls.push(`rm ${path.basename(p)}`), (overrides.rm ?? nodeAtomicFs.rm)(p, o)),
    rename: (a, b) => (
      calls.push(`rename ${path.dirname(a) === path.dirname(b)}`),
      (overrides.rename ?? nodeAtomicFs.rename)(a, b)
    ),
    open: async (p, flags, mode) => {
      calls.push(`open ${flags} ${p === dir ? 'the-dir' : path.dirname(p) === dir ? 'same-dir' : p}`);
      const handle = await (overrides.open ?? nodeAtomicFs.open)(p, flags, mode);
      return {
        writeFile: (d) => (calls.push('write'), handle.writeFile(d)),
        chmod: (m) => (calls.push('chmod'), handle.chmod(m)),
        sync: () => (calls.push('sync'), handle.sync()),
        close: () => (calls.push('close'), handle.close()),
      };
    },
  };
  return { fs, calls };
}

const leftovers = async () => (await readdir(dir)).filter((name) => name.endsWith('.noobide-tmp'));

describe('atomic write (S10.1)', REAL_IO, () => {
  it('writes a temp file in the same folder, flushes it, then renames it over the target', async () => {
    const { fs, calls } = recordingFs();
    await replaceFileAtomic(target, bytes('新内容'), { fs, syncDirectory: false, renameBackoffMs: [] });
    expect(await readFile(target, 'utf8')).toBe('新内容');
    expect(calls).toEqual([
      'stat 页面 一.html',
      'readdir',
      'open wx same-dir',
      'write',
      'chmod',
      'sync',
      'close',
      'rename true',
    ]);
    expect(await leftovers()).toEqual([]);
  });

  it('fsyncs the folder after the rename where the platform supports it', async () => {
    const { fs, calls } = recordingFs({
      // Windows cannot open a directory for fsync; this stub stands in for POSIX behaviour on every OS.
      open: async (p, flags, mode) =>
        flags === 'r'
          ? { writeFile: async () => {}, chmod: async () => {}, sync: async () => {}, close: async () => {} }
          : nodeAtomicFs.open(p, flags, mode),
    });
    await replaceFileAtomic(target, bytes('x'), { fs, syncDirectory: true, renameBackoffMs: [] });
    expect(calls.slice(-4)).toEqual(['rename true', 'open r the-dir', 'sync', 'close']);
  });

  it('keeps the permission bits of the target (explicit chmod, not the umask)', async () => {
    await chmod(target, 0o666);
    const before = (await stat(target)).mode & 0o777;
    await replaceFileAtomic(target, bytes('x'), { syncDirectory: false });
    expect((await stat(target)).mode & 0o777).toBe(before);
    await chmod(target, 0o640);
    const restricted = (await stat(target)).mode & 0o777;
    await replaceFileAtomic(target, bytes('y'), { syncDirectory: false });
    expect((await stat(target)).mode & 0o777).toBe(restricted);
  });

  it('retries a rename blocked by another program (Windows EPERM/EBUSY) with backoff, then succeeds', async () => {
    let failures = 2;
    const slept: number[] = [];
    const { fs } = recordingFs({
      rename: async (a, b) => {
        if (failures-- > 0) throw fsError(failures === 1 ? 'EPERM' : 'EBUSY');
        return nodeAtomicFs.rename(a, b);
      },
    });
    await replaceFileAtomic(target, bytes('after lock'), {
      fs,
      renameBackoffMs: [25, 50, 100],
      sleep: async (ms) => void slept.push(ms),
      syncDirectory: false,
    });
    expect(slept).toEqual([25, 50]);
    expect(await readFile(target, 'utf8')).toBe('after lock');
    expect(await leftovers()).toEqual([]);
  });

  it('reports a file that stays locked as "in use", removes the temp file and leaves the target unchanged', async () => {
    const slept: number[] = [];
    const { fs } = recordingFs({ rename: async () => Promise.reject(fsError('EACCES')) });
    const attempt = replaceFileAtomic(target, bytes('new'), {
      fs,
      renameBackoffMs: [1, 2, 3],
      sleep: async (ms) => void slept.push(ms),
      syncDirectory: false,
    });
    await expect(attempt).rejects.toBeInstanceOf(FileInUseError);
    await expect(attempt).rejects.toMatchObject({ code: 'EBUSY', originalCode: 'EACCES', attempts: 4 });
    expect(slept).toEqual([1, 2, 3]);
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await leftovers()).toEqual([]);
  });

  it('does not retry where renames are not blocked by readers (POSIX default: no backoff)', async () => {
    let renames = 0;
    const { fs } = recordingFs({ rename: async () => (renames++, Promise.reject(fsError('EPERM'))) });
    await expect(replaceFileAtomic(target, bytes('new'), { fs, renameBackoffMs: [] })).rejects.toMatchObject({
      code: 'EPERM',
    });
    expect(renames).toBe(1);
  });

  it('does not retry other errors: a full disk fails at once and leaves no temp file', async () => {
    const { fs } = recordingFs({
      open: async (p, flags, mode) => {
        const handle = await nodeAtomicFs.open(p, flags, mode);
        return {
          ...handle,
          writeFile: async () => Promise.reject(fsError('ENOSPC')),
          sync: () => handle.sync(),
          chmod: (m) => handle.chmod(m),
          close: () => handle.close(),
        };
      },
    });
    await expect(replaceFileAtomic(target, bytes('new'), { fs, renameBackoffMs: [1] })).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await readFile(target, 'utf8')).toBe('old');
    expect(await leftovers()).toEqual([]);
  });

  it('removes temp files a crash left behind for this file, and only those', async () => {
    const own = `.页面 一.html.${randomUUID()}.noobide-tmp`;
    const otherFile = `.other.html.${randomUUID()}.noobide-tmp`;
    const notOurs = '.页面 一.html.backup.noobide-tmp';
    for (const name of [own, otherFile, notOurs]) await writeFile(path.join(dir, name), 'stale');
    await replaceFileAtomic(target, bytes('x'), { syncDirectory: false });
    expect((await leftovers()).sort()).toEqual([notOurs, otherFile].sort());
  });

  it('recognizes exactly its own temp file names', () => {
    const id = randomUUID();
    expect(isOwnTempFile(`.a.html.${id}.noobide-tmp`, 'a.html')).toBe(true);
    expect(isOwnTempFile(`.a.html.${id}.noobide-tmp`, 'b.html')).toBe(false);
    expect(isOwnTempFile(`.a.html.x.noobide-tmp`, 'a.html')).toBe(false);
    expect(isOwnTempFile(`a.html.${id}.noobide-tmp`, 'a.html')).toBe(false);
  });

  it('refuses to create a missing file unless asked to (save elsewhere)', async () => {
    const fresh = path.join(dir, '新 文件.css');
    await expect(replaceFileAtomic(fresh, bytes('x'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFileAtomic(fresh, bytes('p { }'), { createIfMissing: true, syncDirectory: false });
    expect(await readFile(fresh, 'utf8')).toBe('p { }');
    expect(await leftovers()).toEqual([]);
  });
});
