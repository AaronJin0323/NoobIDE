import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDataPath, type AppDataEntry } from '../../src/main/app-data-layout';
import { schemaVersionOf } from '../../src/main/json-file';
import { PreviewStore } from '../../src/main/preview-store';
import { RecentProjects } from '../../src/main/recent-projects';
import { SessionStore } from '../../src/main/session-store';
import { SettingsStore } from '../../src/main/settings-store';
import { WalkthroughStore } from '../../src/main/walkthrough-store';
import { SnapshotStore } from '../../src/recovery/history';
import { RecoveryJournal } from '../../src/recovery/journal';
import { DEFAULT_SETTINGS } from '../../src/shared/settings';
import { DEFAULT_SESSION_LAYOUT } from '../../src/shared/session';
import { DEFAULT_WALKTHROUGH, type WalkthroughState } from '../../src/shared/walkthrough';

/**
 * S28.4 (docs/decisions/0023-upgrade-and-uninstall.md): app data across NoobIDE versions. Every "process" below is a
 * fresh set of stores on the same app-data folder, built the way src/main/main.ts builds them (same entry names):
 *
 * - vN → vN+1 with the same schema (the normal manual upgrade): everything written by vN is read back unchanged.
 * - vN → vN+1 with files of an older schema (unversioned settings, files without `version`): data kept, upgraded.
 * - vN+1 → vN (downgrade): files of a newer schema with unknown fields are read as far as understood and are never
 *   written, moved, backed up or deleted — byte for byte, even after changes — so the re-upgrade finds them intact.
 *
 * The app-data folder and the project path contain Chinese characters and spaces.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');
const BUF = '11111111-2222-4333-8444-555555555555';
const UNSAVED = '<p>还没保存的内容 unsaved</p>';

let tmp: string;
let userData: string;
let root: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-upgrade-'));
  userData = path.join(tmp, '应用 数据', 'NoobIDE');
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(FIXTURE, root, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The app-data stores of one app process. */
function launch() {
  const events: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
    void events.push({ event, fields });
  return {
    events,
    settings: new SettingsStore({ file: appDataPath(userData, 'settings'), log }),
    recent: new RecentProjects({ file: appDataPath(userData, 'recentProjects'), log }),
    session: new SessionStore({ file: appDataPath(userData, 'session'), log }),
    walkthrough: new WalkthroughStore({ file: appDataPath(userData, 'walkthrough'), log }),
    preview: new PreviewStore({ file: appDataPath(userData, 'preview'), log }),
    journal: new RecoveryJournal({ dir: appDataPath(userData, 'recovery'), log }),
    history: new SnapshotStore({ dir: appDataPath(userData, 'history'), log }),
  };
}

const WALKTHROUGH: WalkthroughState = {
  ...DEFAULT_WALKTHROUGH,
  status: 'active',
  step: 'style',
  completed: ['create', 'files', 'heading'],
};
const LAYOUT = { ...DEFAULT_SESSION_LAYOUT, filesWidth: 300 };

/** vN uses the app: every kind of app data gets written. */
async function useVersionN(): Promise<void> {
  const app = launch();
  await app.settings.load();
  await app.settings.update({ locale: 'en', theme: 'dark', editorFontSize: 20, restoreSession: true });
  await app.recent.touch(root);
  await app.session.projectOpened(root);
  await app.session.saveTabs(root, { tabs: ['index.html', 'css/style.css'], active: 'css/style.css' });
  await app.session.saveLayout(LAYOUT);
  await app.walkthrough.save(WALKTHROUGH);
  await app.preview.trust(root);
  await app.preview.markNoteSeen('reload-clears-state');
  const v1 = new TextEncoder().encode('<h1>第一版</h1>');
  const v2 = new TextEncoder().encode('<h1>第二版</h1>');
  expect((await app.history.snapshot(root, 'index.html', v1, 'before-save')).ok).toBe(true);
  expect((await app.history.snapshot(root, 'index.html', v2, 'before-restore')).ok).toBe(true);
  await app.history.idle();
  // Unsaved edits left by a crash (the app ended without saving them).
  expect(
    (
      await app.journal.record(
        { rootPath: root, relPath: 'index.html' },
        { bufferId: BUF, revision: 3, text: UNSAVED, bom: false },
      )
    ).ok,
  ).toBe(true);
}

