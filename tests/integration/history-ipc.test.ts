import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { createFileExclusive, registerHistoryHandlers } from '../../src/main/history-ipc';
import type { HandleFn } from '../../src/main/ipc';
import { SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import { CHANNELS } from '../../src/shared/ipc/contract';

/**
 * S21.3 / S21.4 main side: listing, reading and restoring versions, orphaned project histories (ADR 0006), clear,
 * cleanup and reveal — with the real snapshot store in a temp app-data folder and project paths with Chinese
 * characters and spaces.
 */
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

let tmp: string;
let root: string;
let store: SnapshotStore;
let reveal: ReturnType<typeof vi.fn>;
let handlers: Map<string, { parse: (p: unknown) => unknown; run: (p: unknown) => Promise<unknown> }>;
let openRoot: string | undefined;

const enc = (s: string) => new TextEncoder().encode(s);

async function call<T = { ok: boolean; value?: unknown; code?: string }>(channel: string, payload?: unknown) {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  const parsed = h.parse(payload);
  if (parsed === null) return { ok: false, code: 'invalid-request' } as T;
  return (await h.run(parsed)) as T;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-history-ipc-'));
  root = path.join(tmp, '网页 练习', '我的 主页');
  await mkdir(path.join(root, 'css 样式'), { recursive: true });
  root = await realpath(root);
  openRoot = root;
  store = new SnapshotStore({ dir: path.join(tmp, 'appdata', 'history') });
  reveal = vi.fn();
  handlers = new Map();
  const handle: HandleFn = (channel, parse, run) =>
    void handlers.set(channel, {
      parse,
      run: (p) => run(p as never, {} as IpcMainInvokeEvent),
    });
  registerHistoryHandlers(
    handle,
    { rootOf: (id) => (id === ID ? openRoot : undefined) },
    { store, triggers: new HistoryTriggers(store), revealFolder: reveal as never },
  );
}, REAL_IO.timeout);

afterEach(async () => {
  await store.idle();
  await removeTempDir(tmp);
}, REAL_IO.timeout);

// Every test here does real, fsynced snapshot writes: milliseconds on an idle machine, but a hosted Windows runner with
// the CPU saturated pushed one restore sequence past vitest's 5 s default (PR #14 CI). The timeout is only a hang guard;
// no assertion below depends on machine speed.
describe('browsing versions (S21.3)', REAL_IO, () => {
  it('lists files with history, deleted ones flagged, and versions newest first with their reason', async () => {
    await writeFile(path.join(root, 'index.html'), '<h1>3</h1>\n');
    await store.snapshot(root, 'index.html', enc('<h1>1</h1>\n'), 'before-save');
    await store.snapshot(root, 'index.html', enc('<h1>2</h1>\n'), 'after-save');
    await store.snapshot(root, 'css 样式/主 样式.css', enc('a{}'), 'before-delete');

    const files = await call<{ ok: true; value: unknown[] }>(CHANNELS.historyFiles, { projectId: ID });
    expect(files.value).toEqual([
      { relPath: 'css 样式/主 样式.css', versions: 1, exists: false },
      { relPath: 'index.html', versions: 2, exists: true },
    ]);
    const versions = await call<{ ok: true; value: { reason: string; size: number; id: string }[] }>(
      CHANNELS.historyVersions,
      { projectId: ID, relPath: 'index.html' },
    );
    expect(versions.value.map((v) => v.reason)).toEqual(['after-save', 'before-save']);
    const read = await call(CHANNELS.historyRead, { projectId: ID, relPath: 'index.html', id: versions.value[1]?.id });
    expect(read).toEqual({ ok: true, value: { text: '<h1>1</h1>\n', bom: false } });
  });

  it('keeps a UTF-8 BOM, and refuses to show a version that is not text', async () => {
    await store.snapshot(root, 'a.js', new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), 'before-save');
    await store.snapshot(root, 'b.png', new Uint8Array([0x89, 0x50, 0x00, 0x01]), 'before-delete');
    const a = (await store.list(root, 'a.js')) as { ok: true; value: { id: string }[] };
    const b = (await store.list(root, 'b.png')) as { ok: true; value: { id: string }[] };
    expect(await call(CHANNELS.historyRead, { projectId: ID, relPath: 'a.js', id: a.value[0]?.id })).toEqual({
      ok: true,
      value: { text: 'a', bom: true },
    });
    expect(await call(CHANNELS.historyRead, { projectId: ID, relPath: 'b.png', id: b.value[0]?.id })).toMatchObject({
      ok: false,
      code: 'not-text',
    });
  });

  it('a project that is not open, an unknown version and bad payloads are refused', async () => {
    const other = '00000000-0000-4000-8000-000000000000';
    expect(await call(CHANNELS.historyFiles, { projectId: other })).toMatchObject({ code: 'unknown-project' });
    expect(
      await call(CHANNELS.historyRead, { projectId: ID, relPath: 'index.html', id: '1-0123456789ab-1' }),
    ).toMatchObject({ code: 'not-found' });
    for (const [channel, payload] of [
      [CHANNELS.historyRead, { projectId: ID, relPath: 'index.html', id: '../../x' }],
      [CHANNELS.historyRead, { projectId: ID, relPath: '../secret', id: '1-0123456789ab-1' }],
      [CHANNELS.historyVersions, { projectId: ID, relPath: 'C:/Windows/win.ini' }],
      [CHANNELS.historyRestoreDeleted, { projectId: ID, relPath: 'a/../../b', id: '1-0123456789ab-1' }],
      [CHANNELS.historyRestoreDeleted, { projectId: ID, relPath: 'con.html', id: '1-0123456789ab-1' }],
      [CHANNELS.historyBeforeRestore, { projectId: ID, relPath: 'a.html', extra: 1 }],
      [CHANNELS.historyClear, { scope: 'orphan', key: '/Users/me' }],
      [CHANNELS.historyClear, { scope: 'project' }],
      [CHANNELS.historyCleanup, { all: true }],
    ] as const) {
      expect(await call(channel, payload), channel).toEqual({ ok: false, code: 'invalid-request' });
    }
  });
});

