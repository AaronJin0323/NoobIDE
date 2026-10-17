import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { AI_ERROR_CODES, contextLabel, errorExplanation, providerName } from './chat-text';
import { ChatPanelView, type ChatPanelActions } from './ChatPanel';
import { INITIAL_CHAT_STATE, type ChatState, type ChatTurn } from './chat-model';
import type { AiChatExtensions } from './chat-extensions';

const noop = () => undefined;
const actions: ChatPanelActions = {
  close: noop,
  newConversation: noop,
  selectConversation: noop,
  setPrompt: noop,
  setKind: noop,
  removeChip: noop,
  addCurrentFile: () => true,
  addSelection: () => true,
  addPreview: async () => true,
  send: async () => undefined,
  stop: async () => undefined,
  consentGiven: async () => undefined,
  consentDeclined: noop,
};
const ready: ChatState['availability'] = { kind: 'ready', provider: 'anthropic', consent: true };

function render(
  state: Partial<ChatState>,
  options: { locale?: Locale; projectId?: string | null; settings?: boolean; extensions?: AiChatExtensions } = {},
) {
  const locale = options.locale ?? 'zh-CN';
  return renderToStaticMarkup(
    createElement(ChatPanelView, {
      state: { ...INITIAL_CHAT_STATE, open: true, availability: ready, ...state },
      projectId: options.projectId === undefined ? 'p1' : options.projectId,
      actions,
      consent: (props) => createElement('div', { 'data-testid': 'consent-slot' }, props.providerName),
      onOpenSettings: options.settings ? noop : undefined,
      extensions: options.extensions,
      t: (key: MessageKey) => translate(locale, key),
    }),
  );
}

const turn = (overrides: Partial<ChatTurn>): ChatTurn => ({
  id: 't1',
  kind: 'chat',
  mode: 'chat',
  prompt: '这段代码是做什么的？',
  context: [{ kind: 'file', relPath: 'index.html' }],
  requestId: 'r1',
  status: 'done',
  stopping: false,
  parts: [{ kind: 'text', text: '它显示一个**标题**。' }],
  ...overrides,
});
const withTurns = (...turns: ChatTurn[]): Partial<ChatState> => ({
  conversations: [{ id: 'c1', projectKey: 'p1', title: 'x', turns }],
  active: { p1: 'c1' },
});

describe('error explanations (S33.1)', () => {
  it('every AiErrorCode has its own explanation in zh-CN and en', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const t = (key: MessageKey) => translate(locale, key);
      const texts = AI_ERROR_CODES.map((code) => errorExplanation(t, code));
      expect(new Set(texts).size).toBe(AI_ERROR_CODES.length);
      for (const text of texts) expect(text).not.toBe(t('ai.error.generic'));
    }
    expect(errorExplanation((k) => translate('en', k), 'invalid-request')).toBe(translate('en', 'ai.error.generic'));
    expect(errorExplanation((k) => translate('en', k), 'offline')).toContain('network');
    expect(errorExplanation((k) => translate('zh-CN', k), 'offline')).toContain('网络');
  });

  it('names the provider and labels context items', () => {
    const t = (key: MessageKey) => translate('zh-CN', key);
    expect(providerName(t, 'anthropic')).toBe('Anthropic（Claude）');
    expect(contextLabel(t, { kind: 'file', relPath: '页面/首页.html' })).toBe('文件 页面/首页.html');
    expect(contextLabel(t, { kind: 'selection', relPath: 'a.js', startLine: 2, endLine: 5 })).toBe(
      'a.js 第 2–5 行（选中的代码）',
    );
    expect(contextLabel(t, { kind: 'selection', relPath: 'a.js', startLine: 2, endLine: 2 })).toBe(
      'a.js 第 2 行（选中的代码）',
    );
    expect(contextLabel(t, { kind: 'problem', relPath: 'a.js', startLine: 3, label: '找不到变量 x。' })).toBe(
      '问题：找不到变量 x。（a.js 第 3 行）',
    );
    const en = (key: MessageKey) => translate('en', key);
    expect(contextLabel(en, { kind: 'selection', relPath: 'a.js', startLine: 2, endLine: 5 })).toBe(
      'a.js lines 2–5 (selected code)',
    );
  });
});

