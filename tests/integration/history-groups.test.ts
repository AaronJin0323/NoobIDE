import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { registerHistoryHandlers } from '../../src/main/history-ipc';
import type { HandleFn } from '../../src/main/ipc';
import { GROUP_LIMITS, HISTORY_INDEX_VERSION, SnapshotStore } from '../../src/recovery/history';
import { HistoryTriggers } from '../../src/recovery/history-triggers';
import { projectKey, sha256Hex } from '../../src/recovery/keys';
import { CHANNELS } from '../../src/shared/ipc/contract';
import type { HistoryGroup } from '../../src/shared/ipc/history-contract';
import { ProjectService } from '../../src/workspace/project-service';

/**
 * S34.2: change groups in local history — the applied changes of one AI agent turn, kept in the app-data index
 * (schema version 2) so the turn can be undone after a reload. Real snapshot store, real ProjectService saves with
 * the history hook, a project path with Chinese characters and spaces.
 */
const GROUP = { id: '6f1d2c3b-aaaa-4bbb-8ccc-0123456789ab', label: '把标题改成蓝色 and add an about page' };

let tmp: string;
let root: string;
let historyDir: string;
let store: SnapshotStore;
let triggers: HistoryTriggers;
let projects: ProjectService;
let projectId: string;
let clock: number;
let handlers: Map<string, { parse: (p: unknown) => unknown; run: (p: unknown) => Promise<unknown> }>;

const bytes = (text: string) => new TextEncoder().encode(text);
const indexFile = () => path.join(historyDir, 'index', `${projectKey(root)}.json`);

function newStore() {
  return new SnapshotStore({ dir: historyDir, now: () => clock, retryDelayMs: 1 });
}

function wire(s: SnapshotStore) {
  store = s;
  triggers = new HistoryTriggers(s);
  handlers = new Map();
  const handle: HandleFn = (channel, parse, run) =>
    void handlers.set(channel, { parse, run: (p) => run(p as never, {} as IpcMainInvokeEvent) });
  registerHistoryHandlers(
    handle,
    { rootOf: (id) => projects.rootOf(id) },
    { store: s, triggers, revealFolder: () => undefined },
  );
}

async function call<T = { ok: boolean; value?: unknown; code?: string }>(channel: string, payload?: unknown) {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  const parsed = h.parse(payload);
  if (parsed === null) return { ok: false, code: 'invalid-request' } as T;
  return (await h.run(parsed)) as T;
}

/** A save through the real pipeline (atomic write + history hook), then waits for its snapshots. */
async function save(relPath: string, text: string) {
  const file = await projects.read({ projectId, relPath });
  if (!file.ok) throw new Error(file.message);
  const written = await projects.write({ projectId, relPath, text, bom: false, expectedHash: file.value.version.hash });
  if (!written.ok) throw new Error(written.message);
  await triggers.whenIdle();
}

async function groups(): Promise<HistoryGroup[]> {
  const result = await call<{ ok: true; value: HistoryGroup[] }>(CHANNELS.historyGroups, { projectId });
  if (!result.ok) throw new Error('groups unavailable');
  return result.value;
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-history-groups-'));
  const folder = path.join(tmp, '网页 练习', '我的 主页');
  await mkdir(path.join(folder, 'css 样式'), { recursive: true });
  await writeFile(path.join(folder, 'css 样式', '主 样式.css'), 'h1 { color: red; }\n');
  await writeFile(path.join(folder, '笔记.txt'), '记下来\n');
  root = await realpath(folder);
  historyDir = path.join(tmp, 'app data', 'history');
  clock = 1_000_000;
  wire(newStore());
  projects = new ProjectService({ history: triggers }); // saves snapshot into the same store
  const opened = await projects.open(root);
  if (!opened.ok) throw new Error(opened.message);
  projectId = opened.value.projectId;
}, REAL_IO.timeout);

afterEach(async () => {
  await store.idle();
  await removeTempDir(tmp);
}, REAL_IO.timeout);

