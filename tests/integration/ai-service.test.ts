import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiConfigStore, AiConsentStore } from '../../src/ai/config-store';
import { createFakeProviders, parseFakeScript, type FakeProviderHub } from '../../src/ai/fake-provider';
import { createTestEncryptor, KeyStore } from '../../src/ai/keys';
import { AiService } from '../../src/ai/service';
import { createAgentRunner, type AgentRunner } from '../../src/ai/agent/runner';
import { createProjectPorts } from '../../src/ai/agent/ports';
import { ProjectService } from '../../src/workspace/project-service';
import { registerAiIpcHandlers } from '../../src/main/ai-ipc';
import { appDataPath } from '../../src/main/app-data-layout';
import { AppLog } from '../../src/main/app-log';
import { AI_CHANNELS, type AiEvent } from '../../src/shared/ipc/ai-contract';

/**
 * S31.2 / S31.3 integration: the real AiService, key store, config and consent stores, the AI IPC handlers and the
 * app log, with the scripted fake provider (no network). Covers sender and payload validation, consent, streaming,
 * cancel, error mapping, budgets, the agent hook, and that the key never appears in an IPC response, an event, the
 * log or the key file.
 */
const ORIGIN = 'noobide://app';
const PROJECT = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const OTHER_PROJECT = '9a1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const KEY = 'sk-ant-api03-TOPSECRET-0123456789abcdefghijklmnopqrstuvwxyz';
const BAD_KEY = 'sk-bad-key-REJECTED-000';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

interface FakeSender {
  id: number;
  sent: AiEvent[];
  destroyed: boolean;
  onDestroyed?: () => void;
  /** Listeners registered with `on` (did-start-navigation, render-process-gone). */
  listeners: Map<string, ((details?: unknown) => void)[]>;
}

let dir: string;
let userData: string;
let handlers: Map<string, Handler>;
let responses: unknown[];
let hub: FakeProviderHub;
let service: AiService;
let appLog: AppLog;
let projectFiles: Record<string, string>;
let agentRunner: AgentRunner | undefined;

function makeSender(id: number): FakeSender {
  return { id, sent: [], destroyed: false, listeners: new Map() };
}

function eventFor(sender: FakeSender, url = `${ORIGIN}/index.html`, topLevel = true): IpcMainInvokeEvent {
  return {
    senderFrame: { url, parent: topLevel ? null : {} },
    sender: {
      id: sender.id,
      isDestroyed: () => sender.destroyed,
      send: (_channel: string, event: AiEvent) => sender.sent.push(event),
      once: (_name: string, listener: () => void) => {
        sender.onDestroyed = listener;
      },
      on: (name: string, listener: (details?: unknown) => void) => {
        sender.listeners.set(name, [...(sender.listeners.get(name) ?? []), listener]);
      },
    },
  } as unknown as IpcMainInvokeEvent;
}

let win: FakeSender;
let win2: FakeSender;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC results are checked by shape in each test
async function call(channel: string, sender: FakeSender, payload?: unknown): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  const result = await (payload === undefined ? handler(eventFor(sender)) : handler(eventFor(sender), payload));
  responses.push(result);
  return result;
}

async function setup(
  script: unknown,
  options: { runner?: AgentRunner; secure?: boolean; rootOf?: (id: string) => string | undefined } = {},
) {
  hub = createFakeProviders(parseFakeScript(script));
  agentRunner = options.runner;
  appLog = new AppLog({ dir: appDataPath(userData, 'logs') });
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) =>
    appLog.write('warn', event, fields);
  service = new AiService({
    keys: new KeyStore({
      file: appDataPath(userData, 'aiKeys'),
      encryptor: createTestEncryptor(options.secure ?? true),
      log,
    }),
    config: new AiConfigStore({ file: appDataPath(userData, 'aiConfig'), log }),
    consent: new AiConsentStore({ file: appDataPath(userData, 'aiConsent'), log }),
    providers: hub.factory,
    rootOf: options.rootOf ?? ((id) => (id === PROJECT ? path.join(dir, '我的 项目') : undefined)),
    readFile: async (_id, relPath) => projectFiles[relPath] ?? null,
    ...(agentRunner ? { agentRunner } : {}),
    log: (level, event, fields) => appLog.write(level, event, fields),
    budgets: { inline: { maxOutputTokens: 50, timeoutMs: 300, effort: 'low' } },
  });
  handlers = new Map();
  registerAiIpcHandlers({ handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never, {
    allowedOrigin: ORIGIN,
    service,
  });
}