describe('chat panel (S33.1)', () => {
  it('shows the chips that will be sent, each with a labelled remove button, and Send', () => {
    const out = render({
      drafts: {
        p1: {
          prompt: '解释一下',
          mode: 'explain-code',
          kind: 'chat',
          chips: [
            { id: 'a', item: { kind: 'file', relPath: 'index.html' } },
            { id: 'b', item: { kind: 'selection', relPath: 'script.js', startLine: 1, endLine: 3, text: 'x' } },
          ],
        },
      },
    });
    expect(out).toContain('会一起发送的内容');
    expect(out).toContain('文件 index.html');
    expect(out).toContain('aria-label="移除：文件 index.html"');
    expect(out).toContain('aria-label="移除：script.js 第 1–3 行（选中的代码）"');
    expect(out).toContain('模式：解释代码');
    // Send is an AI entry point: the sparkle icon and the written label.
    expect(out).toMatch(
      /class="ai-entry ai-entry-strong ai-send" data-testid="ai-send"[^>]*><svg[^]*?<\/svg>发送<\/button>/,
    );
    expect(out).not.toMatch(/data-testid="ai-send"[^>]*disabled/);
    expect(out).toContain('aria-label="向 AI 提问"');
  });

  it('the header keeps Close and New chat visible: icon buttons with names and tooltips', () => {
    const out = render(withTurns(turn({})), { locale: 'en' });
    expect(out).toMatch(/aria-label="New chat" title="New chat" data-testid="ai-new"/);
    expect(out).toMatch(/aria-label="Close the AI assistant" title="Close the AI assistant" data-testid="ai-close"/);
    // No text label in the header buttons that could push Close out of a narrow panel.
    expect(out).not.toMatch(/data-testid="ai-new"[^>]*>New chat</);
  });

  it('the context area is its own scroll box, so the input and Send always stay in view', () => {
    const out = render({
      drafts: { p1: { prompt: 'x', chips: [], mode: 'chat', kind: 'chat' } },
    });
    const context = out.indexOf('class="ai-context"');
    const input = out.indexOf('data-testid="ai-input"');
    const send = out.indexOf('data-testid="ai-send"');
    expect(context).toBeGreaterThan(-1);
    expect(context).toBeLessThan(input);
    expect(input).toBeLessThan(send);
    // The three ways to add context stay visible buttons (not folded into a menu).
    for (const id of ['ai-add-file', 'ai-add-selection', 'ai-add-preview'])
      expect(out).toContain(`data-testid="${id}"`);
    // The notice sits outside the scrolling context area, so it is never scrolled away.
    expect(out.indexOf('data-testid="ai-notice"')).toBeGreaterThan(out.indexOf('data-testid="ai-add-preview"'));
  });

  it('says when nothing from the project is sent', () => {
    expect(render({}, { locale: 'en' })).toContain('Only your question is sent, no code from the project.');
  });

  it('renders an answer as Markdown with what was sent, the state as text and the token usage', () => {
    const out = render(withTurns(turn({ usage: { inputTokens: 1234, outputTokens: 56 } })));
    expect(out).toContain('它显示一个<strong>标题</strong>。');
    expect(out).toContain('一起发送了：文件 index.html');
    expect(out).toContain('回答完成。');
    expect(out).toContain('用量：输入 1,234 个 token，输出 56 个 token');
  });

  it('while answering: Stop instead of Send, busy state as text', () => {
    const out = render(withTurns(turn({ status: 'streaming', parts: [] })), { locale: 'en' });
    expect(out).toContain('data-testid="ai-stop"');
    expect(out).not.toContain('data-testid="ai-send"');
    expect(out).toContain('The AI is answering…');
    expect(out).toContain('aria-busy="true"');
  });

  it('a cancelled turn says it stopped; an error is explained with its details', () => {
    expect(render(withTurns(turn({ status: 'cancelled' })))).toContain('已停止。上面是停止前收到的部分。');
    const out = render(
      withTurns(turn({ status: 'error', parts: [], error: { code: 'unauthorized', message: '401' } })),
      { locale: 'en', settings: true },
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('The AI service did not accept the API key.');
    expect(out).toContain('Details: 401');
    expect(out).toContain('Open AI settings');
  });

  it('explains the no-key and no-keychain states with a way to Settings', () => {
    const noKey = render({ availability: { kind: 'no-key' } }, { settings: true });
    expect(noKey).toContain('还没有填写 AI 的 API 密钥');
    expect(noKey).toContain('打开 AI 设置');
    const where = render({ availability: { kind: 'no-key' } }, { locale: 'en' });
    expect(where).toContain('AI settings is in the “Help and more” menu');
    // Outside the app (no platform bridge) the key store is named generically, never the macOS Keychain.
    expect(render({ availability: { kind: 'no-secure-storage' } })).toContain('系统的安全存储不可用');
    expect(render({ availability: { kind: 'no-key' } })).not.toContain('{keyStore}');
    expect(render({ availability: { kind: 'disabled' } }, { locale: 'en' })).toContain('AI is switched off');
  });

  it('shows the consent slot for the project waiting on it, and Send waits', () => {
    const out = render({
      consentFor: 'p1',
      availability: { kind: 'ready', provider: 'openai', consent: false },
      drafts: { p1: { prompt: 'x', chips: [], mode: 'chat', kind: 'chat' } },
    });
    expect(out).toContain('<div data-testid="consent-slot">OpenAI</div>');
    expect(out).toMatch(/data-testid="ai-send"[^>]*disabled/);
  });

  it('agent parts: default text without an extension, the extension’s renderers with one', () => {
    const agentTurn = turn({
      kind: 'agent',
      parts: [
        { kind: 'step', tool: 'read_file', summary: '读取 index.html' },
        { kind: 'proposal', proposalId: 'x', changes: [{ kind: 'delete', relPath: 'a.css' }], reason: '没用了' },
      ],
    });
    const plain = render(withTurns(agentTurn));
    // The step reads as a sentence; the tool id is only an attribute (not shown to the user).
    expect(plain).toContain('data-tool="read_file">读取 index.html</div>');
    expect(plain.replace(/data-tool="[^"]*"/g, '')).not.toContain('read_file');
    expect(plain).toContain('AI 想修改 1 个文件');
    const extended = render(withTurns(agentTurn), {
      extensions: {
        agent: true,
        renderStep: (part) => createElement('span', null, `STEP ${part.tool}`),
        renderProposal: (part) => createElement('span', null, `REVIEW ${part.proposalId}`),
      },
    });
    expect(extended).toContain('STEP read_file');
    expect(extended).toContain('REVIEW x');
    expect(extended).toContain('data-testid="ai-kind"');
  });
});

describe('auto-growing composer (S48.2)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const draft = (prompt: string): Partial<ChatState> => ({
    drafts: { p1: { prompt, chips: [], mode: 'chat', kind: 'chat' } },
  });
  const css = readFileSync(new URL('./ai-chat.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  /** The declarations of the last rule whose selector list is exactly `selector`. */
  const rule = (selector: string) => {
    const at = css.lastIndexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('grows by field-sizing where supported: one row, no mirror', () => {
    vi.stubGlobal('CSS', { supports: (p: string, v: string) => p === 'field-sizing' && v === 'content' });
    const out = render(draft('第一行\n第二行'));
    expect(out).toContain('data-grow="css"');
    expect(out).toMatch(/<textarea[^>]*rows="1"[^>]*data-testid="ai-input"/);
    expect(out).not.toContain('ai-input-mirror');
  });

  it('falls back to a hidden mirror of the text, with a trailing space so a final empty line counts', () => {
    const out = render(draft('第一行\n'));
    expect(out).toContain('data-grow="mirror"');
    expect(out).toContain(
      '<span class="ai-input-mirror" aria-hidden="true" data-testid="ai-input-mirror">第一行\n </span>',
    );
    // The mirror shares the textarea's grid cell, inside the grow wrapper.
    expect(out.indexOf('class="ai-input-grow"')).toBeLessThan(out.indexOf('data-testid="ai-input"'));
    expect(out.indexOf('data-testid="ai-input"')).toBeLessThan(out.indexOf('ai-input-mirror'));
  });

  it('sizes from 44px to min(40svh, 200px) with no resize handle', () => {
    const shared = rule('.ai-input,\n.ai-input-mirror');
    expect(shared).toContain('grid-area: 1 / 1;');
    expect(shared).toContain('min-height: 44px;');
    expect(shared).toContain('max-height: min(40svh, 200px);');
    const input = rule('.ai-input');
    expect(input).toContain('field-sizing: content;');
    expect(input).toContain('resize: none;');
    expect(css).not.toMatch(/resize:\s*vertical/);
    expect(rule('.ai-input-mirror')).toContain('visibility: hidden;');
  });
});
