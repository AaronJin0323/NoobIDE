import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiUsageSummary } from '../../shared/ipc/ai-history-contract';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { I18nValueProvider } from '../i18n/I18nProvider';
import { budgetStateText, parseBudgetInput, RevokeChatsPrompt, usageLines } from './AiHistorySettings';
import { inlineAvailable } from './ai-status';
import { ChatPanelView, type ChatPanelActions } from './ChatPanel';
import { INITIAL_CHAT_STATE, type ChatTurn } from './chat-model';
import { AI_ERROR_CODES, errorExplanation } from './chat-text';
import { readyStatus } from './fake-ai-api';
import { statusBlockReason } from './inline-context';
import { initialEditState, inlineEditReducer, type InlineEditState } from './inline-edit-model';
import { InlineEditPanel } from './InlineEditPanel';

/** S39.2: token use shown as text on every AI answer, in Settings → AI, and the daily budget's states in words. */
const tr = (locale: Locale) => (key: MessageKey) => translate(locale, key);
const usage = (patch: Partial<AiUsageSummary> = {}): AiUsageSummary => ({
  day: '2026-10-15',
  perProvider: {
    anthropic: { inputTokens: 12_345, outputTokens: 678 },
    openai: { inputTokens: 0, outputTokens: 0 },
  },
  totalTokens: 13_023,
  dailyBudget: null,
  budgetReached: false,
  ...patch,
});

describe('Settings → AI usage (S39.2)', () => {
  it('shows today’s tokens per provider and the total, in both languages', () => {
    expect(usageLines(tr('en'), usage(), 'en')).toEqual([
      'Anthropic (Claude): 12,345 input, 678 output',
      'OpenAI: 0 input, 0 output',
      'Total today: 13,023 tokens',
    ]);
    const zh = usageLines(tr('zh-CN'), usage(), 'zh-CN');
    expect(zh[0]).toContain('输入 12,345 个');
    expect(zh[2]).toBe('今天合计：13,023 个 token');
  });

  it('says the budget state in words: off, used of limit, reached', () => {
    expect(budgetStateText(tr('en'), usage(), 'en')).toBe('No daily limit.');
    expect(budgetStateText(tr('en'), usage({ dailyBudget: 200_000 }), 'en')).toBe(
      'Used today: 13,023 of 200,000 tokens.',
    );
    const reached = budgetStateText(tr('en'), usage({ dailyBudget: 10_000, budgetReached: true }), 'en');
    expect(reached).toContain('paused until tomorrow');
    expect(reached).toContain('Everything else works as usual');
    expect(budgetStateText(tr('zh-CN'), usage({ dailyBudget: 10_000, budgetReached: true }), 'zh-CN')).toContain(
      '其他功能不受影响',
    );
  });

  it('reads the budget field as a whole number in range', () => {
    expect(parseBudgetInput('200000')).toBe(200_000);
    expect(parseBudgetInput(' 200,000 ')).toBe(200_000);
    expect(parseBudgetInput('999')).toBeNull();
    expect(parseBudgetInput('12.5k')).toBeNull();
    expect(parseBudgetInput('')).toBeNull();
    expect(parseBudgetInput('99999999999')).toBeNull();
  });

  it('a refused request is explained (budget-reached has its own text in both languages)', () => {
    expect(AI_ERROR_CODES).toContain('budget-reached');
    expect(errorExplanation(tr('en'), 'budget-reached')).toContain('token limit is used up');
    expect(errorExplanation(tr('zh-CN'), 'budget-reached')).toContain('上限已经用完');
  });
});

describe('inline suggestions pause when the budget is reached (S39.2)', () => {
  it('blocks requests and is said as text in the status line', () => {
    expect(statusBlockReason(readyStatus({ budgetReached: true }))).toBe('budget-reached');
    expect(statusBlockReason(readyStatus({ budgetReached: false }))).toBeNull();
    expect(statusBlockReason(readyStatus())).toBeNull();
    expect(inlineAvailable(readyStatus({ budgetReached: true }))).toBe(false);
    expect(translate('en', 'ai.inline.status.paused')).toContain('paused');
    expect(translate('zh-CN', 'ai.inline.status.paused')).toContain('已暂停');
  });
});

