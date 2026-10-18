import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { SettingsStore } from '../../src/main/settings-store';
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../../src/shared/settings';

/**
 * S13.1 on a real file system: settings in an app-data folder whose path has Chinese characters and spaces. Corrupt
 * files are backed up (never overwritten) and the defaults take over; migrations are written back. Newer files
 * (S28.4 downgrade) are read but never written.
 */
let tmp: string;
let dir: string;
let file: string;
const events: string[] = [];
const log = (event: string) => void events.push(event);
const fixedNow = () => new Date('2026-10-14T12:00:00.000Z');

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-settings-'));
  dir = path.join(tmp, '应用 数据');
  await mkdir(dir, { recursive: true });
  file = path.join(dir, 'settings.json');
  events.length = 0;
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const onDisk = async () => JSON.parse(await readFile(file, 'utf8')) as unknown;

describe('settings store (S13.1)', REAL_IO, () => {
  it('starts from the defaults without creating a file until something changes', async () => {
    const store = new SettingsStore({ file, log });
    expect(await store.load()).toEqual({ settings: DEFAULT_SETTINGS, notice: null, backupPath: null });
    expect(await readdir(dir)).toEqual([]);
    await store.update({ locale: 'en' });
    expect(await onDisk()).toEqual({ ...DEFAULT_SETTINGS, locale: 'en' });
  });

  it('persists across store instances (an app restart)', async () => {
    await new SettingsStore({ file }).update({ locale: 'en', editorFontSize: 20 });
    const again = await new SettingsStore({ file }).load();
    expect(again.settings).toEqual({ ...DEFAULT_SETTINGS, locale: 'en', editorFontSize: 20 });
    expect(again.notice).toBeNull();
  });

  it('a corrupt file is backed up byte for byte and reset to the defaults', async () => {
    await writeFile(file, '{"locale": "en", oops');
    const store = new SettingsStore({ file, log, now: fixedNow });
    const state = await store.load();
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.notice).toBe('corrupt');
    expect(state.backupPath).toBe(path.join(dir, 'settings.corrupt-2026-10-14T12-00-00-000Z.json'));
    expect(await readFile(state.backupPath ?? '', 'utf8')).toBe('{"locale": "en", oops');
    expect(await onDisk()).toEqual(DEFAULT_SETTINGS);
    expect(events).toContain('settings-reset');
  });

  it('a JSON value that is not a settings object is corrupt too', async () => {
    await writeFile(file, '[1, 2, 3]');
    const state = await new SettingsStore({ file, now: fixedNow }).load();
    expect(state.notice).toBe('corrupt');
    expect((await readdir(dir)).sort()).toEqual(['settings.corrupt-2026-10-14T12-00-00-000Z.json', 'settings.json']);
  });

  it('S28.4: a file from a newer NoobIDE is used as far as understood and never written, moved or backed up', async () => {
    const newer = JSON.stringify({ version: SETTINGS_VERSION + 1, locale: 'en', editorFontSize: 99, fancy: true });
    await writeFile(file, newer);
    const store = new SettingsStore({ file, now: fixedNow, log });
    const state = await store.load();
    expect(state).toEqual({
      settings: { ...DEFAULT_SETTINGS, locale: 'en' },
      notice: 'newer-version',
      backupPath: null,
    });
    expect(events).toContain('settings-newer-version');
    // A change in the older version lasts until quit; the newer file stays byte for byte.
    expect(await store.update({ theme: 'dark' })).toMatchObject({ locale: 'en', theme: 'dark' });
    expect(await readFile(file, 'utf8')).toBe(newer);
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  it('migrates an unversioned (version 0) file and writes the result back', async () => {
    await writeFile(file, JSON.stringify({ locale: 'en' }));
    const state = await new SettingsStore({ file, log }).load();
    expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, locale: 'en' });
    expect(state.notice).toBeNull();
    expect(await onDisk()).toEqual({ ...DEFAULT_SETTINGS, locale: 'en' });
    expect(events).toContain('settings-upgraded');
  });

  it('migrates through an injected chain (v1 → v2) and writes the new version', async () => {
    await writeFile(file, JSON.stringify({ version: 1, locale: 'en' }));
    const store = new SettingsStore({
      file,
      version: 2,
      migrations: [{ from: 1, migrate: (raw) => ({ ...raw, version: 2, theme: 'dark' }) }],
    });
    expect((await store.load()).settings).toEqual({ ...DEFAULT_SETTINGS, locale: 'en', theme: 'dark' });
  });

  it('a BOM written by a text editor does not make the file corrupt', async () => {
    await writeFile(file, `\uFEFF${JSON.stringify({ version: 1, locale: 'en' })}`);
    expect((await new SettingsStore({ file }).load()).settings.locale).toBe('en');
  });

  it('concurrent updates are serialized: the last one wins on disk', async () => {
    const store = new SettingsStore({ file });
    await Promise.all([
      store.update({ locale: 'en' }),
      store.update({ editorFontSize: 18 }),
      store.update({ locale: 'zh-CN' }),
    ]);
    expect(await onDisk()).toEqual({ ...DEFAULT_SETTINGS, editorFontSize: 18 });
    expect((await readdir(dir)).filter((n) => n.endsWith('.noobide-tmp'))).toEqual([]);
  });
});
