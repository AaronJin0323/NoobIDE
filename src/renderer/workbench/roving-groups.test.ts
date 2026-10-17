import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nValueProvider } from '../i18n/I18nProvider';
import { translate, type MessageKey } from '../i18n/index';
import { ChatPanelView, type ChatPanelActions } from '../ai/ChatPanel';
import { INITIAL_CHAT_STATE } from '../ai/chat-model';
import { ProposalReview } from '../ai/ProposalReview';
import { PreviewPane } from './PreviewPane';
import { Rail } from './Rail';
import { TopBar } from './TopBar';

/**
 * S49.2: every toolbar and group named by the plan carries the roving-focus hook, with the orientation its arrows
 * follow. The keyboard behaviour itself is roving-focus.test.ts (rules) and tests/e2e/roving-focus.spec.ts (real
 * keys, F6, axe).
 */

const t = (key: MessageKey) => translate('en', key);
const noop = () => undefined;

function html(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(I18nValueProvider, { value: { locale: 'en', t, setLocale: noop } }, element),
  );
}

/** The opening tag of the element with `marker` (a test id or class), to read its attributes. */
function tagWith(markup: string, marker: string): string {
  const at = markup.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const start = markup.lastIndexOf('<', at);
  return markup.slice(start, markup.indexOf('>', at) + 1);
}

afterEach(() => vi.unstubAllGlobals());

describe('roving focus groups (S49.2)', () => {
  it('the rail moves with up/down', () => {
    const markup = html(
      createElement(Rail, {
        filesVisible: true,
        problemsOpen: false,
        onToggleFiles: noop,
        onToggleProblems: noop,
        onShowHistory: noop,
        onShowLessons: noop,
        ai: { open: false, onToggle: noop },
      }),
    );
    expect(tagWith(markup, 'data-testid="rail"')).toContain('data-roving="vertical"');
  });

  it('the Code/Preview switch moves with left/right', () => {
    const markup = html(
      createElement(TopBar, {
        platform: 'windows',
        project: null,
        save: null,
        narrow: { view: 'code', onShow: noop },
      }),
    );
    expect(tagWith(markup, 'data-testid="narrow-switch"')).toContain('data-roving="horizontal"');
  });

  it('the preview toolbar and the viewport switch move with left/right', () => {
    vi.stubGlobal('window', {});
    const markup = html(createElement(PreviewPane, { hidden: false, projectId: 'p1' }));
    const toolbar = tagWith(markup, 'class="preview-actions"');
    expect(toolbar).toContain('role="toolbar"');
    expect(toolbar).toContain('data-roving="horizontal"');
    expect(tagWith(markup, 'data-testid="viewport-switch"')).toContain('data-roving="horizontal"');
  });

  it('the chat add-context group moves with left/right', () => {
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
    const markup = html(
      createElement(ChatPanelView, {
        state: {
          ...INITIAL_CHAT_STATE,
          open: true,
          availability: { kind: 'ready', provider: 'anthropic', consent: true },
        },
        projectId: 'p1',
        actions,
        consent: () => null,
        t,
      }),
    );
    expect(tagWith(markup, 'class="ai-context-add"')).toContain('data-roving="horizontal"');
  });

  it('the proposal action rows (each change and accept/reject all) move with left/right', () => {
    const change = { kind: 'delete', relPath: 'a.css' } as const;
    const markup = html(
      createElement(ProposalReview, {
        proposalId: 'p',
        changes: [change, { ...change, relPath: 'b.css' }],
        reason: 'r',
        views: [{ state: 'pending' }, { state: 'pending' }],
        busy: false,
        onAccept: noop,
        onReject: noop,
        onAcceptAll: noop,
        onRejectAll: noop,
      }),
    );
    expect(markup.match(/class="agent-change-actions" data-roving="horizontal"/g)).toHaveLength(2);
    expect(tagWith(markup, 'class="agent-proposal-actions"')).toContain('data-roving="horizontal"');
  });
});
