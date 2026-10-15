import { describe, expect, it } from 'vitest';
import type { AiRequest } from '../../shared/ipc/ai-contract';
import { AiChatController, type AiChatHost, type SelectionContext } from './chat-controller';
import { activeConversation, aiSurfacesShown, availabilityOf, draftOf, type ChatState } from './chat-model';
import { fakeAiApi, readyStatus, type FakeAiApi } from './fake-ai-api';

interface HostState {
  projectId: string | null;
  locale: 'zh-CN' | 'en';
  active: string | null;
  buffers: Record<string, string>;
  selection: SelectionContext | null;
}

function setup(api: FakeAiApi | null = fakeAiApi(), initial: Partial<HostState> = {}) {
  const host: HostState = {
    projectId: 'p1',
    locale: 'zh-CN',
    active: 'index.html',
    buffers: { 'index.html': '<h1>未保存的标题</h1>\n' },
    selection: null,
    ...initial,
  };
  const chatHost: AiChatHost = {
    projectId: () => host.projectId,
    locale: () => host.locale,
    activeFile: () => host.active,
    fileText: (relPath) => host.buffers[relPath],
    selection: () => host.selection,
  };
  const controller = new AiChatController(api ?? undefined, chatHost);
  controller.start();
  const state = (): ChatState => controller.getState();
  const draft = () => draftOf(state(), host.projectId ?? '');
  const conversation = () => activeConversation(state(), host.projectId ?? '');
  const lastTurn = () => conversation()?.turns.at(-1);
  return { api, host, controller, state, draft, conversation, lastTurn };
}

const chat = (request: AiRequest | undefined) => {
  if (request?.kind !== 'chat') throw new Error(`expected a chat request, got ${request?.kind}`);
  return request;
};

describe('availability (S33.1)', () => {
  it('maps the AI status to the panel states', () => {
    expect(availabilityOf(readyStatus())).toEqual({ kind: 'ready', provider: 'anthropic', consent: true });
    expect(availabilityOf(readyStatus({ config: { ...readyStatus().config, enabled: false } })).kind).toBe('disabled');
    expect(availabilityOf(readyStatus({ keyStored: { anthropic: false, openai: false } })).kind).toBe('no-key');
    expect(availabilityOf(readyStatus({ config: { ...readyStatus().config, provider: null } })).kind).toBe('no-key');
    expect(
      availabilityOf(readyStatus({ keyStored: { anthropic: false, openai: false }, secureStorage: false })).kind,
    ).toBe('no-secure-storage');
    expect(availabilityOf(readyStatus({ projectConsent: false }))).toEqual({
      kind: 'ready',
      provider: 'anthropic',
      consent: false,
    });
  });

  it('offers no AI surface without the bridge or with AI off', async () => {
    const none = setup(null);
    expect(none.state().availability.kind).toBe('unavailable');
    expect(aiSurfacesShown(none.state().availability)).toBe(false);
    const off = setup(fakeAiApi(readyStatus({ config: { ...readyStatus().config, enabled: false } })));
    await off.controller.refreshStatus();
    expect(aiSurfacesShown(off.state().availability)).toBe(false);
    const noKey = setup(fakeAiApi(readyStatus({ keyStored: { anthropic: false, openai: false } })));
    await noKey.controller.refreshStatus();
    expect(aiSurfacesShown(noKey.state().availability)).toBe(true); // the panel explains how to add a key
  });

  it('sends nothing without a key', async () => {
    const t = setup(fakeAiApi(readyStatus({ keyStored: { anthropic: false, openai: false } })));
    t.controller.open();
    t.controller.setPrompt('你好');
    await t.controller.send();
    expect(t.api?.requests).toHaveLength(0);
    expect(t.state().availability.kind).toBe('no-key');
  });
});

