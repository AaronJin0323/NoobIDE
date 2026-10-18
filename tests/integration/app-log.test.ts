import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { AppLog, LOG_FILE, safeValue } from '../../src/main/app-log';

/**
 * S13.6 on a real file system: a rotating log in an app-data folder whose path has Chinese characters and spaces,
 * with version information in every run's first line and no way for file contents to get in.
 */
let tmp: string;
let dir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-log-'));
  dir = path.join(tmp, '应用 数据', 'logs');
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const versions = {
  app: '0.1.0',
  electron: '44.7.0',
  chrome: '140.0.7339.41',
  node: '22.20.0',
  platform: 'win32',
  arch: 'x64',
  osRelease: '10.0.26200',
};

const lines = async (name = LOG_FILE) =>
  (await readFile(path.join(dir, name), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('local log (S13.6)', REAL_IO, () => {
  it('starts every run with the app, Electron, Chromium, Node and OS versions', async () => {
    const log = new AppLog({ dir, now: () => new Date('2026-10-14T12:00:00.000Z') });
    log.started(versions);
    log.write('warn', 'journal-write-failed', { code: 'ENOSPC', key: 'ab12cd34', bytes: 120 });
    expect(await lines()).toEqual([
      { t: '2026-10-14T12:00:00.000Z', level: 'info', event: 'app-start', ...versions },
      {
        t: '2026-10-14T12:00:00.000Z',
        level: 'warn',
        event: 'journal-write-failed',
        code: 'ENOSPC',
        key: 'ab12cd34',
        bytes: 120,
      },
    ]);
  });

  it('never writes source code or other content, even when a caller passes it', async () => {
    const log = new AppLog({ dir });
    const code = '<script>const secret = "hunter2";</script>';
    log.write('error', 'save-failed', {
      text: code,
      message: 'line one\nline two',
      path: 'C:\\Users\\林 小雨\\网页\\a.html',
    });
    log.write('error', code);
    const raw = await readFile(path.join(dir, LOG_FILE), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('<script>');
    expect(raw).not.toContain('line one');
    expect(raw).not.toContain('林 小雨');
    expect(await lines()).toEqual([
      expect.objectContaining({
        event: 'save-failed',
        text: `[redacted ${code.length} chars]`,
        message: '[redacted 17 chars]',
      }),
      expect.objectContaining({ event: `[redacted ${code.length} chars]` }),
    ]);
    expect(safeValue({ any: 'object' })).toBe('[redacted]');
    expect(safeValue(Number.NaN)).toBe('NaN');
  });

  it('rotates at the size limit and keeps at most maxFiles files', async () => {
    const log = new AppLog({ dir, maxBytes: 400, maxFiles: 3 });
    for (let i = 0; i < 60; i += 1) log.write('info', 'tick', { i });
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(['noobide.1.log', 'noobide.2.log', 'noobide.log']);
    for (const name of names) {
      const size = Buffer.byteLength(await readFile(path.join(dir, name), 'utf8'));
      expect(size).toBeLessThanOrEqual(400);
    }
    // The newest lines are in the current file, older ones in .1, oldest kept in .2.
    const current = await lines();
    expect(current.at(-1)).toMatchObject({ event: 'tick', i: 59 });
    const older = await lines('noobide.1.log');
    expect(Number(older.at(-1)?.i)).toBe(Number(current[0]?.i) - 1);
  });

  it('continues an existing log across runs and counts its size', async () => {
    new AppLog({ dir, maxBytes: 500 }).started(versions);
    const second = new AppLog({ dir, maxBytes: 500 });
    second.started(versions);
    second.started(versions);
    expect((await readdir(dir)).sort()).toEqual(['noobide.1.log', 'noobide.log']);
  });

  it('a log that cannot be written never throws (the app keeps working)', async () => {
    await mkdir(path.dirname(dir), { recursive: true });
    await writeFile(dir, 'a file where the folder should be');
    const log = new AppLog({ dir });
    expect(() => log.write('info', 'x')).not.toThrow();
    expect(log.lastWriteFailed).toBe(true);
  });
});
