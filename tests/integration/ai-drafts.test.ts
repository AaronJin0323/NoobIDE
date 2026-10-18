import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { AiDraftStore, NO_PROJECT_FILE } from '../../src/ai/draft-store';
import { registerAiDraftIpcHandlers } from '../../src/main/ai-draft-ipc';
import { appDataPath } from '../../src/main/app-data-layout';
import { AppLog } from '../../src/main/app-log';
import { projectKey } from '../../src/recovery/keys';
import { ProjectService } from '../../src/workspace/project-service';
import { AI_DRAFT_CHANNELS } from '../../src/shared/ipc/ai-draft-contract';
import { AI_DRAFT_LIMITS } from '../../src/shared/ipc/ai-draft-parse';

/**
 * S48.7 integration: the real draft store behind its IPC handlers, with fake senders and a project opened by the real
 * ProjectService in a folder with Chinese characters and spaces. Covers sender and payload checks, one draft per
 * conversation in app data (never in the project folder), atomic replacement, damaged and newer files, the caps, the
 * chats without a project, and that no draft text reaches the log.
 */
const ORIGIN = 'noobide://app';
const CHAT_A = '00000000-0000-4000-8000-000000000001';
const MARKER = 'DRAFT-TEXT-MARKER-草稿';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

let dir: string;
let userData: string;
let projectRoot: string;
let projectId: string;
let projects: ProjectService;
let handlers: Map<string, Handler>;
let store: AiDraftStore;
let clock: number;
let appLog: AppLog;

function eventFor(url = `${ORIGIN}/index.html`, topLevel = true): IpcMainInvokeEvent {
  return { senderFrame: { url, parent: topLevel ? null : {} }, sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC results are checked by shape in each test
async function call(channel: string, payload?: unknown, event = eventFor()): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return payload === undefined ? handler(event) : handler(event, payload);
}

const draft = (prompt: string, extra: object = {}) => ({
  prompt,
  chips: [{ kind: 'selection', relPath: '脚本 文件/主.js', startLine: 3, endLine: 4, text: 'let 名字 = 1;' }],
  kind: 'chat',
  mode: 'chat',
  ...extra,
});

async function logText(): Promise<string> {
  const logs = appDataPath(userData, 'logs');
  const names = await readdir(logs).catch(() => [] as string[]);
  return (await Promise.all(names.map((n) => readFile(path.join(logs, n), 'utf8')))).join('\n');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-ai-drafts-'));
  userData = path.join(dir, '用户 数据');
  projectRoot = path.join(dir, '我的 项目');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'index.html'), '<h1>Hi</h1>\n');
  projects = new ProjectService();
  const opened = await projects.open(projectRoot);
  if (!opened.ok) throw new Error('project did not open');
  projectId = opened.value.projectId;
  clock = 1_000;
  appLog = new AppLog({ dir: appDataPath(userData, 'logs') });
  store = new AiDraftStore({
    dir: appDataPath(userData, 'aiDrafts'),
    now: () => (clock += 1),
    log: (event, fields) => appLog.write('warn', event, fields),
  });
  handlers = new Map();
  registerAiDraftIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, {
    allowedOrigin: ORIGIN,
    drafts: store,
    rootOf: (id) => projects.rootOf(id),
  });
}, REAL_IO.timeout);
afterEach(async () => {
  await removeTempDir(dir);
}, REAL_IO.timeout);

