import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-file';

/**
 * App-data writes (walkthrough, settings, session, journal, history) on Windows: a target briefly held open by another
 * program makes the rename fail with EPERM/EACCES/EBUSY. The write must retry like the project save does, not drop
 * the state (found on the Windows CI runner: the walkthrough's "closed" was never stored).
 */
describe('writeFileAtomic rename retry', () => {
  let dir: string;
  let target: string;
  const noSleep = async () => undefined;
  const locked = (code: string) => Object.assign(new Error(code), { code });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-atomic-file-'));
    target = path.join(dir, '状态 文件.json');
    await writeFile(target, 'old\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a rename blocked with %s and then writes the file', async (code) => {
    let calls = 0;
    const flaky = async (from: string, to: string) => {
      calls += 1;
      if (calls <= 2) throw locked(code);
      await rename(from, to);
    };
    await writeFileAtomic(target, 'new\n', { rename: flaky, renameBackoffMs: [1, 1, 1], sleep: noSleep });
    expect(calls).toBe(3);
    expect(await readFile(target, 'utf8')).toBe('new\n');
    expect(await readdir(dir)).toEqual(['状态 文件.json']); // no temp file left
  });

  it('waits the given backoff between attempts', async () => {
    const waits: number[] = [];
    let calls = 0;
    const flaky = async (from: string, to: string) => {
      calls += 1;
      if (calls <= 2) throw locked('EPERM');
      await rename(from, to);
    };
    await writeFileAtomic(target, 'new\n', {
      rename: flaky,
      renameBackoffMs: [25, 50, 100],
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits).toEqual([25, 50]);
  });

  it('gives up after the backoff, keeps the old file and removes the temp file', async () => {
    let calls = 0;
    const alwaysLocked = async () => {
      calls += 1;
      throw locked('EBUSY');
    };
    await expect(
      writeFileAtomic(target, 'new\n', { rename: alwaysLocked, renameBackoffMs: [1, 1], sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(calls).toBe(3);
    expect(await readFile(target, 'utf8')).toBe('old\n');
    expect(await readdir(dir)).toEqual(['状态 文件.json']);
  });

  it('does not retry other errors, nor at all where the platform has no backoff (POSIX)', async () => {
    let calls = 0;
    const failing = (code: string) => async () => {
      calls += 1;
      throw locked(code);
    };
    await expect(
      writeFileAtomic(target, 'new\n', { rename: failing('ENOSPC'), renameBackoffMs: [1, 1], sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      writeFileAtomic(target, 'new\n', { rename: failing('EPERM'), renameBackoffMs: [], sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'EPERM' });
    expect(calls).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('old\n');
  });
});
