import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiDraftApi, AiStoredDraft } from '../../shared/ipc/ai-draft-contract';
import { parseSaveDraft } from '../../shared/ipc/ai-draft-parse';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { AiChatController, canRetry, type AiChatHost, type ChatClock } from './chat-controller';
import { activeConversation, chatReducer, draftOf, INITIAL_CHAT_STATE, type ChatTurn } from './chat-model';
import { DRAFT_DEBOUNCE_MS, DraftSync, toStoredDraft } from './draft-sync';
import { fakeAiApi, type FakeAiApi } from './fake-ai-api';
import { RetryControls, waitInWords } from './RetryControls';

const P = '11111111-2222-4333-8444-555555555555'; // a project id as main issues them (its parser checks it)
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Timers that run only when the test moves the clock. */
function fakeClock(): ChatClock & { advance(ms: number): void; pending(): number[] } {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    random: () => 0.5, // jitter 1.0
    setTimeout: (run, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && timers.has(id)) {
          timers.delete(id);
          timer.run();
        }
      }
    },
    pending: () => [...timers.values()].map((t) => t.at - now),
  };
}

/** Main's draft store as the renderer sees it; payloads must pass main's parser. */
function fakeDraftApi() {
  const files = new Map<string, AiStoredDraft[]>();
  let time = 1;
  const api: AiDraftApi & { files: typeof files; saves: number; fail: boolean } = {
    files,
    saves: 0,
    fail: false,
    getDrafts: async ({ projectId }) => ({ ok: true, value: { drafts: files.get(String(projectId)) ?? [] } }),
    saveDraft: async (request) => {
      api.saves += 1;
      expect(parseSaveDraft(request)).toEqual(request);
      if (api.fail) return { ok: false, code: 'write-failed', message: 'EACCES' };
      const list = (files.get(String(request.projectId)) ?? []).filter((d) => d.key !== request.key);
      if (request.draft) list.unshift({ key: request.key, updatedAt: (time += 1), ...request.draft });
      files.set(String(request.projectId), list);
      return { ok: true, value: null };
    },
  };
  return api;
}

function setup(drafts = fakeDraftApi(), ai: FakeAiApi = fakeAiApi()) {
  const clock = fakeClock();
  const host = { projectId: P as string | null };
  const chatHost: AiChatHost = {
    projectId: () => host.projectId,
    locale: () => 'en',
    activeFile: () => 'index.html',
    fileText: () => '<h1>x</h1>',
    selection: () => null,
  };
  const controller = new AiChatController(ai, chatHost, undefined, clock);
  controller.start();
  const savedIds = new Map<string, string>();
  const sync = new DraftSync(
    drafts,
    controller,
    () => host.projectId,
    (id) => (id ? (savedIds.get(id) ?? null) : null),
    clock,
  );
  sync.start();
  const draft = () => draftOf(controller.getState(), host.projectId ?? '');
  return { ai, drafts, clock, host, controller, sync, savedIds, draft };
}