describe('restoring (S21.3)', REAL_IO, () => {
  it('before-restore keeps what is on disk now as a version', async () => {
    await writeFile(path.join(root, 'index.html'), '<h1>now</h1>\n');
    await store.snapshot(root, 'index.html', enc('<h1>old</h1>\n'), 'after-save');
    expect(await call(CHANNELS.historyBeforeRestore, { projectId: ID, relPath: 'index.html' })).toEqual({
      ok: true,
      value: null,
    });
    const list = (await store.list(root, 'index.html')) as { ok: true; value: { reason: string; size: number }[] };
    expect(list.value.map((v) => v.reason)).toEqual(['before-restore', 'after-save']);
    expect(await call(CHANNELS.historyBeforeRestore, { projectId: ID, relPath: 'gone.html' })).toMatchObject({
      code: 'not-found',
    });
  });

  it('the content kept before a restore survives the save of the restored content (no coalescing over it)', async () => {
    // Save burst: original O replaced by X (before-save O, after-save X), then a restore of O within the same minute.
    await store.snapshot(root, 'index.html', enc('O'), 'before-save');
    await store.snapshot(root, 'index.html', enc('X'), 'after-save');
    await writeFile(path.join(root, 'index.html'), 'X');
    expect(await call(CHANNELS.historyBeforeRestore, { projectId: ID, relPath: 'index.html' })).toMatchObject({
      ok: true,
    });
    // The editor saves the restored content through the normal pipeline: before-save X (deduped), after-save O.
    await store.snapshot(root, 'index.html', enc('X'), 'before-save');
    await store.snapshot(root, 'index.html', enc('O'), 'after-save');
    const list = (await store.list(root, 'index.html')) as { ok: true; value: { reason: string; size: number }[] };
    const texts = await Promise.all(
      list.value.map(async (v) => {
        const read = await store.read(root, 'index.html', (v as unknown as { id: string }).id);
        return read.ok ? new TextDecoder().decode(read.value) : '?';
      }),
    );
    expect(texts).toEqual(['O', 'X', 'O']);
    expect(list.value.map((v) => v.reason)).toEqual(['after-save', 'after-save', 'before-save']);
  });

  it('before-format keeps the buffer text sent (unsaved edits, BOM) and ends the save burst', async () => {
    await writeFile(path.join(root, 'index.html'), '<h1>saved</h1>\n');
    await store.snapshot(root, 'index.html', enc('<h1>saved</h1>\n'), 'after-save');
    const request = { projectId: ID, relPath: 'index.html', text: '<h1>saved</h1>\n<p>未保存</p>\n', bom: true };
    expect(await call(CHANNELS.historyBeforeFormat, request)).toEqual({ ok: true, value: null });
    // The formatted text is saved within the same minute: it is a new version, not a replacement of the burst.
    await store.snapshot(root, 'index.html', enc('<h1>formatted</h1>\n'), 'after-save');
    const list = (await store.list(root, 'index.html')) as { ok: true; value: { reason: string; id: string }[] };
    expect(list.value.map((v) => v.reason)).toEqual(['after-save', 'before-format', 'after-save']);
    const kept = await call(CHANNELS.historyRead, { projectId: ID, relPath: 'index.html', id: list.value[1]?.id });
    expect(kept).toEqual({ ok: true, value: { text: '<h1>saved</h1>\n<p>未保存</p>\n', bom: true } });
  });

  it('before-format refuses a file that does not exist and malformed payloads', async () => {
    const valid = { projectId: ID, relPath: 'css 样式/gone.css', text: 'a{}', bom: false };
    expect(await call(CHANNELS.historyBeforeFormat, valid)).toMatchObject({ ok: false, code: 'not-found' });
    for (const payload of [
      { ...valid, relPath: '../outside.css' },
      { ...valid, text: 42 },
      { ...valid, bom: 'yes' },
      { ...valid, extra: 1 },
      { projectId: ID, relPath: 'a.css', text: 'a{}' },
      { ...valid, text: 'x'.repeat(5 * 1024 * 1024 + 1) },
    ]) {
      expect(await call(CHANNELS.historyBeforeFormat, payload)).toEqual({ ok: false, code: 'invalid-request' });
    }
    expect(await store.files(root)).toEqual({ ok: true, value: [] });
  });

  it('restores a deleted file (and its deleted folder) byte for byte', async () => {
    const bytes = enc('body { color: 红; }\r\n');
    await store.snapshot(root, 'css 样式/主 样式.css', bytes, 'before-delete');
    await rm(path.join(root, 'css 样式'), { recursive: true });
    const [version] = ((await store.list(root, 'css 样式/主 样式.css')) as { ok: true; value: { id: string }[] }).value;
    const result = await call(CHANNELS.historyRestoreDeleted, {
      projectId: ID,
      relPath: 'css 样式/主 样式.css',
      id: version?.id,
    });
    expect(result).toEqual({ ok: true, value: { relPath: 'css 样式/主 样式.css' } });
    expect(new Uint8Array(await readFile(path.join(root, 'css 样式', '主 样式.css')))).toEqual(bytes);
    // No temporary file is left behind.
    expect(await readdir(path.join(root, 'css 样式'))).toEqual(['主 样式.css']);
  });

  it('never overwrites a file that has that name again', async () => {
    await store.snapshot(root, 'index.html', enc('old'), 'before-delete');
    await writeFile(path.join(root, 'index.html'), 'new file by the user');
    const [version] = ((await store.list(root, 'index.html')) as { ok: true; value: { id: string }[] }).value;
    expect(
      await call(CHANNELS.historyRestoreDeleted, { projectId: ID, relPath: 'index.html', id: version?.id }),
    ).toMatchObject({ ok: false, code: 'exists' });
    expect(await readFile(path.join(root, 'index.html'), 'utf8')).toBe('new file by the user');
    expect(await readdir(root)).toEqual(['css 样式', 'index.html']);
  });

  it('createFileExclusive refuses an existing name even when the check is skipped by a race (link refuses)', async () => {
    await writeFile(path.join(root, 'x.txt'), 'keep');
    await expect(createFileExclusive(root, 'x.txt', enc('other'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(root, 'x.txt'), 'utf8')).toBe('keep');
    await expect(createFileExclusive(root, 'a/../../x.txt', enc('x'))).rejects.toMatchObject({ code: 'OUTSIDE' });
  });
});

describe('storage, orphans, clear and reveal (S21.4, ADR 0006)', REAL_IO, () => {
  it('a renamed project folder leaves its history listed as orphaned, with its size, until it is cleared', async () => {
    await mkdir(path.join(tmp, '网页 练习', '旧 项目'));
    const oldRoot = await realpath(path.join(tmp, '网页 练习', '旧 项目'));
    await store.snapshot(oldRoot, 'index.html', enc('<p>旧的网页</p>'), 'after-save');
    await store.snapshot(oldRoot, 'style.css', enc('p{}'), 'after-save');
    await store.snapshot(root, 'index.html', enc('<p>current</p>'), 'after-save');
    await rename(oldRoot, path.join(tmp, '网页 练习', '新 名字'));

    const overview = (await call(CHANNELS.historyOverview, { projectId: ID })) as {
      ok: true;
      value: {
        orphans: { key: string; rootPath: string; files: number; bytes: number }[];
        current: { rootPath: string } | null;
        usage: { totalBytes: number; maxTotalBytes: number; maxVersionsPerFile: number };
        location: string;
      };
    };
    expect(overview.value.orphans).toHaveLength(1);
    expect(overview.value.orphans[0]).toMatchObject({ rootPath: oldRoot, files: 2, versions: 2 });
    expect(overview.value.orphans[0]?.bytes).toBe(enc('<p>旧的网页</p>').length + 3);
    expect(overview.value.current?.rootPath).toBe(root);
    expect(overview.value.usage.totalBytes).toBeGreaterThan(0);
    expect(overview.value.usage.maxTotalBytes).toBe(store.limits.maxTotalBytes);
    expect(overview.value.location).toBe(store.dir);

    // An existing project's history cannot be cleared through the orphan route.
    const current = (await store.projects()).find((p) => p.rootPath === root);
    expect(await call(CHANNELS.historyClear, { scope: 'orphan', key: current?.key })).toMatchObject({
      code: 'not-found',
    });
    expect(await call(CHANNELS.historyClear, { scope: 'orphan', key: overview.value.orphans[0]?.key })).toEqual({
      ok: true,
      value: null,
    });
    const after = (await call(CHANNELS.historyOverview, { projectId: ID })) as { value: { orphans: unknown[] } };
    expect(after.value.orphans).toEqual([]);
    expect((await store.files(root)).ok && (await store.files(root))).toMatchObject({ value: ['index.html'] });
  });

  it('clears the open project, then everything; cleanup and reveal work', async () => {
    await store.snapshot(root, 'index.html', enc('a'), 'after-save');
    const other = path.join(tmp, 'other');
    await mkdir(other);
    await store.snapshot(other, 'x.html', enc('b'), 'after-save');
    expect(await call(CHANNELS.historyClear, { scope: 'project', projectId: ID })).toEqual({ ok: true, value: null });
    expect(await store.files(root)).toEqual({ ok: true, value: [] });
    expect(await store.files(other)).toEqual({ ok: true, value: ['x.html'] });
    expect(await call(CHANNELS.historyClear, { scope: 'all' })).toEqual({ ok: true, value: null });
    expect(await store.files(other)).toEqual({ ok: true, value: [] });
    expect(await call(CHANNELS.historyCleanup)).toMatchObject({ ok: true, value: { removedBytes: 0 } });
    expect(await call(CHANNELS.historyReveal)).toEqual({ ok: true, value: null });
    expect(reveal).toHaveBeenCalledWith(store.dir);
    await expect(readdir(store.dir)).resolves.toBeDefined(); // created so the file manager can show it
    // Clearing history never touches the project itself.
    expect(await readdir(root)).toEqual(['css 样式']);
  });

  it.runIf(process.platform === 'win32' && !existsSync('Q:\\'))(
    'a project on a drive that is not connected (Windows, unused Q:) is not orphaned and cannot be cleared as one',
    async () => {
      const offline = 'Q:\\网页 练习\\U盘 项目';
      await store.snapshot(offline, 'a.html', enc('x'), 'after-save');
      const overview = (await call(CHANNELS.historyOverview, { projectId: null })) as { value: { orphans: unknown[] } };
      expect(overview.value.orphans).toEqual([]);
      const key = (await store.projects()).find((p) => p.rootPath === offline)?.key;
      expect(await call(CHANNELS.historyClear, { scope: 'orphan', key })).toMatchObject({ code: 'not-found' });
      expect(await store.files(offline)).toEqual({ ok: true, value: ['a.html'] });
    },
  );

  it('overview without an open project lists every history whose folder is gone', async () => {
    openRoot = undefined;
    await store.snapshot(path.join(tmp, 'gone'), 'a.html', enc('x'), 'after-save');
    const overview = (await call(CHANNELS.historyOverview, { projectId: null })) as {
      value: { orphans: { rootPath: string }[]; current: unknown };
    };
    expect(overview.value.orphans.map((o) => o.rootPath)).toEqual([path.join(tmp, 'gone')]);
    expect(overview.value.current).toBeNull();
  });
});
