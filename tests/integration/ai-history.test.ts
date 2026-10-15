import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiChatStore } from '../../src/ai/chat-store';
import { AiConfigStore, AiConsentStore } from '../../src/ai/config-store';
import { createFakeProviders, parseFakeScript } from '../../src/ai/fake-provider';
import { createTestEncryptor, KeyStore } from '../../src/ai/keys';
import { AiService } from '../../src/ai/service';
import { AiUsageStore } from '../../src/ai/usage-store';
import { createAgentRunner } from '../../src/ai/agent/runner';
import { createProjectPorts } from '../../src/ai/agent/ports';
import type { ModelPort } from '../../src/ai/agent/model-port';
import { ScriptedModel, type TurnScript } from '../../src/ai/agent/scripted-model';
import { registerAiHistoryIpcHandlers } from '../../src/main/ai-history-ipc';
import { registerAiIpcHandlers } from '../../src/main/ai-ipc';
import { appDataPath } from '../../src/main/app-data-layout';
import { AppLog } from '../../src/main/app-log';
import { ProjectService } from '../../src/workspace/project-service';
import { AI_CHANNELS, type AiEvent } from '../../src/shared/ipc/ai-contract';
import { AI_HISTORY_CHANNELS } from '../../src/shared/ipc/ai-history-contract';

/**
 * S39 integration: the real chat and usage stores, the AI request service with the scripted fake provider (no
 * network), and both IPC handler sets with fake senders. Covers sender and payload checks, saved chats per project in
 * app data (never in the project), the recent-list hooks, token usage per day/provider for chat, inline, edit and
 * agent requests, the daily budget (refusing new requests, a running agent turn finishing, day rollover), and that no
 * chat text reaches the log.
 */
const ORIGIN = 'noobide://app';
const RECENT = '5e1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const CHAT_ID = '00000000-0000-4000-8000-000000000001';
const MARKER = 'CHAT-TEXT-MARKER-问题';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

let dir: string;
let userData: string;
let projectRoot: string;
let projectId: string;
let projects: ProjectService;
let handlers: Map<string, Handler>;
let sent: AiEvent[];
let clock: number;
let appLog: AppLog;
let agentScript: TurnScript[];
/** When set, every agent model call after the first waits for it (holds a turn mid-way without relying on timing). */
let laterCallsWait: Promise<void> | null;
let service: AiService;

function eventFor(url = `${ORIGIN}/index.html`, topLevel = true): IpcMainInvokeEvent {
  return {
    senderFrame: { url, parent: topLevel ? null : {} },
    sender: {
      id: 1,
      isDestroyed: () => false,
      send: (_channel: string, event: AiEvent) => sent.push(event),
      once: () => undefined,
      on: () => undefined,
    },
  } as unknown as IpcMainInvokeEvent;
}

/** The scripted agent model, with calls after the first held until {@link laterCallsWait} settles. */
function gatedModel(port: ModelPort): ModelPort {
  let calls = 0;
  return {
    provider: port.provider,
    ...(port.acceptsImages !== undefined ? { acceptsImages: port.acceptsImages } : {}),
    streamTurn: (request) => {
      const index = calls;
      calls += 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (index > 0 && laterCallsWait) await laterCallsWait;
          yield* port.streamTurn(request);
        },
      };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC results are checked by shape in each test
async function call(channel: string, payload?: unknown): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return payload === undefined ? handler(eventFor()) : handler(eventFor(), payload);
}