describe('zero-loss drafts (S48.7)', () => {
  it('keeps the unsent text and chips 300 ms after the last change, and brings them back after a restart', async () => {
    const t = setup();
    await t.sync.projectChanged();
    t.controller.addChip({
      kind: 'selection',
      relPath: '中文 目录/页面.js',
      startLine: 2,
      endLine: 3,
      text: 'let a = 1;',
    });
    t.controller.setPrompt('为什么');
    t.clock.advance(DRAFT_DEBOUNCE_MS - 1);
    t.controller.setPrompt('为什么不显示？');
    t.clock.advance(DRAFT_DEBOUNCE_MS - 1);
    expect(t.drafts.saves).toBe(0); // debounced: nothing written while typing
    t.clock.advance(1);
    await t.sync.flush();
    expect(t.drafts.saves).toBe(1);
    expect(t.drafts.files.get(P)).toMatchObject([
      {
        key: 'new',
        prompt: '为什么不显示？',
        chips: [{ kind: 'selection', relPath: '中文 目录/页面.js', startLine: 2, endLine: 3, text: 'let a = 1;' }],
      },
    ]);

    // A restart: a new window with the same app data.
    const next = setup(t.drafts);
    await next.sync.projectChanged();
    expect(next.draft().prompt).toBe('为什么不显示？');
    expect(next.draft().chips.map((c) => c.item)).toEqual([
      { kind: 'selection', relPath: '中文 目录/页面.js', startLine: 2, endLine: 3, text: 'let a = 1;' },
    ]);
    expect(next.controller.getState().notice).toBe('ai.draft.restored');
    // Restoring writes nothing back.
    next.clock.advance(1000);
    await next.sync.flush();
    expect(next.drafts.saves).toBe(1);
  });

  it('never replaces what was typed before the kept draft arrived', async () => {
    const drafts = fakeDraftApi();
    drafts.files.set(P, [{ key: 'new', updatedAt: 1, prompt: 'old', chips: [], kind: 'chat', mode: 'chat' }]);
    const t = setup(drafts);
    t.controller.setPrompt('typed first');
    await t.sync.projectChanged();
    expect(t.draft().prompt).toBe('typed first');
    expect(t.controller.getState().notice).toBeNull();
  });

  it('keeps one draft per conversation: a saved chat gets its own draft back when reopened', async () => {
    const t = setup();
    await t.sync.projectChanged();
    t.controller.setPrompt('first question');
    await t.controller.send();
    t.ai.emit({ requestId: 'r1', type: 'done' });
    const conversationId = activeConversation(t.controller.getState(), P)!.id;
    t.savedIds.set(conversationId, uuid(1)); // chat-history saved it
    t.controller.setPrompt('follow-up not sent');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    t.controller.newConversation();
    expect(t.draft().prompt).toBe(''); // the new conversation has its own (empty) draft
    t.controller.setPrompt('something else');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.drafts.files.get(P)?.map((d) => [d.key, d.prompt])).toEqual([
      ['new', 'something else'],
      [uuid(1), 'follow-up not sent'],
    ]);

    // Restart, then reopen the saved chat: its draft comes back in it, the new conversation keeps its own.
    const next = setup(t.drafts);
    await next.sync.projectChanged();
    expect(next.draft().prompt).toBe('something else');
    next.savedIds.set(uuid(1), uuid(1));
    next.controller.restoreConversation({ id: uuid(1), projectKey: P, title: 'first question', turns: [] });
    expect(next.draft().prompt).toBe('follow-up not sent');
    expect(next.controller.getState().notice).toBe('ai.draft.restored');
  });

  it('drops the `new` draft once its conversation is saved, and forgets a sent draft', async () => {
    const t = setup();
    await t.sync.projectChanged();
    t.controller.addChip({ kind: 'file', relPath: 'index.html' });
    t.controller.setPrompt('q');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    await t.controller.send();
    // The chips stay for the follow-up: kept under `new` until the conversation has a saved id.
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.drafts.files.get(P)).toMatchObject([{ key: 'new', prompt: '', chips: [{ kind: 'file' }] }]);
    t.ai.emit({ requestId: 'r1', type: 'done' });
    t.savedIds.set(activeConversation(t.controller.getState(), P)!.id, uuid(7));
    t.controller.setPrompt('next');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.drafts.files.get(P)?.map((d) => d.key)).toEqual([uuid(7)]);
  });

  it('leaves out Preview chips (their snapshot expires) and says once when the store refuses', async () => {
    expect(
      toStoredDraft({
        prompt: '',
        mode: 'chat',
        kind: 'chat',
        chips: [{ id: 'a', item: { kind: 'preview', label: '/', text: 'page', snapshotId: 's' } }],
      }),
    ).toBeNull();
    const t = setup();
    t.drafts.fail = true;
    await t.sync.projectChanged();
    t.controller.setPrompt('keep me');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.controller.getState().notice).toBe('ai.draft.saveFailed');
    expect(t.draft().prompt).toBe('keep me'); // the text stays in the panel
  });

  it('an empty draft in another conversation never deletes the kept one (review finding)', async () => {
    const t = setup();
    t.host.projectId = null; // chats without a project are never saved: they share the `new` slot
    await t.sync.projectChanged();
    t.controller.setPrompt('asked');
    await t.controller.send();
    t.ai.emit({ requestId: 'r1', type: 'done' });
    t.controller.setPrompt('unsent follow-up in A');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    t.controller.newConversation(); // its draft is empty
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.drafts.files.get('null')).toMatchObject([{ key: 'new', prompt: 'unsent follow-up in A' }]);
    // Once A's text is sent, the slot is free again.
    t.controller.selectConversation(t.controller.getState().conversations[0]!.id);
    await t.controller.send();
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.drafts.files.get('null')).toEqual([]);
  });

  it('a draft cut to the store limits is announced, never silently shortened', async () => {
    const t = setup();
    await t.sync.projectChanged();
    t.controller.setPrompt('x'.repeat(200_001));
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.controller.getState().notice).toBe('ai.draft.saveFailed');
    expect(t.draft().prompt).toHaveLength(200_001); // the panel keeps all of it
  });

  it('chats without a project keep their draft too', async () => {
    const t = setup();
    t.host.projectId = null;
    await t.sync.projectChanged();
    t.controller.setPrompt('general question');
    t.clock.advance(DRAFT_DEBOUNCE_MS);
    await t.sync.flush();
    expect(t.drafts.files.get('null')).toMatchObject([{ key: 'new', prompt: 'general question' }]);
  });
});