/** What vN+1 sees on its first start. */
async function expectEverythingKept(app: ReturnType<typeof launch>): Promise<void> {
  expect((await app.settings.load()).settings).toEqual({
    ...DEFAULT_SETTINGS,
    locale: 'en',
    theme: 'dark',
    editorFontSize: 20,
  });
  const recent = await app.recent.list();
  expect(recent.map((r) => [r.path, r.available])).toEqual([[root, true]]);
  expect(await app.session.lastProject()).toBe(root);
  expect(await app.session.tabsOf(root)).toEqual({ tabs: ['index.html', 'css/style.css'], active: 'css/style.css' });
  expect(await app.session.layout()).toEqual(LAYOUT);
  expect(await app.walkthrough.get()).toEqual(WALKTHROUGH);
  expect(await app.preview.isTrusted(root)).toBe(true);
  expect(await app.preview.noteSeen('reload-clears-state')).toBe(true);
  const versions = await app.history.list(root, 'index.html');
  expect(versions.ok && versions.value.length).toBe(2);
  const pending = await app.journal.listPending();
  expect(pending.map((p) => [p.rootPath, p.files.map((f) => f.relPath)])).toEqual([[root, ['index.html']]]);
  const recovered = await app.journal.read({ rootPath: root, relPath: 'index.html' }, BUF);
  expect(recovered.ok && recovered.value.text).toBe(UNSAVED);
}

async function snapshotFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.set(path.relative(dir, full), await readFile(full, 'utf8'));
    }
  };
  await walk(dir);
  return out;
}