// Timeouts (S58.3, docs/perf/ci-runners.md): every test here is real disk work (atomic snapshot writes through the
// save pipeline). The longest takes 0.37 s on the dev machine; a starved hosted Windows runner took over 5 s for two
// of them (run 39018194387, the whole file 21 s). 60 s is a functional timeout for such a runner, not a speed budget.
describe('recording an agent turn (S34.2)', REAL_IO, () => {
  it('keeps the content before each change and the hash after it, and lists the turn as one group', async () => {
    const css = 'css 样式/主 样式.css';
    // The user saved this file a moment ago: its after-save version is in an open save burst.
    await save(css, 'h1 { color: green; }\n');
    clock += 1000;

    // edit: keep before → save through the pipeline → record
    const before = await call<{ ok: true; value: { id: string | null } }>(CHANNELS.historyGroupBefore, {
      projectId,
      groupId: GROUP.id,
      relPath: css,
    });
    expect(before.value.id).not.toBeNull();
    clock += 1000;
    await save(css, 'h1 { color: blue; }\n');
    expect(
      await call(CHANNELS.historyGroupRecord, {
        projectId,
        group: GROUP,
        step: { kind: 'edit', relPath: css, before: before.value.id },
      }),
    ).toEqual({ ok: true, value: null });

    // create
    await writeFile(path.join(root, 'about.html'), '<h1>About</h1>\n');
    await call(CHANNELS.historyGroupRecord, {
      projectId,
      group: GROUP,
      step: { kind: 'create', relPath: 'about.html', before: null },
    });

    // delete (the file goes away after its content was kept)
    const kept = await call<{ ok: true; value: { id: string } }>(CHANNELS.historyGroupBefore, {
      projectId,
      groupId: GROUP.id,
      relPath: '笔记.txt',
    });
    await rm(path.join(root, '笔记.txt'));
    await call(CHANNELS.historyGroupRecord, {
      projectId,
      group: GROUP,
      step: { kind: 'delete', relPath: '笔记.txt', before: kept.value.id },
    });

    // rename
    await rename(path.join(root, 'about.html'), path.join(root, '关于 我.html'));
    await call(CHANNELS.historyGroupRecord, {
      projectId,
      group: GROUP,
      step: { kind: 'rename', relPath: 'about.html', to: '关于 我.html', before: null },
    });

    // A new store (as after a restart) reads the group back from the index.
    wire(newStore());
    const [group] = await groups();
    expect(group).toMatchObject({ id: GROUP.id, kind: 'ai-agent', label: GROUP.label, undoneAt: null });
    expect(group?.files).toEqual([css, '关于 我.html', '笔记.txt']); // the created page counts once, by its new name
    expect(group?.steps).toEqual([
      { kind: 'edit', relPath: css, before: before.value.id, afterHash: sha256Hex(bytes('h1 { color: blue; }\n')) },
      { kind: 'create', relPath: 'about.html', before: null, afterHash: sha256Hex(bytes('<h1>About</h1>\n')) },
      { kind: 'delete', relPath: '笔记.txt', before: kept.value.id, afterHash: null },
      { kind: 'rename', relPath: 'about.html', to: '关于 我.html', before: null, afterHash: null },
    ]);

    // The "before" versions hold what the files were, the after-ai version what the turn left.
    const readBack = async (relPath: string, id: string) =>
      call<{ ok: true; value: { text: string } }>(CHANNELS.historyRead, { projectId, relPath, id });
    expect((await readBack(css, before.value.id as string)).value.text).toBe('h1 { color: green; }\n');
    expect((await readBack('笔记.txt', kept.value.id)).value.text).toBe('记下来\n');
    const versions = await call<{ ok: true; value: { reason: string; group?: string }[] }>(CHANNELS.historyVersions, {
      projectId,
      relPath: css,
    });
    // The turn sealed the user's save burst: green (the version before the turn) was not replaced by blue.
    expect(versions.value.map((v) => v.reason)).toEqual(['after-save', 'after-save', 'before-save']);
    const index = JSON.parse(await readFile(indexFile(), 'utf8'));
    expect(index.v).toBe(HISTORY_INDEX_VERSION);
  });

  it('a "before" id that is not a version of that file is not trusted; payloads are validated', async () => {
    const css = 'css 样式/主 样式.css';
    const other = await call<{ ok: true; value: { id: string } }>(CHANNELS.historyGroupBefore, {
      projectId,
      groupId: GROUP.id,
      relPath: '笔记.txt',
    });
    await call(CHANNELS.historyGroupRecord, {
      projectId,
      group: GROUP,
      step: { kind: 'edit', relPath: css, before: other.value.id },
    });
    expect((await groups())[0]?.steps[0]?.before).toBeNull();

    const bad = [
      { projectId, group: { id: '../x', label: '' }, step: { kind: 'edit', relPath: css, before: null } },
      { projectId, group: GROUP, step: { kind: 'create', relPath: 'a.html', before: other.value.id } },
      { projectId, group: GROUP, step: { kind: 'rename', relPath: 'a.html', before: null } },
      { projectId, group: GROUP, step: { kind: 'edit', relPath: '../outside.txt', before: null } },
      { projectId, group: GROUP, step: { kind: 'chmod', relPath: 'a.html', before: null } },
      { projectId, group: { ...GROUP, extra: 1 }, step: { kind: 'edit', relPath: css, before: null } },
    ];
    for (const payload of bad) {
      expect(await call(CHANNELS.historyGroupRecord, payload)).toEqual({ ok: false, code: 'invalid-request' });
    }
    expect(await call(CHANNELS.historyGroupBefore, { projectId, groupId: 'x', relPath: css })).toEqual({
      ok: false,
      code: 'invalid-request',
    });
    expect(await call(CHANNELS.historyGroupBefore, { projectId, groupId: GROUP.id, relPath: 'missing.html' })).toEqual({
      ok: true,
      value: { id: null, relPath: null },
    });
  });

  it('a deletion is recorded under the file’s real path, even when the change named it in another case', async () => {
    const caseInsensitive = await import('node:fs/promises')
      .then((fs) => fs.access(path.join(root, '笔记.TXT')))
      .then(
        () => true,
        () => false,
      );
    await writeFile(path.join(root, 'Readme.md'), '# 你好\n');
    const spelled = caseInsensitive ? 'README.md' : 'Readme.md';
    const kept = await call<{ ok: true; value: { id: string; relPath: string } }>(CHANNELS.historyGroupBefore, {
      projectId,
      groupId: GROUP.id,
      relPath: spelled,
    });
    expect(kept.value.relPath).toBe('Readme.md');
    await rm(path.join(root, 'Readme.md'));
    await call(CHANNELS.historyGroupRecord, {
      projectId,
      group: GROUP,
      step: { kind: 'delete', relPath: kept.value.relPath, before: kept.value.id },
    });
    const [step] = (await groups())[0]?.steps ?? [];
    expect(step).toMatchObject({ kind: 'delete', relPath: 'Readme.md', before: kept.value.id });
    // …so the deleted file can be created again from that version.
    expect(await call(CHANNELS.historyRestoreDeleted, { projectId, relPath: 'Readme.md', id: kept.value.id })).toEqual({
      ok: true,
      value: { relPath: 'Readme.md' },
    });
    expect(await readFile(path.join(root, 'Readme.md'), 'utf8')).toBe('# 你好\n');
  });

  it('marks a group undone (persisted); an unknown group is not-found', async () => {
    await call(CHANNELS.historyGroupRecord, {
      projectId,
      group: GROUP,
      step: { kind: 'create', relPath: '笔记.txt', before: null },
    });
    clock += 5000;
    expect(await call(CHANNELS.historyGroupUndone, { projectId, groupId: GROUP.id })).toEqual({
      ok: true,
      value: null,
    });
    wire(newStore());
    expect((await groups())[0]?.undoneAt).toBe(clock);
    expect(
      await call(CHANNELS.historyGroupUndone, { projectId, groupId: '00000000-0000-4000-8000-000000000000' }),
    ).toMatchObject({ ok: false, code: 'not-found' });
  });

  // Every step is an atomic index write on the real disk: a few ms here, but a hosted Windows runner with the CPU
  // saturated needed over 5 s for the burst (PR #14 CI). The timeout only bounds the wait; the assertions are unchanged.
  it('keeps the newest groups within the limit, newest first; a group-only index is not deleted', REAL_IO, async () => {
    for (let i = 0; i < GROUP_LIMITS.maxGroups + 3; i += 1) {
      clock += 1;
      await store.recordGroupStep(
        root,
        { id: `turn-${String(i).padStart(4, '0')}`, kind: 'ai-agent', label: `t${i}` },
        { kind: 'rename', relPath: 'a.html', to: 'b.html', before: null, afterHash: null },
      );
    }
    const list = await groups();
    expect(list).toHaveLength(GROUP_LIMITS.maxGroups);
    expect(list[0]?.id).toBe(`turn-${String(GROUP_LIMITS.maxGroups + 2).padStart(4, '0')}`);
    expect(list.some((g) => g.id === 'turn-0000')).toBe(false);
    wire(newStore());
    expect(await groups()).toHaveLength(GROUP_LIMITS.maxGroups);
  });
});