describe('context chips (S33.1)', () => {
  it('opening the panel suggests the current file once; chips are removable; nothing else is added', async () => {
    const t = setup();
    t.controller.open();
    expect(t.state().open).toBe(true);
    expect(t.draft().chips.map((chip) => chip.item)).toEqual([{ kind: 'file', relPath: 'index.html' }]);
    t.controller.close();
    t.controller.removeChip(t.draft().chips[0]!.id);
    t.controller.setPrompt('x');
    t.controller.open();
    expect(t.draft().chips).toEqual([]); // the user's draft is not changed behind their back
  });

  it('sends exactly the chips shown: the open buffer for a file, the selected text, nothing removed', async () => {
    const t = setup();
    t.host.selection = { relPath: 'script.js', startLine: 3, endLine: 5, text: 'let a = 1;\nlet b = 2;\na + b;' };
    t.controller.open();
    expect(t.controller.addSelection()).toBe(true);
    t.controller.addCurrentFile(); // already there: kept once
    t.controller.addChip({ kind: 'file', relPath: 'style.css' });
    expect(t.draft().chips).toHaveLength(3);
    t.controller.removeChip(t.draft().chips.find((chip) => chip.item.relPath === 'style.css')!.id);
    t.controller.setPrompt('  这段代码是做什么的？ ');
    await t.controller.send();
    const request = chat(t.api?.requests[0]);
    expect(request).toMatchObject({ projectId: 'p1', prompt: '这段代码是做什么的？', mode: 'chat', locale: 'zh-CN' });
    expect(request.context).toEqual([
      { kind: 'file', relPath: 'index.html', text: '<h1>未保存的标题</h1>\n' },
      { kind: 'selection', relPath: 'script.js', startLine: 3, endLine: 5, text: 'let a = 1;\nlet b = 2;\na + b;' },
    ]);
    // The turn records what was sent; the prompt is cleared, the chips stay for a follow-up.
    expect(t.lastTurn()?.context).toEqual(request.context);
    expect(t.draft().prompt).toBe('');
    expect(t.draft().chips).toHaveLength(2);
  });

  it('a file that is not open is sent without text (main reads it from disk)', async () => {
    const t = setup();
    t.controller.open();
    t.controller.removeChip(t.draft().chips[0]!.id);
    t.controller.addChip({ kind: 'file', relPath: 'about.html' });
    t.controller.setPrompt('看看这个页面');
    await t.controller.send();
    expect(chat(t.api?.requests[0]).context).toEqual([{ kind: 'file', relPath: 'about.html' }]);
  });

  it('explains why a chip could not be added', () => {
    const t = setup(fakeAiApi(), { active: null });
    expect(t.controller.addCurrentFile()).toBe(false);
    expect(t.state().notice).toBe('ai.chat.context.noFile');
    expect(t.controller.addSelection()).toBe(false);
    expect(t.state().notice).toBe('ai.chat.context.noSelection');
  });
});

describe('consent (S33.1)', () => {
  it('asks before the first send for a project and sends once allowed', async () => {
    const api = fakeAiApi(readyStatus({ projectConsent: false }));
    const t = setup(api);
    t.controller.open();
    t.controller.setPrompt('你好');
    await t.controller.send();
    expect(api.requests).toHaveLength(0);
    expect(t.state().consentFor).toBe('p1');
    // The consent component stores the answer, then tells the controller.
    await api.setConsent({ projectId: 'p1', allowed: true });
    await t.controller.consentGiven();
    expect(t.state().consentFor).toBeNull();
    expect(api.requests).toHaveLength(1);
  });

  it('declining sends nothing and says so', async () => {
    const api = fakeAiApi(readyStatus({ projectConsent: false }));
    const t = setup(api);
    t.controller.setPrompt('你好');
    await t.controller.send();
    t.controller.consentDeclined();
    expect(api.requests).toHaveLength(0);
    expect(t.state().consentFor).toBeNull();
    expect(t.state().notice).toBe('ai.consent.declined');
    expect(t.draft().prompt).toBe('你好');
  });

  it('a chat without a project needs no consent', async () => {
    const api = fakeAiApi(readyStatus({ projectConsent: false }));
    const t = setup(api, { projectId: null, active: null });
    t.controller.setPrompt('什么是 HTML？');
    await t.controller.send();
    expect(chat(api.requests[0])).toMatchObject({ projectId: null, context: [] });
  });

  it('a no-consent refusal from main shows the question again', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    api.nextRequest = { error: 'no-consent' };
    t.controller.setPrompt('你好');
    await t.controller.send();
    expect(t.lastTurn()).toMatchObject({ status: 'error', error: { code: 'no-consent' } });
    expect(t.state().consentFor).toBe('p1');
  });
});