describe('per-conversation drafts in the model (S48.7)', () => {
  it('a draft belongs to its conversation; the new conversation keeps its own', () => {
    let s = chatReducer(INITIAL_CHAT_STATE, { type: 'setPrompt', projectKey: P, prompt: 'new one' });
    const turn: ChatTurn = {
      id: 't1',
      kind: 'chat',
      mode: 'chat',
      prompt: 'q',
      context: [],
      requestId: null,
      status: 'done',
      stopping: false,
      parts: [],
    };
    s = chatReducer(s, { type: 'turnStarted', projectKey: P, conversationId: 'c1', turn });
    expect(draftOf(s, P).prompt).toBe('');
    s = chatReducer(s, { type: 'setPrompt', projectKey: P, prompt: 'in c1' });
    s = chatReducer(s, { type: 'newConversation', projectKey: P });
    expect(draftOf(s, P).prompt).toBe('');
    s = chatReducer(s, { type: 'setPrompt', projectKey: P, prompt: 'in new' });
    s = chatReducer(s, { type: 'selectConversation', projectKey: P, id: 'c1' });
    expect(draftOf(s, P).prompt).toBe('in c1');
    s = chatReducer(s, { type: 'newConversation', projectKey: P });
    expect(draftOf(s, P).prompt).toBe('in new');
  });
});

describe('Retry and provider backoff (S48.7)', () => {
  async function failed(
    t: ReturnType<typeof setup>,
    status?: number,
    code: 'provider-error' | 'rate-limited' | 'offline' = 'provider-error',
  ) {
    t.controller.setPrompt('能帮我看看吗？');
    await t.controller.send();
    const requestId = `r${t.ai.requests.length}`;
    t.ai.emit({ requestId, type: 'error', code, message: `fake ${status ?? code}`, ...(status ? { status } : {}) });
    return () => activeConversation(t.controller.getState(), P)!.turns.at(-1)!;
  }

  it('a failed send keeps the question and Retry asks it again in place, with the same context', async () => {
    const t = setup();
    t.controller.addChip({ kind: 'file', relPath: 'index.html' });
    const turn = await failed(t, undefined, 'offline');
    expect(turn()).toMatchObject({ status: 'error', prompt: '能帮我看看吗？', error: { code: 'offline' } });
    expect(turn().retry).toBeUndefined(); // offline: no automatic retry
    expect(t.clock.pending()).toEqual([]);
    await t.controller.retry(turn().id);
    expect(t.ai.requests).toHaveLength(2);
    const first = t.ai.requests[0] as { context?: unknown };
    expect(t.ai.requests[1]).toMatchObject({ prompt: '能帮我看看吗？', context: first.context });
    expect(turn()).toMatchObject({ status: 'streaming', parts: [] });
    expect(turn().error).toBeUndefined();
    t.ai.emit({ requestId: 'r2', type: 'text', text: 'OK' });
    t.ai.emit({ requestId: 'r2', type: 'done' });
    expect(turn().status).toBe('done');
    expect(activeConversation(t.controller.getState(), P)!.turns).toHaveLength(1);
  });

  it('503 and 429 retry by themselves after 5 s, 10 s, 20 s (three times), then only by hand', async () => {
    const t = setup();
    const turn = await failed(t, 503);
    expect(turn().retry).toEqual({ automatic: 0, dueAt: t.clock.now() + 5_000, cause: 503 });
    for (const [n, wait] of [
      [1, 5_000],
      [2, 10_000],
      [3, 20_000],
    ] as const) {
      expect(t.clock.pending()).toEqual([wait]);
      t.clock.advance(wait - 1);
      expect(t.ai.requests).toHaveLength(n);
      t.clock.advance(1);
      await settle();
      expect(t.ai.requests).toHaveLength(n + 1);
      expect(turn().retry?.automatic).toBe(n);
      t.ai.emit({ requestId: `r${n + 1}`, type: 'error', code: 'rate-limited', message: 'fake 429', status: 429 });
    }
    expect(turn().retry).toEqual({ automatic: 3, dueAt: null, cause: 429 });
    expect(t.clock.pending()).toEqual([]);
    // By hand it goes again, and the automatic count starts over.
    await t.controller.retry(turn().id);
    expect(t.ai.requests).toHaveLength(5);
    expect(turn().retry?.automatic).toBe(0);
  });

  it('honours Retry-After as the base, and Retry now cancels the waiting retry', async () => {
    const t = setup();
    t.controller.setPrompt('q');
    await t.controller.send();
    t.ai.emit({
      requestId: 'r1',
      type: 'error',
      code: 'rate-limited',
      message: 'x',
      status: 429,
      retryAfterSeconds: 42,
    });
    const turn = activeConversation(t.controller.getState(), P)!.turns[0]!;
    expect(turn.retry?.dueAt).toBe(t.clock.now() + 42_000);
    await t.controller.retry(turn.id);
    expect(t.clock.pending()).toEqual([]);
    expect(t.ai.requests).toHaveLength(2);
  });

  it('a new question ends an earlier waiting retry (no stale countdown)', async () => {
    const t = setup();
    const turn = await failed(t, 503);
    expect(t.clock.pending()).toEqual([5_000]);
    t.controller.setPrompt('another question');
    await t.controller.send();
    expect(t.clock.pending()).toEqual([]);
    expect(turn()).not.toBe(undefined);
    const first = activeConversation(t.controller.getState(), P)!.turns[0]!;
    expect(first.retry?.dueAt).toBeNull();
    t.clock.advance(60_000);
    await settle();
    expect(t.ai.requests).toHaveLength(2); // the old question was not sent again
  });

  it('never retries a question that proposed changes', () => {
    const base: ChatTurn = {
      id: 't',
      kind: 'agent',
      mode: 'chat',
      prompt: 'q',
      context: [],
      requestId: 'r',
      status: 'error',
      stopping: false,
      parts: [],
      error: { code: 'provider-error', message: '', status: 503 },
    };
    expect(canRetry(base)).toBe(true);
    expect(canRetry({ ...base, parts: [{ kind: 'proposal', proposalId: 'p', changes: [], reason: '' }] })).toBe(false);
    expect(canRetry({ ...base, status: 'done' })).toBe(false);
  });
});

