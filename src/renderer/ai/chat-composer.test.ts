import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate, type Locale, type MessageKey } from '../i18n/index';
import { ChatPanelView, type ChatPanelActions, type ChatPanelProps } from './ChatPanel';
import type { ComposerSources } from './ComposerSuggestions';
import { INITIAL_CHAT_STATE, type ChatState, type ChatTurn } from './chat-model';

const noop = () => undefined;
const actions: ChatPanelActions = {
  close: noop,
  newConversation: noop,
  selectConversation: noop,
  setPrompt: noop,
  setKind: noop,
  removeChip: noop,
  addCurrentFile: () => true,
  addFile: noop,
  addSelection: () => true,
  addPreview: async () => true,
  send: async () => undefined,
  stop: async () => undefined,
  consentGiven: async () => undefined,
  consentDeclined: noop,
};
const sources: ComposerSources = {
  commands: () => [],
  runCommand: noop,
  projectFiles: async () => [],
};
const ready: ChatState['availability'] = { kind: 'ready', provider: 'anthropic', consent: true };

export function renderPanel(
  state: Partial<ChatState>,
  options: { locale?: Locale; composer?: ComposerSources; actions?: ChatPanelActions } & Partial<ChatPanelProps> = {},
) {
  const locale = options.locale ?? 'zh-CN';
  return renderToStaticMarkup(
    createElement(ChatPanelView, {
      state: { ...INITIAL_CHAT_STATE, open: true, availability: ready, ...state },
      projectId: 'p1',
      actions: options.actions ?? actions,
      consent: () => null,
      composer: options.composer,
      t: (key: MessageKey, count?: number) => translate(locale, key, count),
      locale,
    }),
  );
}

export const turnOf = (overrides: Partial<ChatTurn>): ChatTurn => ({
  id: 't1',
  kind: 'chat',
  mode: 'chat',
  prompt: '这段代码是做什么的？',
  context: [],
  requestId: 'r1',
  status: 'done',
  stopping: false,
  parts: [{ kind: 'text', text: '它显示一个标题。' }],
  ...overrides,
});

describe('composer slash commands and @file mentions (S48.4)', () => {
  it.each(['zh-CN', 'en'] as const)('names / and @ in the hint and keeps the three Add buttons (%s)', (locale) => {
    const html = renderPanel({}, { locale, composer: sources });
    expect(html).toContain(translate(locale, 'ai.composer.triggerHint'));
    for (const id of ['ai-add-file', 'ai-add-selection', 'ai-add-preview']) expect(html).toContain(`"${id}"`);
    // Closed list: the textarea is a plain textbox without list attributes.
    expect(html).not.toContain('aria-activedescendant');
    expect(html).not.toContain('data-testid="ai-suggest"');
  });

  it('without sources, / and @ are plain text (no hint)', () => {
    expect(renderPanel({})).not.toContain(translate('zh-CN', 'ai.composer.triggerHint'));
  });
});