describe('streaming, stop and errors (S33.1)', () => {
  it('streams text, ends with usage, and ignores other requests’ events', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.setPrompt('解释一下');
    await t.controller.send();
    expect(t.lastTurn()).toMatchObject({ status: 'streaming', requestId: 'r1' });
    api.emit({ requestId: 'r1', type: 'text', text: '这是' });
    api.emit({ requestId: 'other', type: 'text', text: '别人的补全' });
    api.emit({ requestId: 'r1', type: 'text', text: '**标题**' });
    expect(t.lastTurn()?.parts).toEqual([{ kind: 'text', text: '这是**标题**' }]);
    api.emit({ requestId: 'r1', type: 'done', usage: { inputTokens: 1200, outputTokens: 34 } });
    expect(t.lastTurn()).toMatchObject({ status: 'done', usage: { inputTokens: 1200, outputTokens: 34 } });
    api.emit({ requestId: 'r1', type: 'text', text: '迟到的' });
    expect(t.lastTurn()?.parts).toEqual([{ kind: 'text', text: '这是**标题**' }]);
  });

  it('keeps events that arrive before the request id', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    api.nextRequest = { early: (id) => [{ requestId: id, type: 'text', text: '先到的' }] };
    t.controller.setPrompt('你好');
    await t.controller.send();
    expect(t.lastTurn()?.parts).toEqual([{ kind: 'text', text: '先到的' }]);
  });

  it('Stop cancels the request and keeps the partial answer', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.setPrompt('写一首长诗');
    await t.controller.send();
    api.emit({ requestId: 'r1', type: 'text', text: '第一行' });
    await t.controller.stop();
    expect(api.cancels).toEqual(['r1']);
    expect(t.lastTurn()).toMatchObject({ status: 'cancelled', parts: [{ kind: 'text', text: '第一行' }] });
    // Main's own "cancelled" end changes nothing more.
    api.emit({ requestId: 'r1', type: 'error', code: 'cancelled', message: '' });
    expect(t.lastTurn()?.status).toBe('cancelled');
  });

  it('a stream error is kept with its code; a refused request too', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.setPrompt('一');
    await t.controller.send();
    api.emit({ requestId: 'r1', type: 'error', code: 'offline', message: 'getaddrinfo ENOTFOUND' });
    expect(t.lastTurn()).toMatchObject({ status: 'error', error: { code: 'offline' } });
    api.nextRequest = { error: 'rate-limited' };
    t.controller.setPrompt('二');
    await t.controller.send();
    expect(t.lastTurn()).toMatchObject({ status: 'error', error: { code: 'rate-limited' } });
  });

  it('one question at a time; follow-ups carry the earlier answers as history', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.setPrompt('第一问');
    await t.controller.send();
    t.controller.setPrompt('插队');
    await t.controller.send();
    expect(api.requests).toHaveLength(1);
    api.emit({ requestId: 'r1', type: 'text', text: '第一答' });
    api.emit({ requestId: 'r1', type: 'done' });
    await t.controller.send();
    expect(chat(api.requests[1]).history).toEqual([
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' },
    ]);
    expect(t.conversation()?.title).toBe('第一问');
  });

  it('conversations are per project and kept in memory', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.setPrompt('项目一的问题');
    await t.controller.send();
    t.host.projectId = 'p2';
    expect(t.conversation()).toBeNull();
    t.controller.setPrompt('项目二的问题');
    await t.controller.send();
    t.host.projectId = 'p1';
    expect(t.conversation()?.turns[0]?.prompt).toBe('项目一的问题');
    t.controller.newConversation();
    expect(t.conversation()).toBeNull();
    t.controller.selectConversation(t.state().conversations[0]!.id);
    expect(t.conversation()?.turns).toHaveLength(1);
  });

  it('answers follow the UI locale', async () => {
    const api = fakeAiApi();
    const t = setup(api, { locale: 'en' });
    t.controller.setPrompt('hi');
    await t.controller.send();
    expect(chat(api.requests[0]).locale).toBe('en');
  });
});