async function finished(requestId: string): Promise<AiEvent[]> {
  for (let i = 0; i < 400; i += 1) {
    const events = sent.filter((e) => e.requestId === requestId);
    if (events.some((e) => e.type === 'done' || e.type === 'error')) return events;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('request did not finish');
}

async function logText(): Promise<string> {
  const logs = appDataPath(userData, 'logs');
  const names = await readdir(logs).catch(() => [] as string[]);
  return (await Promise.all(names.map((n) => readFile(path.join(logs, n), 'utf8')))).join('\n');
}

async function setup() {
  const hub = createFakeProviders(
    parseFakeScript({
      turns: [
        {
          purpose: 'chat',
          repeat: true,
          steps: [{ type: 'text', text: 'Hi!' }],
          usage: { inputTokens: 300, outputTokens: 100 },
        },
        {
          purpose: 'inline',
          repeat: true,
          steps: [{ type: 'text', text: 'x' }],
          usage: { inputTokens: 40, outputTokens: 2 },
        },
        {
          purpose: 'edit',
          repeat: true,
          steps: [{ type: 'text', text: 'a{}' }],
          usage: { inputTokens: 50, outputTokens: 5 },
        },
      ],
    }),
  );
  appLog = new AppLog({ dir: appDataPath(userData, 'logs') });
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
    appLog.write('warn', event, fields);
  const usage = new AiUsageStore({ file: appDataPath(userData, 'aiUsage'), log, now: () => clock });
  const chats = new AiChatStore({ dir: appDataPath(userData, 'aiChats'), log, now: () => clock });
  service = new AiService({
    keys: new KeyStore({ file: appDataPath(userData, 'aiKeys'), encryptor: createTestEncryptor(true), log }),
    config: new AiConfigStore({ file: appDataPath(userData, 'aiConfig'), log }),
    consent: new AiConsentStore({ file: appDataPath(userData, 'aiConsent'), log }),
    providers: hub.factory,
    rootOf: (id) => projects.rootOf(id),
    readFile: async () => null,
    agentRunner: createAgentRunner({ projectPorts: (id) => createProjectPorts({ projects, projectId: id }) }),
    agentModel: () => gatedModel(new ScriptedModel(agentScript)),
    log: (level, event, fields) => appLog.write(level, event, fields),
    usage,
  });
  handlers = new Map();
  const ipc = { handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never;
  registerAiIpcHandlers(ipc, { allowedOrigin: ORIGIN, service });
  registerAiHistoryIpcHandlers(ipc, {
    allowedOrigin: ORIGIN,
    chats,
    usage,
    rootOf: (id) => projects.rootOf(id),
    // Main records recent entries by the project's real root (ProjectService realpath), not the path as typed: on CI
    // the temp dir is a symlink (macOS /var) or an 8.3 short name (Windows RUNNER~1), so the raw path never matches.
    recentRootOf: async (id) => (id === RECENT ? projects.rootOf(projectId) : undefined),
  });
  expect(await call(AI_CHANNELS.setKey, { provider: 'anthropic', key: 'sk-ant-test-0123456789' })).toEqual({
    ok: true,
    value: null,
  });
  expect(await call(AI_CHANNELS.setConsent, { projectId, allowed: true })).toEqual({ ok: true, value: null });
}

const savedChat = (prompt: string) => ({
  id: CHAT_ID,
  title: 'About page',
  turns: [
    {
      kind: 'chat',
      mode: 'chat',
      prompt,
      context: [{ kind: 'file', relPath: 'index.html' }],
      status: 'done',
      parts: [{ kind: 'text', text: `Answer ${MARKER}` }],
      usage: { inputTokens: 300, outputTokens: 100 },
    },
  ],
});

const chatRequest = (prompt: string) => ({
  kind: 'chat',
  projectId,
  history: [],
  prompt,
  context: [],
  locale: 'en',
});
const inlineRequest = () => ({
  kind: 'inline',
  projectId,
  relPath: 'index.html',
  languageId: 'html',
  prefix: '<h1>',
  suffix: '',
});
const editRequest = () => ({
  kind: 'edit',
  projectId,
  relPath: 'style.css',
  languageId: 'css',
  instruction: 'blue',
  selection: 'a{}',
  before: '',
  after: '',
  locale: 'en',
});
const agentRequest = (prompt: string) => ({ kind: 'agent', projectId, history: [], prompt, context: [], locale: 'en' });

async function run(payload: unknown): Promise<AiEvent[]> {
  const started = await call(AI_CHANNELS.request, payload);
  expect(started).toMatchObject({ ok: true });
  return finished(started.value.requestId as string);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-ai-history-'));
  userData = path.join(dir, '用户 数据');
  projectRoot = path.join(dir, '我的 项目');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'index.html'), '<h1>Hi</h1>\n');
  projects = new ProjectService();
  const opened = await projects.open(projectRoot);
  if (!opened.ok) throw new Error('project did not open');
  projectId = opened.value.projectId;
  sent = [];
  clock = new Date(2026, 9, 15, 12).getTime();
  agentScript = [];
  laterCallsWait = null;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('saved chats over IPC (S39.1)', () => {
  it('refuses senders that are not the workbench and malformed payloads on every channel', async () => {
    await setup();
    for (const channel of Object.values(AI_HISTORY_CHANNELS)) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      for (const event of [eventFor('http://127.0.0.1:5000/index.html'), eventFor(`${ORIGIN}/index.html`, false)]) {
        expect(await handler?.(event, { projectId })).toMatchObject({ code: 'forbidden-sender' });
      }
    }
    const bad: [string, unknown][] = [
      [AI_HISTORY_CHANNELS.listChats, { projectId: '../x' }],
      [AI_HISTORY_CHANNELS.listChats, { projectId, extra: 1 }],
      [AI_HISTORY_CHANNELS.getChat, { projectId, chatId: '../../ai-keys' }],
      [AI_HISTORY_CHANNELS.saveChat, { projectId, chat: { ...savedChat('q'), id: 'conv1' } }],
      [AI_HISTORY_CHANNELS.saveChat, { projectId, chat: { ...savedChat('q'), turns: [] } }],
      [AI_HISTORY_CHANNELS.deleteChat, { projectId }],
      [AI_HISTORY_CHANNELS.deleteProjectChats, {}],
      [AI_HISTORY_CHANNELS.countRecentChats, { id: 'nope' }],
      [AI_HISTORY_CHANNELS.deleteRecentChats, { id: RECENT, all: true }],
      [AI_HISTORY_CHANNELS.usage, { day: 'today' }],
      [AI_HISTORY_CHANNELS.setDailyBudget, { dailyTokens: 10 }],
      [AI_HISTORY_CHANNELS.setDailyBudget, { dailyTokens: '5000' }],
    ];
    for (const [channel, payload] of bad) {
      expect(await call(channel, payload)).toMatchObject({ ok: false, code: 'invalid-request' });
    }
    expect(await handlers.get(AI_HISTORY_CHANNELS.listChats)?.(eventFor(), { projectId }, 'second')).toMatchObject({
      code: 'invalid-request',
    });
    await expect(readdir(appDataPath(userData, 'aiChats'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('saves, lists, reopens and deletes chats of the open project in app data only; no chat text is logged', async () => {
    await setup();
    expect(await call(AI_HISTORY_CHANNELS.listChats, { projectId })).toEqual({
      ok: true,
      value: { chats: [], skipped: 0 },
    });
    const saved = await call(AI_HISTORY_CHANNELS.saveChat, { projectId, chat: savedChat(`Make a page ${MARKER}`) });
    expect(saved).toMatchObject({ ok: true, value: { id: CHAT_ID, title: 'About page', turnCount: 1 } });
    const listed = await call(AI_HISTORY_CHANNELS.listChats, { projectId });
    expect(listed.value.chats).toEqual([
      { id: CHAT_ID, title: 'About page', createdAt: clock, updatedAt: clock, turnCount: 1 },
    ]);
    const got = await call(AI_HISTORY_CHANNELS.getChat, { projectId, chatId: CHAT_ID });
    expect(got).toMatchObject({ ok: true, value: { id: CHAT_ID, turns: [{ prompt: `Make a page ${MARKER}` }] } });

    // Only `.noobide/project.json` could ever be written into a project; chats never are.
    expect(await readdir(projectRoot)).toEqual(['index.html']);
    const files = await readdir(appDataPath(userData, 'aiChats'), { recursive: true });
    expect(files.some((f) => f.endsWith(`${CHAT_ID}.json`))).toBe(true);
    expect(files.join('\n')).not.toContain('我的 项目');

    // A project that is not open is refused.
    const other = '9a1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
    expect(await call(AI_HISTORY_CHANNELS.listChats, { projectId: other })).toMatchObject({ code: 'unknown-project' });
    expect(await call(AI_HISTORY_CHANNELS.saveChat, { projectId: other, chat: savedChat('q') })).toMatchObject({
      code: 'unknown-project',
    });
    expect(await call(AI_HISTORY_CHANNELS.getChat, { projectId, chatId: CHAT_ID.replace(/1$/, '2') })).toMatchObject({
      code: 'not-found',
    });

    expect(await call(AI_HISTORY_CHANNELS.deleteChat, { projectId, chatId: CHAT_ID })).toEqual({
      ok: true,
      value: null,
    });
    expect((await call(AI_HISTORY_CHANNELS.listChats, { projectId })).value.chats).toEqual([]);
    expect(await logText()).not.toContain(MARKER);
  });

  it('a damaged chat file is skipped with a count, not a crash', async () => {
    await setup();
    await call(AI_HISTORY_CHANNELS.saveChat, { projectId, chat: savedChat('q') });
    const folder = path.join(
      appDataPath(userData, 'aiChats'),
      (await readdir(appDataPath(userData, 'aiChats')))[0] ?? '',
    );
    await writeFile(path.join(folder, '00000000-0000-4000-8000-000000000009.json'), '{ "version": 1, "id": [');
    const listed = await call(AI_HISTORY_CHANNELS.listChats, { projectId });
    expect(listed).toMatchObject({ ok: true, value: { skipped: 1, chats: [{ id: CHAT_ID }] } });
  });

  it('revoking consent can delete the project’s chats; a recent entry’s chats are counted and deleted by id', async () => {
    await setup();
    await call(AI_HISTORY_CHANNELS.saveChat, { projectId, chat: savedChat('q') });
    expect(await call(AI_HISTORY_CHANNELS.countRecentChats, { id: RECENT })).toEqual({ ok: true, value: { count: 1 } });
    expect(await call(AI_HISTORY_CHANNELS.countRecentChats, { id: CHAT_ID })).toMatchObject({ code: 'unknown-recent' });
    expect(await call(AI_HISTORY_CHANNELS.deleteRecentChats, { id: RECENT })).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    await call(AI_HISTORY_CHANNELS.saveChat, { projectId, chat: savedChat('again') });
    expect(await call(AI_CHANNELS.setConsent, { projectId, allowed: false })).toEqual({ ok: true, value: null });
    expect(await call(AI_HISTORY_CHANNELS.deleteProjectChats, { projectId })).toEqual({
      ok: true,
      value: { deleted: 1 },
    });
    expect((await call(AI_HISTORY_CHANNELS.listChats, { projectId })).value.chats).toEqual([]);
  });
});

describe('token usage and the daily budget (S39.2)', () => {
  it('counts chat, inline, edit and agent tokens per provider for today', async () => {
    await setup();
    agentScript = [
      { toolCalls: [{ name: 'list_files', input: {} }], usage: { inputTokens: 1000, outputTokens: 20 } },
      { text: ['Done.'], usage: { inputTokens: 1100, outputTokens: 30 } },
    ];
    const chatEvents = await run(chatRequest('hello'));
    expect(chatEvents.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 300, outputTokens: 100 } });
    expect((await run(inlineRequest())).at(-1)).toMatchObject({ type: 'done' });
    expect((await run(editRequest())).at(-1)).toMatchObject({
      type: 'done',
      usage: { inputTokens: 50, outputTokens: 5 },
    });
    const agentEvents = await run(agentRequest('look around'));
    expect(agentEvents.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 2100, outputTokens: 50 } });
    const usage = await call(AI_HISTORY_CHANNELS.usage);
    expect(usage).toEqual({
      ok: true,
      value: {
        day: '2026-10-15',
        perProvider: {
          anthropic: { inputTokens: 300 + 40 + 50 + 2100, outputTokens: 100 + 2 + 5 + 50 },
          openai: { inputTokens: 0, outputTokens: 0 },
        },
        totalTokens: 2490 + 157,
        dailyBudget: null,
        budgetReached: false,
      },
    });
    // The log has token counts, never the prompts.
    expect(await logText()).not.toContain('look around');
  });

  it('refuses new requests once the budget is reached, lets a running agent turn finish, and resets the next day', async () => {
    await setup();
    expect(await call(AI_HISTORY_CHANNELS.setDailyBudget, { dailyTokens: 1000 })).toMatchObject({
      ok: true,
      value: { dailyBudget: 1000, budgetReached: false },
    });
    // Step 1 of the turn already goes over the budget; the turn still runs its next step and ends with 'done'.
    // Step 2 is held until the mid-turn checks are done: a fixed delay raced the budget check's queued usage write,
    // which on a loaded machine took longer than the delay and let the turn end before `active` was checked.
    agentScript = [
      { toolCalls: [{ name: 'list_files', input: {} }], usage: { inputTokens: 1200, outputTokens: 10 } },
      { text: ['Finished anyway.'], usage: { inputTokens: 1300, outputTokens: 20 } },
    ];
    let releaseStep2 = () => undefined as void;
    laterCallsWait = new Promise<void>((resolve) => (releaseStep2 = resolve));
    const started = await call(AI_CHANNELS.request, agentRequest('build it'));
    expect(started).toMatchObject({ ok: true });
    const id = started.value.requestId as string;
    await expect
      .poll(() => sent.some((e) => e.requestId === id && e.type === 'step'), { timeout: 10_000, interval: 5 })
      .toBe(true);
    // Mid-turn: the budget is reached, so a new request is refused while the turn keeps going.
    expect(await call(AI_CHANNELS.request, chatRequest('hello'))).toMatchObject({ ok: false, code: 'budget-reached' });
    expect(service.active).toContain(id);
    releaseStep2();
    const events = await finished(id);
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { inputTokens: 2500, outputTokens: 30 } });
    expect(events.some((e) => e.type === 'text' && e.text.includes('Finished anyway.'))).toBe(true);

    // Every kind of new AI request is refused with the explained code; the status says inline suggestions pause.
    for (const request of [chatRequest('hello'), inlineRequest(), editRequest(), agentRequest('again')]) {
      expect(await call(AI_CHANNELS.request, request)).toMatchObject({ ok: false, code: 'budget-reached' });
    }
    expect((await call(AI_CHANNELS.status, { projectId })).value).toMatchObject({ budgetReached: true });
    expect((await call(AI_HISTORY_CHANNELS.usage)).value).toMatchObject({ totalTokens: 2530, budgetReached: true });

    // Non-AI work is not blocked: saving a chat, reading a project file.
    expect(await call(AI_HISTORY_CHANNELS.saveChat, { projectId, chat: savedChat('q') })).toMatchObject({ ok: true });
    expect(await projects.read({ projectId, relPath: 'index.html' })).toMatchObject({ ok: true });

    // A new local day starts from zero.
    clock = new Date(2026, 9, 16, 0, 0, 1).getTime();
    expect((await call(AI_CHANNELS.status, { projectId })).value).toMatchObject({ budgetReached: false });
    expect((await run(chatRequest('hello'))).at(-1)).toMatchObject({ type: 'done' });
    expect((await call(AI_HISTORY_CHANNELS.usage)).value).toMatchObject({ day: '2026-10-16', totalTokens: 400 });

    // Switching the budget off lifts the pause at once.
    clock = new Date(2026, 9, 15, 12).getTime();
    expect((await call(AI_HISTORY_CHANNELS.usage)).value).toMatchObject({ budgetReached: true });
    expect((await call(AI_HISTORY_CHANNELS.setDailyBudget, { dailyTokens: null })).value).toMatchObject({
      dailyBudget: null,
      budgetReached: false,
    });
    // Awaited to the end, and its usage write drained (reads queue behind writes): a request left running writes
    // ai-usage.json while afterEach removes the folder (seen once as ENOTEMPTY on '用户 数据').
    expect((await run(inlineRequest())).at(-1)).toMatchObject({ type: 'done' });
    expect((await call(AI_HISTORY_CHANNELS.usage)).value).toMatchObject({ day: '2026-10-15', totalTokens: 2530 + 42 });
    expect(await logText()).toContain('ai-budget-refused');
  });
});
