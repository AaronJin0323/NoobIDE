import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/index';
import { ChatPanelView, type ChatPanelActions } from '../ai/ChatPanel';
import { INITIAL_CHAT_STATE, type ChatTurn } from '../ai/chat-model';
import { Markdown } from '../ai/Markdown';
import { PreviewStateIcon } from '../workbench/PreviewStateIcon';
import { declarations } from '../design-rules.test';
import { COPIED_MS, PULSE_MS } from './feedback';
import { StatusDot } from './StatusDot';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = (file: string) => readFileSync(path.join(RENDERER, file), 'utf8');
const MOTION = css('motion.css');
const rootToken = (name: string) => {
  const sheet = css('styles.css');
  const start = sheet.indexOf(':root {');
  return declarations('styles.css', sheet.slice(start, sheet.indexOf('\n}\n', start))).find((d) => d.prop === name)
    ?.value;
};

describe('S47.4 counters', () => {
  it('gives every changing number tabular figures', () => {
    const start = MOTION.indexOf('/* ── S47.4');
    const rule = MOTION.slice(start, MOTION.indexOf('font-variant-numeric: tabular-nums', start));
    for (const selector of [
      '.status-button', // Problems counts in the strip
      '.status-cursor', // caret position
      '.problems-badge',
      '.problem-count',
      '.preview-console-errors', // console counts
      '.ai-jump-count', // pending messages
      '.ai-usage',
    ])
      expect(rule).toContain(selector);
  });
});

describe('S47.4 status dot', () => {
  it('is a 6 px dot that pulses its opacity over --dur-pulse (1.2 s), and only its opacity', () => {
    expect(MOTION).toMatch(/\.status-dot \{[^}]*width: 6px;\s+height: 6px;\s+border-radius: 50%;/);
    expect(MOTION).toMatch(/\.status-dot\[data-pulse\] \{\s+animation: status-pulse var\(--dur-pulse\) /);
    expect(MOTION).toMatch(/@keyframes status-pulse \{\s+50% \{\s+opacity: 0\.35;\s+\}\s+\}/);
    expect(rootToken('--dur-pulse')).toBe(`${PULSE_MS}ms`);
    // The preview's dot settles after three breaths; only the short-lived thinking dot loops.
    expect(MOTION).toMatch(/\.state-pill > \.status-dot\[data-pulse\] \{\s+animation-iteration-count: 3;/);
    expect(PULSE_MS).toBe(1200);
  });

  it('is static under reduced motion', () => {
    const glass = css('glass.css');
    const gate = glass.slice(glass.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(gate).toMatch(/--dur-pulse: 0ms;/);
    expect(gate).toMatch(/\.status-dot\[data-pulse\],\s+\.md-copy-done \{\s+animation: none;/);
  });

  it('is decorative and sits next to the word on the preview running state', () => {
    expect(renderToStaticMarkup(createElement(StatusDot, { pulse: true }))).toBe(
      '<span class="status-dot" data-pulse="true" aria-hidden="true"></span>',
    );
    expect(renderToStaticMarkup(createElement(StatusDot))).not.toContain('data-pulse');
    expect(renderToStaticMarkup(createElement(PreviewStateIcon, { state: 'running', warning: false }))).toContain(
      'class="status-dot" data-pulse="true"',
    );
    for (const state of ['starting', 'stopped', 'failed'])
      expect(renderToStaticMarkup(createElement(PreviewStateIcon, { state, warning: false }))).not.toContain(
        'status-dot',
      );
    expect(renderToStaticMarkup(createElement(PreviewStateIcon, { state: 'running', warning: true }))).not.toContain(
      'status-dot',
    );
  });

  it('sits next to the word on the chat thinking state, and leaves when the answer is complete', () => {
    const noop = () => undefined;
    const actions = new Proxy({}, { get: () => noop }) as ChatPanelActions;
    const turn = (status: ChatTurn['status']): ChatTurn => ({
      id: 't1',
      kind: 'chat',
      mode: 'chat',
      prompt: '你好',
      context: [],
      requestId: 'r1',
      status,
      stopping: false,
      parts: [],
    });
    const render = (status: ChatTurn['status']) =>
      renderToStaticMarkup(
        createElement(ChatPanelView, {
          state: {
            ...INITIAL_CHAT_STATE,
            open: true,
            availability: { kind: 'ready', provider: 'anthropic', consent: true },
            conversations: [{ id: 'c1', projectKey: 'p1', title: 'x', turns: [turn(status)] }],
            active: { p1: 'c1' },
          },
          projectId: 'p1',
          actions,
          consent: () => null,
          t: (key: MessageKey) => translate('zh-CN', key),
        }),
      );
    for (const status of ['sending', 'streaming'] as const) {
      const word = translate('zh-CN', `ai.chat.state.${status}`);
      expect(render(status)).toContain(
        `<p class="ai-turn-status" data-testid="ai-turn-status"><span class="status-dot" data-pulse="true" aria-hidden="true"></span>${word}</p>`,
      );
    }
    expect(render('done')).not.toContain('status-dot');
  });
});

describe('S47.4 Copied decays', () => {
  it('holds to 75 % and fades over --dur-decay (2.5 s) instead of switching', () => {
    expect(MOTION).toMatch(/@keyframes saved-check-decay \{\s+0%,\s+75% \{\s+opacity: 1;\s+\}\s+100% \{\s+opacity: 0;/);
    expect(MOTION).toMatch(/\.md-copy-done \{[^}]*animation: saved-check-decay var\(--dur-decay\) [^;]+ forwards;/);
    expect(rootToken('--dur-decay')).toBe(`${COPIED_MS}ms`);
    expect(COPIED_MS).toBe(2500);
  });

  it('renders the copy button with its idle label until something is copied', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        source: '```js\nlet a = 1;\n```',
        labels: { copy: '复制', copied: '已复制', copyFailed: '失败', codeCaption: () => 'js' },
      }),
    );
    expect(html).toMatch(/data-testid="md-copy"[^>]*>复制<\/button>/);
    expect(html).not.toContain('md-copy-done');
  });
});