describe('token use on every answer (S39.2)', () => {
  const noop = () => undefined;

  it('inline edit: the proposed change shows the tokens it used', () => {
    const running: InlineEditState = { ...initialEditState('instruction', 'blue'), phase: 'running' };
    const review = inlineEditReducer(running, {
      type: 'answer',
      original: '<p>red</p>',
      text: '<p>blue</p>',
      eol: '\n',
      usage: { inputTokens: 1500, outputTokens: 42 },
    });
    expect(review).toMatchObject({ phase: 'review', usage: { inputTokens: 1500, outputTokens: 42 } });
    // Trying again forgets the old count.
    expect(inlineEditReducer({ ...review, phase: 'cancelled' }, { type: 'send' }).usage).toBeUndefined();
    const html = renderToStaticMarkup(
      createElement(
        I18nValueProvider,
        { value: { locale: 'en', t: tr('en'), setLocale: noop } },
        createElement(InlineEditPanel, {
          state: review,
          target: { relPath: 'index.html', startLine: 1, endLine: 1, wholeFile: false },
          original: '<p>red</p>',
          platform: 'windows',
          actions: {
            instruction: noop,
            send: noop,
            stop: noop,
            accept: noop,
            reject: noop,
            close: noop,
            openSettings: noop,
          },
        }),
      ),
    );
    expect(html).toContain('data-testid="inline-edit-usage"');
    expect(html).toContain('Usage: 1,500 input tokens, 42 output tokens');
  });

  it('chat and agent turns show input and output tokens as text', () => {
    const turn = (kind: ChatTurn['kind'], id: string): ChatTurn => ({
      id,
      kind,
      mode: 'chat',
      prompt: 'q',
      context: [],
      requestId: id,
      status: 'done',
      stopping: false,
      parts: [{ kind: 'text', text: 'a' }],
      usage: { inputTokens: kind === 'agent' ? 5100 : 300, outputTokens: kind === 'agent' ? 170 : 12 },
    });
    const actions: ChatPanelActions = {
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
    };
    const html = renderToStaticMarkup(
      createElement(ChatPanelView, {
        state: {
          ...INITIAL_CHAT_STATE,
          open: true,
          availability: { kind: 'ready', provider: 'anthropic', consent: true },
          conversations: [{ id: 'c1', projectKey: 'p1', title: 'x', turns: [turn('chat', 'r1'), turn('agent', 'r2')] }],
          active: { p1: 'c1' },
        },
        projectId: 'p1',
        actions,
        consent: () => null,
        t: tr('en'),
      }),
    );
    expect(html).toContain('Usage: 300 input tokens, 12 output tokens');
    expect(html).toContain('Usage: 5,100 input tokens, 170 output tokens');
  });
});

describe('revoking consent offers to delete the project’s chats (S39.1)', () => {
  it('says how many chats there are, with Delete and Keep buttons', () => {
    const api = {} as never;
    const html = renderToStaticMarkup(
      createElement(RevokeChatsPrompt, { api, projectId: 'p1', count: 2, onDone: () => undefined, t: tr('en') }),
    );
    expect(html).toContain('This project also has 2 saved AI chat(s). Delete them too?');
    expect(html).toContain('data-testid="ai-revoke-chats-delete"');
    expect(html).toContain('data-testid="ai-revoke-chats-keep"');
    const zh = renderToStaticMarkup(
      createElement(RevokeChatsPrompt, { api, projectId: 'p1', count: 2, onDone: () => undefined, t: tr('zh-CN') }),
    );
    expect(zh).toContain('这个项目还有 2 个保存的 AI 对话');
  });
});