async function finished(sender: FakeSender, requestId: string): Promise<AiEvent[]> {
  for (let i = 0; i < 200; i += 1) {
    const events = sender.sent.filter((e) => e.requestId === requestId);
    if (events.some((e) => e.type === 'done' || e.type === 'error')) return events;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('request did not finish');
}

const chat = (prompt: string, extra: Record<string, unknown> = {}) => ({
  kind: 'chat',
  projectId: PROJECT,
  history: [],
  prompt,
  context: [],
  locale: 'zh-CN',
  ...extra,
});

async function storeKey(key = KEY) {
  expect(await call(AI_CHANNELS.setKey, win, { provider: 'anthropic', key })).toEqual({ ok: true, value: null });
}

async function logText(): Promise<string> {
  const logs = appDataPath(userData, 'logs');
  const names = await readdir(logs).catch(() => [] as string[]);
  return (await Promise.all(names.map((n) => readFile(path.join(logs, n), 'utf8')))).join('\n');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-ai-'));
  userData = path.join(dir, '用户 数据');
  responses = [];
  projectFiles = { 'index.html': '<h1>PROJECT-CODE-MARKER</h1>' };
  win = makeSender(1);
  win2 = makeSender(2);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// Real file-system I/O: a starved hosted Windows runner can take well over Vitest's 5 s default (S58.10, as S58.9).
const REAL_IO = { timeout: 60_000 };

describe('AI IPC and service (S31.3)', REAL_IO, () => {
  it('refuses senders that are not the workbench and malformed payloads on every channel', async () => {
    await setup({});
    for (const channel of Object.values(AI_CHANNELS)) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      for (const event of [
        eventFor(win, 'http://127.0.0.1:5000/index.html'),
        eventFor(win, `${ORIGIN}/index.html`, false),
      ]) {
        expect(await handler?.(event, { provider: 'anthropic' })).toMatchObject({ code: 'forbidden-sender' });
      }
    }
    const bad: [string, unknown][] = [
      [AI_CHANNELS.setKey, { provider: 'anthropic' }],
      [AI_CHANNELS.setKey, { provider: 'gemini', key: 'x' }],
      [AI_CHANNELS.setKey, { provider: 'anthropic', key: 'x'.repeat(600) }],
      [AI_CHANNELS.testKey, { provider: 'anthropic', extra: 1 }],
      [AI_CHANNELS.status, { projectId: '../x' }],
      [AI_CHANNELS.setConfig, { config: { enabled: true } }],
      [AI_CHANNELS.setConsent, { projectId: PROJECT, allowed: 'yes' }],
      [AI_CHANNELS.request, { kind: 'shell', command: 'rm -rf /' }],
      [AI_CHANNELS.request, chat('x', { locale: 'fr' })],
      [AI_CHANNELS.request, chat('x', { context: [{ kind: 'file', relPath: '../secret' }] })],
      [AI_CHANNELS.request, chat('x', { projectId: null, context: [{ kind: 'file', relPath: 'a.html' }] })],
      [
        AI_CHANNELS.request,
        {
          kind: 'inline',
          projectId: PROJECT,
          relPath: 'a.js',
          languageId: 'javascript',
          prefix: 'x'.repeat(50_000),
          suffix: '',
        },
      ],
      [AI_CHANNELS.cancel, { requestId: 'nope' }],
      [AI_CHANNELS.resolveProposal, { requestId: PROJECT, proposalId: 'p', results: [{ accepted: 'yes' }] }],
    ];
    for (const [channel, payload] of bad) {
      expect(await call(channel, win, payload)).toMatchObject({ ok: false, code: 'invalid-request' });
    }
    expect(hub.requests).toHaveLength(0);
  });

  it('stores a key that never comes back in IPC responses, events, logs or the key file (S31.2)', async () => {
    await setup({ turns: [{ match: 'hello', steps: [{ type: 'text', text: 'Hi!' }] }] });
    const before = await call(AI_CHANNELS.status, win, { projectId: PROJECT });
    expect(before).toMatchObject({
      ok: true,
      value: {
        keyStored: { anthropic: false, openai: false },
        secureStorage: true,
        projectConsent: false,
        config: { enabled: true, provider: null, inlineCompletions: true },
      },
    });
    await storeKey();
    const status = await call(AI_CHANNELS.status, win, { projectId: PROJECT });
    expect(status.value).toMatchObject({
      keyStored: { anthropic: true, openai: false },
      config: { provider: 'anthropic' },
    });
    expect(status.value.config.models).toEqual({
      chat: 'claude-opus-5-5',
      agent: 'claude-opus-5-5',
      edit: 'claude-opus-5-5',
      inline: 'claude-haiku-5-5',
    });
    expect(await call(AI_CHANNELS.testKey, win, { provider: 'anthropic' })).toEqual({ ok: true, value: null });
    expect((await call(AI_CHANNELS.listModels, win, { provider: 'anthropic' })).ok).toBe(true);
    const started = await call(AI_CHANNELS.request, win, chat('hello', { projectId: null }));
    const events = await finished(win, started.value.requestId);
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);

    const everything = JSON.stringify([responses, win.sent]);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain('TOPSECRET');
    const log = await logText();
    expect(log).toContain('ai-key-stored');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain('TOPSECRET');
    const keyFile = await readFile(appDataPath(userData, 'aiKeys'), 'utf8');
    expect(keyFile).not.toContain(KEY);
    expect(keyFile).not.toContain('TOPSECRET');
    for (const name of await readdir(userData)) {
      if (name === 'logs') continue;
      expect(await readFile(path.join(userData, name), 'utf8')).not.toContain('TOPSECRET');
    }

    expect(await call(AI_CHANNELS.clearKey, win, { provider: 'anthropic' })).toEqual({ ok: true, value: null });
    expect((await call(AI_CHANNELS.status, win, {})).value.keyStored.anthropic).toBe(false);
    expect(await call(AI_CHANNELS.request, win, chat('hello', { projectId: null }))).toMatchObject({ code: 'no-key' });
  });

  it('without secure storage the key is not stored and AI stays off (S31.2)', async () => {
    await setup({}, { secure: false });
    expect(await call(AI_CHANNELS.setKey, win, { provider: 'openai', key: KEY })).toMatchObject({
      ok: false,
      code: 'no-secure-storage',
    });
    const status = await call(AI_CHANNELS.status, win, {});
    expect(status.value).toMatchObject({ secureStorage: false, keyStored: { anthropic: false, openai: false } });
    expect(await call(AI_CHANNELS.request, win, chat('hi', { projectId: null }))).toMatchObject({ code: 'no-key' });
  });

  it('explains a rejected key and offline tests', async () => {
    await setup({ rejectKeys: [BAD_KEY] });
    await storeKey(BAD_KEY);
    expect(await call(AI_CHANNELS.testKey, win, { provider: 'anthropic' })).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });
    expect(await call(AI_CHANNELS.testKey, win, { provider: 'openai' })).toMatchObject({ ok: false, code: 'no-key' });
    await setup({ testError: 'offline' });
    expect(await call(AI_CHANNELS.testKey, win, { provider: 'anthropic' })).toMatchObject({ code: 'offline' });
  });

  it('refuses project code until the project is allowed; consent is revocable and remembered', async () => {
    await setup({ defaultTurn: { steps: [{ type: 'text', text: 'answer' }] } });
    await storeKey();
    const withFile = chat('what is this?', { context: [{ kind: 'file', relPath: 'index.html' }] });
    expect(await call(AI_CHANNELS.request, win, withFile)).toMatchObject({ ok: false, code: 'no-consent' });
    const inline = {
      kind: 'inline',
      projectId: PROJECT,
      relPath: 'a.js',
      languageId: 'javascript',
      prefix: 'let',
      suffix: '',
    };
    expect(await call(AI_CHANNELS.request, win, inline)).toMatchObject({ code: 'no-consent' });
    // A question without project context needs no consent.
    expect((await call(AI_CHANNELS.request, win, chat('general question'))).ok).toBe(true);
    expect(await call(AI_CHANNELS.setConsent, win, { projectId: OTHER_PROJECT, allowed: true })).toMatchObject({
      code: 'unknown-project',
    });
    expect(await call(AI_CHANNELS.request, win, chat('x', { projectId: OTHER_PROJECT }))).toMatchObject({
      code: 'unknown-project',
    });

    expect(await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true })).toEqual({
      ok: true,
      value: null,
    });
    expect((await call(AI_CHANNELS.status, win, { projectId: PROJECT })).value.projectConsent).toBe(true);
    const started = await call(AI_CHANNELS.request, win, withFile);
    expect(started.ok).toBe(true);
    await finished(win, started.value.requestId);
    // The file was re-read from disk by main and sent as data inside <context>.
    const sent = hub.requests.at(-1)?.messages.at(-1);
    expect(sent?.role === 'user' && sent.text).toContain('<context>');
    expect(sent?.role === 'user' && sent.text).toContain('PROJECT-CODE-MARKER');
    expect(hub.requests.at(-1)?.system).toContain('Simplified Chinese');
    // The consent file holds a hash, not the path.
    const consent = await readFile(appDataPath(userData, 'aiConsent'), 'utf8');
    expect(consent).not.toContain('我的 项目');
    expect(consent).toMatch(/[0-9a-f]{64}/);

    expect(await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: false })).toEqual({
      ok: true,
      value: null,
    });
    expect(await call(AI_CHANNELS.request, win, withFile)).toMatchObject({ code: 'no-consent' });
    // Logs carry ids, purpose, model and counts — never the prompt or the code.
    const log = await logText();
    expect(log).toContain('"event":"ai-request"');
    expect(log).toContain('"purpose":"chat"');
    expect(log).toContain('"model":"claude-opus-5-5"');
    expect(log).not.toContain('PROJECT-CODE-MARKER');
    expect(log).not.toContain('what is this');
    expect(log).not.toContain('answer');
  });

  it('switching AI off refuses requests; inline can be switched off on its own', async () => {
    await setup({});
    await storeKey();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    const config = (await call(AI_CHANNELS.status, win, {})).value.config;
    expect(await call(AI_CHANNELS.setConfig, win, { config: { ...config, inlineCompletions: false } })).toMatchObject({
      ok: true,
      value: { inlineCompletions: false },
    });
    const inline = {
      kind: 'inline',
      projectId: PROJECT,
      relPath: 'a.js',
      languageId: 'javascript',
      prefix: 'let',
      suffix: '',
    };
    expect(await call(AI_CHANNELS.request, win, inline)).toMatchObject({ code: 'disabled' });
    expect((await call(AI_CHANNELS.request, win, chat('x'))).ok).toBe(true);
    await call(AI_CHANNELS.setConfig, win, { config: { ...config, enabled: false } });
    expect(await call(AI_CHANNELS.request, win, chat('x'))).toMatchObject({ code: 'disabled' });
    // Persisted with a schema version.
    expect(JSON.parse(await readFile(appDataPath(userData, 'aiConfig'), 'utf8'))).toMatchObject({
      version: 1,
      enabled: false,
      provider: 'anthropic',
    });
  });

  it('revoking consent, switching AI off or removing the key stops running requests; follow-ups need consent (S36.1)', async () => {
    await setup({
      turns: [
        {
          match: 'slow',
          repeat: true,
          steps: [
            { type: 'text', text: 'part' },
            { type: 'delay', ms: 5_000 },
            { type: 'text', text: 'never' },
          ],
        },
      ],
      defaultTurn: { steps: [{ type: 'text', text: 'answer' }] },
    });
    await storeKey();
    const config = (await call(AI_CHANNELS.status, win, {})).value.config;
    const slow = chat('slow', { context: [{ kind: 'file', relPath: 'index.html' }] });
    const startRunning = async (): Promise<string> => {
      const started = await call(AI_CHANNELS.request, win, slow);
      expect(started.ok).toBe(true);
      const id = started.value.requestId as string;
      for (let i = 0; i < 200 && !win.sent.some((e) => e.requestId === id && e.type === 'text'); i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return id;
    };
    const expectCancelled = async (id: string) => {
      expect((await finished(win, id)).at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });
      expect(service.active).not.toContain(id);
    };

    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    let id = await startRunning();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: false });
    await expectCancelled(id);

    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    id = await startRunning();
    await call(AI_CHANNELS.setConfig, win, { config: { ...config, enabled: false } });
    await expectCancelled(id);

    await call(AI_CHANNELS.setConfig, win, { config: { ...config, enabled: true } });
    id = await startRunning();
    expect(await call(AI_CHANNELS.clearKey, win, { provider: 'anthropic' })).toEqual({ ok: true, value: null });
    await expectCancelled(id);

    // A follow-up in a project without consent carries the earlier turns (which quote code): refused.
    await storeKey();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: false });
    const followUp = chat('and this?', {
      history: [
        { role: 'user', text: 'what is <h1>PROJECT-CODE-MARKER</h1>?' },
        { role: 'assistant', text: 'a heading' },
      ],
    });
    expect(await call(AI_CHANNELS.request, win, followUp)).toMatchObject({ ok: false, code: 'no-consent' });
    expect((await call(AI_CHANNELS.request, win, chat('general question'))).ok).toBe(true);
  });

  it('streams, cancels (only from the starting window) and closes requests with the window', async () => {
    await setup({
      turns: [
        {
          match: 'slow',
          repeat: true,
          steps: [
            { type: 'text', text: 'part' },
            { type: 'delay', ms: 5_000 },
            { type: 'text', text: 'never' },
          ],
        },
      ],
    });
    await storeKey();
    const started = await call(AI_CHANNELS.request, win, chat('slow', { projectId: null }));
    const id = started.value.requestId as string;
    for (let i = 0; i < 100 && !win.sent.some((e) => e.type === 'text'); i += 1)
      await new Promise((r) => setTimeout(r, 5));
    expect(await call(AI_CHANNELS.cancel, win2, { requestId: id })).toEqual({ ok: true, value: null });
    expect(service.active).toContain(id);
    expect(await call(AI_CHANNELS.cancel, win, { requestId: id })).toEqual({ ok: true, value: null });
    const events = await finished(win, id);
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
    expect(events.at(-1)).toMatchObject({ code: 'cancelled' });
    expect(win2.sent).toHaveLength(0);

    const second = await call(AI_CHANNELS.request, win, chat('slow', { projectId: null }));
    win.destroyed = true;
    win.onDestroyed?.();
    for (let i = 0; i < 100 && service.active.includes(second.value.requestId); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(service.active).not.toContain(second.value.requestId);
  });

  it("a reload or a renderer crash stops the old page's requests; in-page navigation does not (S36.1)", async () => {
    await setup({
      turns: [
        {
          match: 'slow',
          repeat: true,
          steps: [
            { type: 'text', text: 'part' },
            { type: 'delay', ms: 5_000 },
          ],
        },
      ],
    });
    await storeKey();
    const emit = (name: string, details?: unknown) => {
      for (const listener of win.listeners.get(name) ?? []) listener(details);
    };
    const waitGone = async (id: string) => {
      for (let i = 0; i < 100 && service.active.includes(id); i += 1) await new Promise((r) => setTimeout(r, 5));
    };
    const first = (await call(AI_CHANNELS.request, win, chat('slow', { projectId: null }))).value.requestId as string;
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(service.active).toContain(first);
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await waitGone(first);
    expect(service.active).not.toContain(first);
    const second = (await call(AI_CHANNELS.request, win, chat('slow', { projectId: null }))).value.requestId as string;
    emit('render-process-gone', {});
    await waitGone(second);
    expect(service.active).not.toContain(second);
  });

  it('maps provider failures and refusals to error codes', async () => {
    await setup({
      turns: [
        { match: 'limit', steps: [{ type: 'error', code: 'rate-limited' }] },
        { match: 'net', steps: [{ type: 'error', code: 'offline' }] },
        { match: 'big', steps: [{ type: 'error', code: 'context-too-large' }] },
        { match: 'model', steps: [{ type: 'error', code: 'model-not-found' }] },
        { match: 'nope', steps: [{ type: 'text', text: 'partial' }], stop: 'refusal' },
      ],
    });
    await storeKey();
    const expectations: [string, string][] = [
      ['limit', 'rate-limited'],
      ['net', 'offline'],
      ['big', 'context-too-large'],
      ['model', 'provider-error'],
      ['nope', 'refused'],
    ];
    for (const [prompt, code] of expectations) {
      const started = await call(AI_CHANNELS.request, win, chat(prompt, { projectId: null }));
      const events = await finished(win, started.value.requestId);
      expect(events.at(-1)).toMatchObject({ type: 'error', code });
    }
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    const huge = chat('x', {
      context: [
        { kind: 'selection', text: 'y'.repeat(399_000) },
        { kind: 'selection', text: 'y'.repeat(10_000) },
      ],
    });
    const started = await call(AI_CHANNELS.request, win, huge);
    expect((await finished(win, started.value.requestId)).at(-1)).toMatchObject({ code: 'context-too-large' });
  });

  it('inline completions arrive as one cleaned piece, replace the previous one and respect the time budget', async () => {
    await setup({
      turns: [
        {
          match: 'first',
          steps: [
            { type: 'delay', ms: 2_000 },
            { type: 'text', text: 'late' },
          ],
        },
        {
          match: 'second',
          steps: [
            { type: 'text', text: '```js\n' },
            { type: 'text', text: 'x = 1;\n```' },
          ],
        },
        { match: 'third', steps: [{ type: 'delay', ms: 2_000 }] },
      ],
    });
    await storeKey();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    const inline = (prefix: string) => ({
      kind: 'inline',
      projectId: PROJECT,
      relPath: 'a.js',
      languageId: 'javascript',
      prefix,
      suffix: '',
    });
    const first = await call(AI_CHANNELS.request, win, inline('first'));
    const second = await call(AI_CHANNELS.request, win, inline('second'));
    expect((await finished(win, first.value.requestId)).at(-1)).toMatchObject({ code: 'cancelled' });
    expect((await finished(win, second.value.requestId)).filter((e) => e.type !== 'done')).toEqual([
      { requestId: second.value.requestId, type: 'text', text: 'x = 1;' },
    ]);
    expect(hub.requests.find((r) => r.purpose === 'inline')?.model).toBe('claude-haiku-5-5');
    const third = await call(AI_CHANNELS.request, win, inline('third'));
    expect((await finished(win, third.value.requestId)).at(-1)).toMatchObject({
      code: 'provider-error',
      message: 'timed out',
    });
  });

  it('runs edit requests with the edit prompt and the locale', async () => {
    await setup({ turns: [{ purpose: 'edit', steps: [{ type: 'text', text: 'button { color: blue; }' }] }] });
    await storeKey();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    const started = await call(AI_CHANNELS.request, win, {
      kind: 'edit',
      projectId: PROJECT,
      relPath: 'style.css',
      languageId: 'css',
      instruction: 'make the button blue',
      selection: 'button { color: red; }',
      before: '',
      after: '',
      locale: 'en',
    });
    const events = await finished(win, started.value.requestId);
    expect(events[0]).toMatchObject({ type: 'text', text: 'button { color: blue; }' });
    const req = hub.requests.at(-1);
    expect(req?.system).toContain('replaces the selection');
    expect(req?.system).toContain('comments in English');
    expect(req?.messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('S42.2: runs an /ai prompt (generate mode) with the file problems as data; refuses bad problems; logs no text', async () => {
    await setup({
      turns: [
        {
          purpose: 'edit',
          systemMatch: 'The user typed a request on its own line of their file',
          steps: [{ type: 'text', text: '<p>Written by the fake AI.</p>' }],
        },
      ],
    });
    await storeKey();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    const request = {
      kind: 'edit',
      projectId: PROJECT,
      relPath: '中文 文件夹/index.html',
      languageId: 'html',
      instruction: '做一个点击后数字加一的按钮 PROMPT-MARKER',
      selection: '',
      before: '<body>\n  <p id="count">0</p>',
      after: '</body>',
      locale: 'zh-CN',
      mode: 'generate',
      problems: [
        { line: 7, severity: 'error', source: 'runtime', code: 'ReferenceError', message: 'add is not defined MSG' },
      ],
    };
    const started = await call(AI_CHANNELS.request, win, request);
    const events = await finished(win, started.value.requestId);
    expect(events[0]).toMatchObject({ type: 'text', text: '<p>Written by the fake AI.</p>' });
    const req = hub.requests.at(-1);
    expect(req?.purpose).toBe('edit');
    expect(req?.system).toContain('The user typed a request on its own line of their file');
    expect(req?.system).toContain('comments in Simplified Chinese');
    const message = req?.messages.at(-1);
    const text = message?.role === 'user' ? message.text : '';
    expect(text).toContain('<problems>\n- line 7, error, runtime ReferenceError: add is not defined MSG\n</problems>');
    expect(text).toContain('<before>\n<body>\n  <p id="count">0</p>\n</before>');
    expect(text.endsWith('Request: 做一个点击后数字加一的按钮 PROMPT-MARKER')).toBe(true);

    expect(await call(AI_CHANNELS.request, win, { ...request, mode: 'insert' })).toMatchObject({ ok: false });
    expect(
      await call(AI_CHANNELS.request, win, { ...request, problems: [{ ...request.problems[0], severity: 'fatal' }] }),
    ).toMatchObject({ ok: false });
    const log = await logText();
    expect(log).not.toContain('PROMPT-MARKER');
    expect(log).not.toContain('add is not defined');
    expect(log).not.toContain('count');
  });

  it('runs agent requests in the S34 runner over the active provider; decisions and Stop reach it', async () => {
    await setup({});
    await storeKey();
    await call(AI_CHANNELS.setConsent, win, { projectId: PROJECT, allowed: true });
    const agent = { kind: 'agent', projectId: PROJECT, history: [], prompt: 'add a page', context: [], locale: 'en' };
    expect(await call(AI_CHANNELS.request, win, agent)).toMatchObject({
      code: 'provider-error',
      message: 'agent not available',
    });

    // The real runner and tools over a real project; the fake provider plays the model through the ModelPort adapter.
    const projectRoot = path.join(dir, '我的 项目');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'index.html'), '<h1>PROJECT-CODE-MARKER</h1>\n');
    const projects = new ProjectService();
    const opened = await projects.open(projectRoot);
    if (!opened.ok) throw new Error('project did not open');
    const projectId = opened.value.projectId;
    const runner = createAgentRunner({ projectPorts: (id) => createProjectPorts({ projects, projectId: id }) });
    await setup(
      {
        turns: [
          {
            purpose: 'agent',
            match: 'add a page',
            steps: [
              { type: 'text', text: 'Looking. ' },
              { type: 'tool-call', id: 'call-read', name: 'read_file', input: { path: 'index.html' } },
            ],
            usage: { inputTokens: 100, outputTokens: 10 },
          },
          {
            purpose: 'agent',
            match: 'PROJECT-CODE-MARKER',
            steps: [
              {
                type: 'tool-call',
                id: 'call-create',
                name: 'propose_create',
                input: { path: 'about.html', content: '<h1>About</h1>\n', reason: 'Add an about page.' },
              },
            ],
          },
          { purpose: 'agent', steps: [{ type: 'text', text: 'Done.' }], repeat: true },
        ],
      },
      { runner, rootOf: (id) => projects.rootOf(id) },
    );
    await call(AI_CHANNELS.setConsent, win, { projectId, allowed: true });
    const started = await call(AI_CHANNELS.request, win, { ...agent, projectId });
    const id = started.value.requestId as string;
    for (let i = 0; i < 200 && !win.sent.some((e) => e.requestId === id && e.type === 'proposal'); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const proposal = win.sent.find((e) => e.requestId === id && e.type === 'proposal');
    expect(proposal).toMatchObject({ changes: [{ kind: 'create', relPath: 'about.html' }] });
    const proposalId = proposal?.type === 'proposal' ? proposal.proposalId : '';
    const decision = { requestId: id, proposalId, results: [{ accepted: true, applied: true }] };
    expect(await call(AI_CHANNELS.resolveProposal, win2, decision)).toMatchObject({ code: 'unknown-request' });
    expect(await call(AI_CHANNELS.resolveProposal, win, { ...decision, proposalId: 'not-it' })).toMatchObject({
      code: 'unknown-request',
    });
    expect(await call(AI_CHANNELS.resolveProposal, win, decision)).toEqual({ ok: true, value: null });
    const events = await finished(win, id);
    // Exactly one terminal event, emitted by the runner.
    expect(events.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.some((e) => e.type === 'step')).toBe(true);
    const agentCalls = hub.requests.filter((r) => r.purpose === 'agent');
    expect(agentCalls.length).toBeGreaterThanOrEqual(3);
    expect(agentCalls[0]?.model).toBe('claude-opus-5-5');
    expect(agentCalls[0]?.toolNames).toContain('propose_create');
    // The tool result (the file, as data) went back to the model as a tool message.
    expect(agentCalls[1]?.messages.some((m) => m.role === 'tool')).toBe(true);
    const log = await logText();
    expect(log).toContain('"purpose":"agent"');
    expect(log).not.toContain('PROJECT-CODE-MARKER');

    // Stop while the agent waits for a decision: one terminal 'cancelled' event.
    await setup(
      {
        turns: [
          {
            purpose: 'agent',
            repeat: true,
            steps: [
              {
                type: 'tool-call',
                name: 'propose_create',
                input: { path: 'b.html', content: 'x', reason: 'r' },
              },
            ],
          },
        ],
      },
      { runner, rootOf: (pid) => projects.rootOf(pid) },
    );
    const again = await call(AI_CHANNELS.request, win, { ...agent, projectId });
    for (
      let i = 0;
      i < 200 && !win.sent.some((e) => e.requestId === again.value.requestId && e.type === 'proposal');
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await call(AI_CHANNELS.cancel, win, { requestId: again.value.requestId });
    const stopped = await finished(win, again.value.requestId);
    expect(stopped.filter((e) => e.type === 'done' || e.type === 'error')).toEqual([
      expect.objectContaining({ type: 'error', code: 'cancelled' }),
    ]);
  });

  it('picks OpenAI defaults from the model list on first use', async () => {
    await setup({
      models: [
        { id: 'gpt-new', displayName: 'gpt-new' },
        { id: 'gpt-new-mini', displayName: 'gpt-new-mini' },
      ],
    });
    expect(await call(AI_CHANNELS.setKey, win, { provider: 'openai', key: KEY })).toEqual({ ok: true, value: null });
    expect((await call(AI_CHANNELS.status, win, {})).value.config).toMatchObject({
      provider: 'openai',
      models: { chat: '', inline: '' },
    });
    const started = await call(AI_CHANNELS.request, win, chat('hi', { projectId: null }));
    await finished(win, started.value.requestId);
    expect(hub.requests.at(-1)).toMatchObject({ provider: 'openai', model: 'gpt-new' });
    expect((await call(AI_CHANNELS.status, win, {})).value.config.models).toEqual({
      chat: 'gpt-new',
      agent: 'gpt-new',
      edit: 'gpt-new',
      inline: 'gpt-new-mini',
    });
  });
});
