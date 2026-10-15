import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiHistoryApi, AiChatToSave, AiSavedChat } from '../../shared/ipc/ai-history-contract';
import { parseChatToSave } from '../../shared/ipc/ai-history-parse';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { AiChatController, type AiChatHost } from './chat-controller';
import { activeConversation, INITIAL_CHAT_STATE, type ChatTurn, type Conversation } from './chat-model';
import { ChatHistorySync, fromSavedChat, toChatToSave, toSavedTurn, type ChatHistoryState } from './chat-history';
import { ChatPanelView, type ChatPanelActions } from './ChatPanel';
import { fakeAiApi } from './fake-ai-api';
import { SavedChatsList, savedProposalText } from './SavedChatsList';

/** S39.1: the panel's conversations are saved when a turn ends, listed, reopened and deleted (with confirmation). */
const P = 'p1';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tr = (locale: Locale) => (key: MessageKey) => translate(locale, key);

function fakeHistory() {
  const files = new Map<string, AiSavedChat>();
  let clock = 1000;
  const calls: string[] = [];
  const api: AiHistoryApi & { failSave: false | 'write-failed' | 'too-large'; files: typeof files; calls: string[] } = {
    failSave: false,
    files,
    calls,
    listChats: async ({ projectId }) => {
      calls.push(`list ${projectId}`);
      const chats = [...files.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          turnCount: c.turns.length,
        }));
      return { ok: true, value: { chats, skipped: 1 } };
    },
    getChat: async ({ chatId }) => {
      const chat = files.get(chatId);
      return chat ? { ok: true, value: chat } : { ok: false, code: 'not-found', message: '' };
    },
    saveChat: async ({ chat }) => {
      calls.push(`save ${chat.id} ${chat.turns.length}`);
      // Exactly what main accepts.
      expect(parseChatToSave(chat)).toEqual(chat);
      if (api.failSave) return { ok: false, code: api.failSave, message: '' };
      clock += 1;
      const createdAt = files.get(chat.id)?.createdAt ?? clock;
      files.set(chat.id, { ...chat, createdAt, updatedAt: clock });
      return {
        ok: true,
        value: { id: chat.id, title: chat.title, createdAt, updatedAt: clock, turnCount: chat.turns.length },
      };
    },
    deleteChat: async ({ chatId }) => {
      calls.push(`delete ${chatId}`);
      files.delete(chatId);
      return { ok: true, value: null };
    },
    deleteProjectChats: async () => ({ ok: true, value: { deleted: 0 } }),
    countRecentChats: async () => ({ ok: true, value: { count: 0 } }),
    deleteRecentChats: async () => ({ ok: true, value: { deleted: 0 } }),
    usage: async () => ({ ok: false, code: 'invalid-request', message: '' }),
    setDailyBudget: async () => ({ ok: false, code: 'invalid-request', message: '' }),
  };
  return api;
}