describe('index schema upgrade and downgrade (S34.2, S28.4 policy)', REAL_IO, () => {
  async function writeIndex(value: unknown) {
    await mkdir(path.dirname(indexFile()), { recursive: true });
    await writeFile(indexFile(), JSON.stringify(value));
  }

  it('reads a version 1 index (S21) as it is, and writes it as version 2 with its versions intact', async () => {
    const v1Content = bytes('h1 { color: purple; }\n');
    const hash = sha256Hex(v1Content);
    await mkdir(path.join(historyDir, 'objects', hash.slice(0, 2)), { recursive: true });
    await writeFile(path.join(historyDir, 'objects', hash.slice(0, 2), hash), v1Content);
    const id = `900000-${hash.slice(0, 12)}-7`;
    await writeIndex({
      format: 'noobide-history',
      v: 1,
      rootPath: root,
      files: { '笔记.txt': [{ id, hash, size: v1Content.length, createdAt: 900_000, reason: 'before-save', seq: 7 }] },
    });
    wire(newStore());
    expect(await groups()).toEqual([]);
    await store.recordGroupStep(
      root,
      { id: GROUP.id, kind: 'ai-agent', label: 'x' },
      { kind: 'create', relPath: 'a.html', before: null, afterHash: null },
    );
    const index = JSON.parse(await readFile(indexFile(), 'utf8'));
    expect(index.v).toBe(2);
    expect(index.files['笔记.txt'][0]).toMatchObject({ id, hash, reason: 'before-save', seq: 7 });
    expect(Object.keys(index.groups)).toEqual([GROUP.id]);
    expect(index.groups[GROUP.id].seq).toBeGreaterThan(7); // sequence continues after the old versions
  });

  it('an index from a newer version is never written: groups are unavailable, recording is refused', async () => {
    const newer = JSON.stringify({ format: 'noobide-history', v: 3, rootPath: root, files: {}, groups: {}, more: 1 });
    await mkdir(path.dirname(indexFile()), { recursive: true });
    await writeFile(indexFile(), newer);
    wire(newStore());
    expect(await call(CHANNELS.historyGroups, { projectId })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(
      await call(CHANNELS.historyGroupRecord, {
        projectId,
        group: GROUP,
        step: { kind: 'create', relPath: '笔记.txt', before: null },
      }),
    ).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await call(CHANNELS.historyGroupBefore, { projectId, groupId: GROUP.id, relPath: '笔记.txt' })).toEqual({
      ok: true,
      value: { id: null, relPath: null },
    });
    expect(await readFile(indexFile(), 'utf8')).toBe(newer);
  });

  it('an index without AI data is still written as version 1 (an older NoobIDE keeps using it after a downgrade)', async () => {
    await store.snapshot(root, '笔记.txt', bytes('plain save'), 'before-save');
    expect(JSON.parse(await readFile(indexFile(), 'utf8')).v).toBe(1);
    await store.snapshot(root, '笔记.txt', bytes('ai'), 'before-ai', { group: GROUP.id });
    expect(JSON.parse(await readFile(indexFile(), 'utf8')).v).toBe(2);
  });

  it('a newer index with a version this app cannot parse (e.g. 2.5) is left untouched, not quarantined', async () => {
    const newer = JSON.stringify({ format: 'noobide-history', v: 2.5, rootPath: root, files: {} });
    await mkdir(path.dirname(indexFile()), { recursive: true });
    await writeFile(indexFile(), newer);
    wire(newStore());
    expect(await call(CHANNELS.historyGroups, { projectId })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await readFile(indexFile(), 'utf8')).toBe(newer);
  });

  it('a damaged group is dropped as a whole; the versions and the other groups survive', async () => {
    await store.recordGroupStep(
      root,
      { id: GROUP.id, kind: 'ai-agent', label: 'good' },
      { kind: 'create', relPath: 'a.html', before: null, afterHash: null },
    );
    await store.snapshot(root, '笔记.txt', bytes('kept'), 'before-save');
    const index = JSON.parse(await readFile(indexFile(), 'utf8'));
    index.groups['bad-group-1'] = { ...index.groups[GROUP.id], id: 'bad-group-1', steps: [{ kind: 'explode' }] };
    await writeIndex(index);
    wire(newStore());
    expect((await groups()).map((g) => g.id)).toEqual([GROUP.id]);
    const versions = await store.list(root, '笔记.txt');
    expect(versions.ok && versions.value.length).toBe(1);
  });
});