describe('explain entry points (S33.2)', () => {
  it('"Explain this code" opens a fresh conversation with the selection, explain mode and a suggested prompt', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.setPrompt('旧问题');
    await t.controller.send();
    const selection = { relPath: 'script.js', startLine: 2, endLine: 4, text: 'for (;;) {}' };
    t.controller.explainCode(selection, '请解释这段代码');
    expect(t.state().open).toBe(true);
    expect(t.conversation()).toBeNull(); // a new conversation
    expect(t.draft()).toMatchObject({ prompt: '请解释这段代码', mode: 'explain-code' });
    expect(t.draft().chips.map((chip) => chip.item)).toEqual([{ kind: 'selection', ...selection }]);
    expect(api.requests).toHaveLength(1); // nothing is sent until the user sends
    await t.controller.send();
    expect(chat(api.requests[1])).toMatchObject({
      mode: 'explain-code',
      prompt: '请解释这段代码',
      context: [{ kind: 'selection', ...selection }],
    });
    expect(t.draft().mode).toBe('chat');
  });

  it('without a selection it explains the current file', () => {
    const t = setup();
    t.controller.explainCode(null, 'p');
    expect(t.draft().chips.map((chip) => chip.item)).toEqual([{ kind: 'file', relPath: 'index.html' }]);
  });

  it('"Ask AI" on a problem sends its file, line and original error in explain-problem mode', async () => {
    const api = fakeAiApi();
    const t = setup(api, { buffers: { 'script.js': 'console.log(userNmae);\n' } });
    t.controller.explainProblem(
      {
        relPath: 'script.js',
        line: 1,
        title: '找不到变量 userNmae。',
        originalMessage: 'Uncaught ReferenceError: userNmae is not defined',
        code: 'ReferenceError',
      },
      '这个问题是什么意思？',
    );
    expect(t.draft().mode).toBe('explain-problem');
    await t.controller.send();
    expect(chat(api.requests[0])).toMatchObject({
      mode: 'explain-problem',
      context: [
        {
          kind: 'problem',
          relPath: 'script.js',
          startLine: 1,
          endLine: 1,
          label: '找不到变量 userNmae。',
          text: 'Uncaught ReferenceError: userNmae is not defined',
        },
        { kind: 'file', relPath: 'script.js', text: 'console.log(userNmae);\n' },
      ],
    });
  });

  it('a problem code missing from the message is kept with it', () => {
    const t = setup();
    t.controller.explainProblem({ title: 'T', originalMessage: 'Unknown property', code: 'unknownProperties' }, 'p');
    expect(t.draft().chips[0]?.item).toEqual({
      kind: 'problem',
      label: 'T',
      text: 'unknownProperties: Unknown property',
    });
  });
});

describe('agent turns (extension point for S34)', () => {
  it('builds agent requests with the same prompt, context and locale; steps and proposals become parts', async () => {
    const api = fakeAiApi();
    const t = setup(api);
    t.controller.open();
    t.controller.setKind('agent');
    t.controller.setPrompt('加一个关于页');
    await t.controller.send();
    expect(api.requests[0]).toMatchObject({ kind: 'agent', projectId: 'p1', prompt: '加一个关于页', locale: 'zh-CN' });
    api.emit({ requestId: 'r1', type: 'step', tool: 'read', summary: 'index.html' });
    api.emit({
      requestId: 'r1',
      type: 'proposal',
      proposalId: 'x',
      changes: [{ kind: 'create', relPath: 'about.html', after: '<h1>关于</h1>' }],
      reason: '新页面',
    });
    expect(t.lastTurn()?.parts.map((part) => part.kind)).toEqual(['step', 'proposal']);
    expect(t.lastTurn()?.kind).toBe('agent');
  });
});