describe('unsent drafts over IPC (S48.7)', REAL_IO, () => {
  it('refuses senders that are not the workbench and malformed payloads', async () => {
    for (const channel of Object.values(AI_DRAFT_CHANNELS)) {
      const payload = { projectId, key: 'new', draft: null };
      expect(await call(channel, payload, eventFor('https://evil.example/'))).toMatchObject({
        code: 'forbidden-sender',
      });
      expect(await call(channel, payload, eventFor(undefined, false))).toMatchObject({ code: 'forbidden-sender' });
      expect(await call(channel, 'nope')).toMatchObject({ code: 'invalid-request' });
    }
    const bad = [
      { projectId, key: 'not-a-key', draft: null },
      { projectId, key: 'new' }, // draft missing
      { projectId: '../x', key: 'new', draft: null },
      { projectId, key: 'new', draft: { ...draft('x'), extra: 1 } },
      { projectId, key: 'new', draft: draft('x', { kind: 'root' }) },
      { projectId, key: 'new', draft: draft('x', { chips: [{ kind: 'file', relPath: '/etc/passwd' }] }) },
      { projectId, key: 'new', draft: draft('x', { chips: [{ kind: 'preview', label: '/' }] }) },
      { projectId, key: 'new', draft: draft('x'.repeat(AI_DRAFT_LIMITS.promptChars + 1)) },
    ];
    for (const payload of bad) {
      expect(await call(AI_DRAFT_CHANNELS.saveDraft, payload)).toMatchObject({ code: 'invalid-request' });
    }
    expect(await call(AI_DRAFT_CHANNELS.getDrafts, { projectId: 'x' })).toMatchObject({ code: 'invalid-request' });
    expect(
      await call(AI_DRAFT_CHANNELS.getDrafts, { projectId: '00000000-0000-4000-8000-00000000abcd' }),
    ).toMatchObject({ code: 'unknown-project' });
  });

  it('keeps one draft per conversation in app data, never in the project folder', async () => {
    expect(await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: 'new', draft: draft(`新的 ${MARKER}`) })).toEqual({
      ok: true,
      value: null,
    });
    await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: CHAT_A, draft: draft('follow-up') });
    await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: 'new', draft: draft(`改过的 ${MARKER}`) });
    const got = await call(AI_DRAFT_CHANNELS.getDrafts, { projectId });
    expect(got.value.drafts.map((d: { key: string; prompt: string }) => [d.key, d.prompt])).toEqual([
      ['new', `改过的 ${MARKER}`],
      [CHAT_A, 'follow-up'],
    ]);
    expect(got.value.drafts[0].chips).toEqual(draft('').chips);

    // Where it lives: app data, by the hash of the real root; the project folder is untouched.
    const file = path.join(appDataPath(userData, 'aiDrafts'), `${projectKey(projects.rootOf(projectId)!)}.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
    expect(await readdir(projectRoot)).toEqual(['index.html']);
    expect(await readdir(appDataPath(userData, 'aiDrafts'))).toEqual([path.basename(file)]); // no temp file left

    // An empty draft (or null) forgets it; the last one removes the file.
    await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: 'new', draft: { ...draft(''), chips: [] } });
    await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: CHAT_A, draft: null });
    expect((await call(AI_DRAFT_CHANNELS.getDrafts, { projectId })).value.drafts).toEqual([]);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await logText()).not.toContain(MARKER);
  });

  it('keeps the drafts of chats without a project in their own file', async () => {
    await call(AI_DRAFT_CHANNELS.saveDraft, { projectId: null, key: 'new', draft: draft('general') });
    expect((await call(AI_DRAFT_CHANNELS.getDrafts, { projectId: null })).value.drafts).toMatchObject([
      { key: 'new', prompt: 'general' },
    ]);
    expect((await call(AI_DRAFT_CHANNELS.getDrafts, { projectId })).value.drafts).toEqual([]);
    expect(await readdir(appDataPath(userData, 'aiDrafts'))).toEqual([NO_PROJECT_FILE]);
  });

  it('moves a damaged file aside, and never writes over a newer NoobIDE’s file', async () => {
    const file = store.file(projects.rootOf(projectId)!);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    expect((await call(AI_DRAFT_CHANNELS.getDrafts, { projectId })).value.drafts).toEqual([]);
    expect(await readdir(path.dirname(file))).toEqual([`${path.basename(file)}.corrupt`]);

    await writeFile(file, JSON.stringify({ version: 99, drafts: [] }));
    expect(await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: 'new', draft: draft('x') })).toMatchObject({
      ok: false,
      code: 'write-failed',
    });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 99, drafts: [] });
  });

  it('never writes over a file it cannot read (locked, no permission)', async () => {
    const file = store.file(projects.rootOf(projectId)!);
    await mkdir(file, { recursive: true }); // a folder in its place reads as EISDIR: unreadable, not damaged
    expect((await call(AI_DRAFT_CHANNELS.getDrafts, { projectId })).value.drafts).toEqual([]);
    expect(await call(AI_DRAFT_CHANNELS.saveDraft, { projectId, key: 'new', draft: draft('x') })).toMatchObject({
      ok: false,
      code: 'write-failed',
    });
    expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]); // nothing moved aside or replaced
    await store.flush();
  });

  it('drops a damaged draft without losing the others', async () => {
    const file = store.file(projects.rootOf(projectId)!);
    await mkdir(path.dirname(file), { recursive: true });
    const good = { key: CHAT_A, updatedAt: 5, ...draft('kept') };
    await writeFile(file, JSON.stringify({ version: 1, drafts: [{ key: 'new', updatedAt: 6, prompt: 7 }, good] }));
    expect((await call(AI_DRAFT_CHANNELS.getDrafts, { projectId })).value.drafts).toEqual([good]);
  });

  it('caps the drafts per project (the least recently changed go first) and the file size', async () => {
    for (let i = 0; i < AI_DRAFT_LIMITS.drafts + 3; i += 1) {
      const key = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await store.save(projects.rootOf(projectId)!, key, draft(`d${i}`) as never);
    }
    const kept = await store.list(projects.rootOf(projectId)!);
    expect(kept).toHaveLength(AI_DRAFT_LIMITS.drafts);
    expect(kept[0]?.prompt).toBe(`d${AI_DRAFT_LIMITS.drafts + 2}`);
    expect(kept.some((d) => d.prompt === 'd0')).toBe(false);

    const small = new AiDraftStore({ dir: path.join(dir, 'small'), limits: { maxBytesPerFile: 2_000 } });
    expect((await small.save(null, 'new', draft('x'.repeat(1_500)) as never)).ok).toBe(true);
    expect((await small.save(null, CHAT_A, draft('y'.repeat(1_500)) as never)).ok).toBe(true);
    expect((await small.list(null)).map((d) => d.key)).toEqual([CHAT_A]); // the older one made room
    expect(await small.save(null, 'new', draft('z'.repeat(5_000)) as never)).toMatchObject({
      ok: false,
      code: 'too-large',
    });
  });
});