function setup() {
  const ai = fakeAiApi();
  const host = { projectId: P as string | null };
  const chatHost: AiChatHost = {
    projectId: () => host.projectId,
    locale: () => 'en',
    activeFile: () => 'index.html',
    fileText: () => '<h1>UNSAVED-CODE</h1>',
    selection: () => null,
  };
  const controller = new AiChatController(ai, chatHost);
  controller.start();
  const history = fakeHistory();
  let n = 0;
  const sync = new ChatHistorySync(
    history,
    controller,
    () => host.projectId,
    () => uuid((n += 1)),
  );
  sync.start();
  return { ai, host, controller, history, sync };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function ask(t: ReturnType<typeof setup>, prompt: string, answer: string) {
  t.controller.setPrompt(prompt);
  await t.controller.send();
  const id = `r${t.ai.requests.length}`;
  t.ai.emit({ requestId: id, type: 'text', text: answer });
  await settle();
  t.ai.emit({ requestId: id, type: 'done', usage: { inputTokens: 10, outputTokens: 2 } });
  await t.sync.flush();
}

describe('saved form of a conversation (S39.1)', () => {
  const turn = (overrides: Partial<ChatTurn>): ChatTurn => ({
    id: 't1',
    kind: 'agent',
    mode: 'chat',
    prompt: 'add a page',
    context: [
      { kind: 'file', relPath: 'index.html', text: '<h1>CODE</h1>' },
      { kind: 'selection', relPath: 'a.js', startLine: 1, endLine: 2, text: 'let x' },
    ],
    requestId: 'r1',
    status: 'done',
    stopping: false,
    parts: [
      { kind: 'text', text: 'Sure.' },
      { kind: 'step', tool: 'read_file', summary: 'index.html' },
      {
        kind: 'proposal',
        proposalId: 'p1',
        reason: 'Add it.',
        changes: [
          { kind: 'create', relPath: 'about.html', after: '<h1>FULL-CONTENT</h1>' },
          { kind: 'rename', relPath: 'a.txt', to: 'b.txt' },
        ],
      },
    ],
    usage: { inputTokens: 5, outputTokens: 1 },
    ...overrides,
  });

  it('keeps questions, answers and what was named, never the code a context item or proposal carried', () => {
    const saved = toSavedTurn(turn({}));
    expect(saved).toEqual({
      kind: 'agent',
      mode: 'chat',
      prompt: 'add a page',
      context: [
        { kind: 'file', relPath: 'index.html' },
        { kind: 'selection', relPath: 'a.js', startLine: 1, endLine: 2 },
      ],
      status: 'done',
      parts: [
        { kind: 'text', text: 'Sure.' },
        { kind: 'step', tool: 'read_file', summary: 'index.html' },
        {
          kind: 'proposal',
          reason: 'Add it.',
          changes: [
            { kind: 'create', relPath: 'about.html' },
            { kind: 'rename', relPath: 'a.txt', to: 'b.txt' },
          ],
        },
      ],
      usage: { inputTokens: 5, outputTokens: 1 },
    });
    expect(JSON.stringify(saved)).not.toContain('CODE');
    expect(toSavedTurn(turn({ status: 'streaming' }))).toBeNull();
    expect(toSavedTurn(turn({ status: 'error', error: { code: 'offline', message: 'x' } }))?.errorCode).toBe('offline');
  });

  it('round-trips: a reopened chat shows the same turns, ended, with proposals no longer reviewable', () => {
    const conversation: Conversation = { id: 'conv1', projectKey: P, title: 'Add a page', turns: [turn({})] };
    const toSave = toChatToSave(conversation, uuid(1)) as AiChatToSave;
    expect(parseChatToSave(toSave)).toEqual(toSave);
    const back = fromSavedChat({ ...toSave, createdAt: 1, updatedAt: 2 }, P);
    expect(back).toMatchObject({ id: uuid(1), projectKey: P, title: 'Add a page' });
    expect(back.turns[0]).toMatchObject({
      status: 'done',
      requestId: null,
      prompt: 'add a page',
      usage: { inputTokens: 5 },
    });
    expect(back.turns[0]?.parts[2]).toEqual({
      kind: 'saved-proposal',
      reason: 'Add it.',
      changes: [
        { kind: 'create', relPath: 'about.html' },
        { kind: 'rename', relPath: 'a.txt', to: 'b.txt' },
      ],
    });
    // Saving the reopened chat again gives the same file.
    expect(toChatToSave(back, uuid(1))).toEqual(toSave);
    expect(toChatToSave({ ...conversation, turns: [turn({ status: 'sending' })] }, uuid(1))).toBeNull();
  });

  it('says what a saved proposal changed, in both languages', () => {
    const changes = [
      { kind: 'edit', relPath: 'style.css' },
      { kind: 'rename', relPath: 'a.txt', to: 'b.txt' },
    ] as const;
    expect(savedProposalText(tr('en'), changes)).toContain('change style.css');
    expect(savedProposalText(tr('en'), changes)).toContain('rename a.txt → b.txt');
    expect(savedProposalText(tr('zh-CN'), changes)).toContain('修改 style.css');
  });
});

describe('ChatHistorySync (S39.1)', () => {
  it('saves a conversation when each turn ends (not while it streams), under one id', async () => {
    const t = setup();
    t.controller.setPrompt('What is this?');
    await t.controller.send();
    t.ai.emit({ requestId: 'r1', type: 'text', text: 'A heading.' });
    await t.sync.flush();
    expect(t.history.calls.filter((c) => c.startsWith('save'))).toEqual([]);
    t.ai.emit({ requestId: 'r1', type: 'done', usage: { inputTokens: 10, outputTokens: 2 } });
    await t.sync.flush();
    expect(t.history.calls.filter((c) => c.startsWith('save'))).toEqual([`save ${uuid(1)} 1`]);
    await ask(t, 'And this?', 'A paragraph.');
    expect(t.history.calls.filter((c) => c.startsWith('save'))).toEqual([`save ${uuid(1)} 1`, `save ${uuid(1)} 2`]);
    const file = t.history.files.get(uuid(1));
    expect(file?.turns.map((x) => x.prompt)).toEqual(['What is this?', 'And this?']);
    // The open buffer's text went to the provider as context, but is not in the saved chat.
    expect(JSON.stringify(file)).not.toContain('UNSAVED-CODE');
    // Without a project nothing is saved.
    t.host.projectId = null;
    await ask(t, 'General question', 'Answer');
    expect(t.history.calls.filter((c) => c.startsWith('save'))).toHaveLength(2);
  });

  it('lists past chats (with the skipped count), reopens one, and a follow-up is saved into the same chat', async () => {
    const t = setup();
    await ask(t, 'First chat', 'One');
    t.controller.newConversation();
    await ask(t, 'Second chat', 'Two');
    // A new window (restart): the panel has no conversations, the files are there.
    const fresh = setup();
    for (const [id, chat] of t.history.files) fresh.history.files.set(id, chat);
    await fresh.sync.openList();
    const state = fresh.sync.getState();
    expect(state).toMatchObject({ listOpen: true, skipped: 1 });
    expect(state.chats?.map((c) => c.title)).toEqual(['Second chat', 'First chat']);
    await fresh.sync.reopen(uuid(1));
    expect(fresh.sync.getState().listOpen).toBe(false);
    const shown = activeConversation(fresh.controller.getState(), P);
    expect(shown).toMatchObject({ id: uuid(1), title: 'First chat' });
    expect(shown?.turns[0]?.parts).toEqual([{ kind: 'text', text: 'One' }]);
    // The history of the follow-up includes the reopened turns.
    await ask(fresh, 'More please', 'Three');
    expect(fresh.ai.requests.at(-1)).toMatchObject({
      history: [
        { role: 'user', text: 'First chat' },
        { role: 'assistant', text: 'One' },
      ],
    });
    expect(fresh.history.files.get(uuid(1))?.turns).toHaveLength(2);
    expect(fresh.sync.savedIdOf(uuid(1))).toBe(uuid(1));
    // Reopening a chat that is already in the panel just shows it.
    fresh.controller.newConversation();
    await fresh.sync.reopen(uuid(1));
    expect(fresh.controller.getState().conversations.filter((c) => c.id === uuid(1))).toHaveLength(1);
  });

  it('deletes only after confirmation, and the chat leaves the panel too', async () => {
    const t = setup();
    await ask(t, 'Delete me', 'ok');
    await t.sync.openList();
    t.sync.askDelete(uuid(1));
    expect(t.sync.getState().confirmDelete).toBe(uuid(1));
    t.sync.cancelDelete();
    expect(t.history.calls.some((c) => c.startsWith('delete'))).toBe(false);
    t.sync.askDelete(uuid(1));
    await t.sync.confirmDelete();
    expect(t.history.calls).toContain(`delete ${uuid(1)}`);
    expect(t.sync.getState()).toMatchObject({ notice: 'ai.history.deleted', chats: [] });
    expect(t.controller.getState().conversations).toEqual([]);
  });

  it('sending a question while the list is shown goes back to the conversation', async () => {
    const t = setup();
    await t.sync.openList();
    expect(t.sync.getState().listOpen).toBe(true);
    t.controller.setPrompt('New question');
    await t.controller.send();
    expect(t.sync.getState().listOpen).toBe(false);
  });

  it('a failed save is said in words; the conversation stays in the panel', async () => {
    const t = setup();
    t.history.failSave = 'write-failed';
    await ask(t, 'q', 'a');
    expect(t.sync.getState().notice).toBe('ai.history.saveFailed');
    expect(t.controller.getState().conversations).toHaveLength(1);
    t.history.failSave = 'too-large';
    await ask(t, 'q2', 'a2');
    expect(t.sync.getState().notice).toBe('ai.history.tooLarge');
    t.history.failSave = false;
    await ask(t, 'q3', 'a3');
    expect(t.sync.getState().notice).toBeNull();
  });
});

describe('past chats UI (S39.1)', () => {
  const noop = () => undefined;
  const historyState = (patch: Partial<ChatHistoryState>): ChatHistoryState => ({
    listOpen: true,
    projectId: P,
    chats: [{ id: uuid(1), title: 'About page', createdAt: 1, updatedAt: Date.UTC(2026, 9, 15, 10), turnCount: 3 }],
    skipped: 0,
    confirmDelete: null,
    notice: null,
    ...patch,
  });
  const listActions = {
    reopen: async () => undefined,
    askDelete: noop,
    cancelDelete: noop,
    confirmDelete: async () => undefined,
    closeList: noop,
  };
  const list = (patch: Partial<ChatHistoryState>, locale: Locale = 'zh-CN') =>
    renderToStaticMarkup(
      createElement(SavedChatsList, {
        state: historyState(patch),
        actions: listActions,
        activeId: null,
        locale,
        t: tr(locale),
      }),
    );

  it('lists title, date and size with Open and Delete buttons; deleting asks first', () => {
    const out = list({});
    expect(out).toContain('About page');
    expect(out).toContain('更新于');
    expect(out).toContain('3 轮问答');
    expect(out).toContain('data-testid="ai-history-open"');
    expect(out).toContain('aria-label="删除对话“About page”"');
    expect(out).not.toContain('ai-history-confirm-delete');
    const confirming = list({ confirmDelete: uuid(1) }, 'en');
    expect(confirming).toContain('Delete the chat “About page”? This cannot be undone.');
    expect(confirming).toContain('data-testid="ai-history-confirm-delete"');
    expect(confirming).toContain('data-testid="ai-history-cancel-delete"');
    expect(list({ chats: [] }, 'en')).toContain('No saved chats yet.');
    expect(list({ skipped: 2 }, 'en')).toContain('2 saved chat(s) could not be read');
    expect(list({ chats: null }, 'en')).toContain('Loading past chats');
  });

  it('the panel offers "Past chats", shows the list in place of the conversation, and a history notice', () => {
    const actions = {
      close: noop,
      newConversation: noop,
      selectConversation: noop,
      setPrompt: noop,
      setKind: noop,
      removeChip: noop,
      addCurrentFile: () => true,
      addPreview: async () => true,
      addSelection: () => true,
      send: async () => undefined,
      stop: async () => undefined,
      consentGiven: async () => undefined,
      consentDeclined: noop,
    } satisfies ChatPanelActions;
    const render = (listOpen: boolean, notice: MessageKey | null = null) =>
      renderToStaticMarkup(
        createElement(ChatPanelView, {
          state: {
            ...INITIAL_CHAT_STATE,
            open: true,
            availability: { kind: 'ready', provider: 'anthropic', consent: true },
          },
          projectId: P,
          actions,
          consent: () => null,
          pastChats: { listOpen, onToggle: noop, notice, list: createElement('div', { 'data-testid': 'list-slot' }) },
          t: tr('en'),
        }),
      );
    const closed = render(false);
    expect(closed).toContain('data-testid="ai-history-toggle"');
    expect(closed).toContain('aria-pressed="false"');
    expect(closed).toContain('data-testid="ai-log"');
    expect(closed).not.toContain('list-slot');
    const open = render(true, 'ai.history.saveFailed');
    expect(open).toContain('list-slot');
    expect(open).not.toContain('data-testid="ai-log"');
    expect(open).toContain('could not be saved');
  });
});