describe('Retry controls in the panel (S48.7)', () => {
  const tr = (locale: Locale) => (key: MessageKey, count?: number) => translate(locale, key, count);
  const turn = (overrides: Partial<ChatTurn>): ChatTurn => ({
    id: 't',
    kind: 'chat',
    mode: 'chat',
    prompt: 'q',
    context: [],
    requestId: 'r',
    status: 'error',
    stopping: false,
    parts: [],
    error: { code: 'provider-error', message: 'fake 503', status: 503 },
    ...overrides,
  });
  const render = (t: ChatTurn, locale: Locale, now = 0) =>
    renderToStaticMarkup(
      createElement(RetryControls, { turn: t, onRetry: () => undefined, t: tr(locale), now: () => now }),
    );

  it('says the wait in words', () => {
    expect(waitInWords(4_250, tr('en'))).toBe('5 seconds');
    expect(waitInWords(1_000, tr('en'))).toBe('1 second');
    expect(waitInWords(80_000, tr('en'))).toBe('1 minute 20 seconds');
    expect(waitInWords(120_000, tr('en'))).toBe('2 minutes');
    expect(waitInWords(80_000, tr('zh-CN'))).toBe('1 分钟 20 秒');
  });

  it.each([
    ['en', 'Trying again in 12 seconds (attempt 1 of 3).', 'Retry now'],
    ['zh-CN', '12 秒后自动重试（第 1 次，最多 3 次）。', '立即重试'],
  ] as const)('shows the countdown as a timer with Retry now (%s)', (locale, sentence, button) => {
    const html = render(turn({ retry: { automatic: 0, dueAt: 12_000, cause: 503 } }), locale);
    expect(html).toContain('role="timer"');
    expect(html).toContain(sentence);
    expect(html).toContain(button);
  });

  it('after three automatic retries only Retry is left, and the sentence says so', () => {
    const html = render(turn({ retry: { automatic: 3, dueAt: null, cause: 429 } }), 'en');
    expect(html).toContain('Tried again 3 times automatically without success.');
    expect(html).toContain('>Retry</button>'.replace('>Retry', 'Retry'));
    expect(html).not.toContain('role="timer"');
  });
});