describe('app data across NoobIDE versions (S28.4)', () => {
  it('vN → vN+1: settings, recent projects, session, walkthrough, preview trust, history and recovery are kept', async () => {
    await useVersionN();
    const projectBefore = await snapshotFiles(root);
    const next = launch();
    await expectEverythingKept(next);
    // The next version keeps working on the same data, and nothing was backed up, reset or quarantined.
    await next.recent.touch(root);
    await next.settings.update({ editorFontSize: 22 });
    const names = (await readdir(userData)).sort();
    expect(names.filter((n) => /corrupt|newer|quarantine/.test(n))).toEqual([]);
    expect(next.events.filter((e) => /reset|corrupt|skipped|newer/.test(e.event))).toEqual([]);
    // The project folder stays ordinary: nothing of the app data is in it.
    expect(await snapshotFiles(root)).toEqual(projectBefore);
  });

  it('vN → vN+1 with files of an older schema (no version field): the data is kept and upgraded on the next write', async () => {
    await mkdir(userData, { recursive: true });
    const write = (entry: AppDataEntry, value: unknown) =>
      writeFile(appDataPath(userData, entry), JSON.stringify(value));
    await write('settings', { locale: 'en', editorFontSize: 18 });
    await write('recentProjects', {
      projects: [{ id: '0f0e0d0c-0b0a-4908-8706-050403020100', rootPath: root, lastOpened: 1 }],
    });
    await write('session', { lastProject: root, layout: LAYOUT, projects: {} });
    const { version: _v, ...walkthroughV0 } = WALKTHROUGH;
    await write('walkthrough', walkthroughV0);
    await write('preview', { trusted: [], notesSeen: ['reload-clears-state'] });

    const app = launch();
    expect((await app.settings.load()).settings).toMatchObject({ locale: 'en', editorFontSize: 18 });
    expect((await app.recent.list()).map((r) => r.path)).toEqual([root]);
    expect(await app.session.lastProject()).toBe(root);
    expect(await app.session.layout()).toEqual(LAYOUT);
    expect(await app.walkthrough.get()).toEqual(WALKTHROUGH);
    expect(await app.preview.noteSeen('reload-clears-state')).toBe(true);

    await app.recent.touch(root);
    await app.session.projectOpened(root);
    await app.walkthrough.save(WALKTHROUGH);
    await app.preview.trust(root);
    for (const entry of ['settings', 'recentProjects', 'session', 'walkthrough', 'preview'] as const) {
      const onDisk = JSON.parse(await readFile(appDataPath(userData, entry), 'utf8')) as unknown;
      expect(schemaVersionOf(onDisk, 1), entry).toEqual({ kind: 'current' });
    }
    expect((await readdir(userData)).filter((n) => /corrupt|newer/.test(n))).toEqual([]);
  });

  it('vN+1 → vN (downgrade): newer files are used as far as understood and stay byte for byte for the re-upgrade', async () => {
    await useVersionN();
    // Turn every file into what a newer NoobIDE (schema 2, with a field this version does not know) would write.
    const bump = async (file: string, field = 'version') => {
      const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...value, [field]: 2, addedInV2: { anything: true } }));
    };
    for (const entry of ['settings', 'recentProjects', 'session', 'walkthrough', 'preview'] as const) {
      await bump(appDataPath(userData, entry));
    }
    const journalProject = (await readdir(appDataPath(userData, 'recovery'))).find((n) => !n.startsWith('quarantine'));
    const journalDir = path.join(appDataPath(userData, 'recovery'), journalProject!);
    const [record] = await readdir(journalDir);
    await bump(path.join(journalDir, record!), 'v');
    const indexDir = path.join(appDataPath(userData, 'history'), 'index');
    const [index] = await readdir(indexDir);
    await bump(path.join(indexDir, index!), 'v');
    const before = await snapshotFiles(userData);

    // The older version starts on the newer data.
    const older = launch();
    const settings = await older.settings.load();
    expect(settings.settings).toMatchObject({ locale: 'en', theme: 'dark', editorFontSize: 20 });
    expect(settings.notice).toBe('newer-version');
    expect((await older.recent.list()).map((r) => r.path)).toEqual([root]);
    expect(await older.session.lastProject()).toBe(root);
    expect(await older.walkthrough.get()).toEqual(WALKTHROUGH);
    expect(await older.preview.isTrusted(root)).toBe(true);
    // Newer recovery records and history are not offered (this version cannot read them) but are kept.
    expect(await older.journal.listPending()).toEqual([]);
    expect((await older.history.list(root, 'index.html')).ok).toBe(false);

    // It is used: every store is asked to change something.
    await older.settings.update({ locale: 'zh-CN' });
    await older.recent.touch(path.join(tmp, '网页 练习'));
    await older.session.projectClosed(root);
    await older.session.saveLayout(DEFAULT_SESSION_LAYOUT);
    await older.walkthrough.save(DEFAULT_WALKTHROUGH);
    await older.preview.markNoteSeen('reload-clears-state');
    await older.preview.trust(path.join(tmp, 'other'));
    const blocked = await older.history.snapshot(root, 'index.html', new TextEncoder().encode('x'), 'before-save');
    expect(blocked.ok).toBe(false);
    await older.history.cleanup();
    await older.history.idle();
    await older.journal.discardSaved({ rootPath: root, relPath: 'index.html' }, BUF, 99);
    // In memory the changes apply…
    expect((await older.settings.snapshot()).settings.locale).toBe('zh-CN');
    // …but not one byte of the newer app data was written, moved, backed up or deleted.
    expect(await snapshotFiles(userData)).toEqual(before);
    for (const store of ['settings', 'recent', 'session', 'walkthrough', 'preview-store']) {
      expect(
        older.events.some((e) => e.event === `${store}-newer-version`),
        store,
      ).toBe(true);
    }
  });
});
