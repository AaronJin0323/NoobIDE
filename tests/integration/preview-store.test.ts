import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { MAX_TRUSTED, PreviewStore, loadPreviewStoreState, trustKey } from '../../src/main/preview-store';

/** S14.4 trust and S14.2 one-time notes, persisted in app data (never in the project, no path text in the file). */
let dir: string;
let file: string;
const PROJECT = path.join(os.tmpdir(), '网页 练习', '我的 项目');

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-preview-store-'));
  file = path.join(dir, '应用 数据', 'preview.json');
  await mkdir(path.dirname(file));
}, REAL_IO.timeout);
afterEach(async () => {
  await removeTempDir(dir);
}, REAL_IO.timeout);

describe('PreviewStore (S14.4, S14.2)', REAL_IO, () => {
  it('a folder is untrusted until Start is pressed; trust survives a restart', async () => {
    const store = new PreviewStore({ file });
    expect(await store.isTrusted(PROJECT)).toBe(false);
    await store.trust(PROJECT);
    expect(await store.isTrusted(PROJECT)).toBe(true);
    const reopened = new PreviewStore({ file });
    expect(await reopened.isTrusted(PROJECT)).toBe(true);
    expect(await reopened.isTrusted(`${PROJECT} 2`)).toBe(false);
  });

  it('stores a hash, never the folder path', async () => {
    const store = new PreviewStore({ file });
    await store.trust(PROJECT);
    const text = await readFile(file, 'utf8');
    expect(text).not.toContain('我的 项目');
    expect(text).not.toContain('网页');
    expect(JSON.parse(text)).toEqual({ version: 1, trusted: [trustKey(PROJECT)], notesSeen: [] });
  });

  it('one-time notes are remembered', async () => {
    const store = new PreviewStore({ file });
    expect(await store.noteSeen('reload-clears-state')).toBe(false);
    await store.markNoteSeen('reload-clears-state');
    expect(await new PreviewStore({ file }).noteSeen('reload-clears-state')).toBe(true);
  });

  it('a corrupt file is backed up and reset (nothing trusted)', async () => {
    await writeFile(file, '{ not json');
    const store = new PreviewStore({ file });
    expect(await store.isTrusted(PROJECT)).toBe(false);
    const names = await readdir(path.dirname(file));
    expect(names.some((n) => n.startsWith('preview.corrupt-'))).toBe(true);
  });

  it('drops malformed entries and keeps at most MAX_TRUSTED folders', () => {
    const many = Array.from({ length: MAX_TRUSTED + 5 }, (_, i) => trustKey(`/p${i}`));
    const state = loadPreviewStoreState({
      trusted: [...many, '/abs/path', 3],
      notesSeen: ['x', 'reload-clears-state'],
    });
    expect(state.trusted).toHaveLength(MAX_TRUSTED);
    expect(state.trusted[0]).toBe(trustKey('/p5'));
    expect(state.notesSeen).toEqual(['reload-clears-state']);
    expect(loadPreviewStoreState(null)).toEqual({ version: 1, trusted: [], notesSeen: [] });
  });
});
