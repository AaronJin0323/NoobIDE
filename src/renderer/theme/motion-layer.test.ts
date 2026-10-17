import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/index';
import { ChatPanelView, type ChatPanelActions } from '../ai/ChatPanel';
import { INITIAL_CHAT_STATE, draftOf, type ChatState, type ChatTurn } from '../ai/chat-model';
import { groupAnswer } from '../ai/StepsFold';
import { declarations } from '../design-rules.test';
import { Collapsible, isShown } from './Collapsible';
import { EXIT_SLOTS, GHOST_MAX_MS, exitSlotFor, ghostLifetimeMs, type Matchable } from './exit-motion';
import { STAGGER_CAP, staggerIndex, staggerStyle } from './stagger';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = (file: string) => readFileSync(path.join(RENDERER, file), 'utf8');
const MOTION = css('motion.css');

/** A stand-in element: matches the selectors it is told to. */
const el = (...selectors: string[]): Matchable => ({
  nodeType: 1,
  matches: (s) => s === '*' || selectors.includes(s),
});

describe('S47.2 exit motion', () => {
  it('gives a removed band, chat panel or notice its exit', () => {
    expect(exitSlotFor(el('.workbench'), el('.walkthrough'), [])).toEqual(EXIT_SLOTS[0]);
    expect(exitSlotFor(el('.workbench-middle'), el('.ai-chat'), [])).toEqual(EXIT_SLOTS[1]);
    expect(exitSlotFor(el('.app-notice-stack'), el('.app-notice'), [el('.other')])?.parent).toBe('.app-notice-stack');
  });

  it('does not copy other elements, ghosts, text nodes or a band that was swapped for another', () => {
    expect(exitSlotFor(el('.workbench'), el('.topbar'), [])).toBeNull();
    expect(exitSlotFor(el('.workbench-middle'), el('.preview'), [])).toBeNull();
    expect(exitSlotFor(el('.workbench'), el('.walkthrough', '[data-motion="exit"]'), [])).toBeNull();
    expect(exitSlotFor(el('.app-notice-stack'), { nodeType: 3, matches: () => true }, [])).toBeNull();
    // The compact walkthrough replaces the full one in one commit: the new band enters, the old one does not linger.
    expect(exitSlotFor(el('.workbench'), el('.walkthrough'), [el('.walkthrough')])).toBeNull();
  });

  it('removes a ghost when its animation is over, never later than the cap', () => {
    expect(ghostLifetimeMs('0.12s', '0s')).toBe(120);
    expect(ghostLifetimeMs('120ms, 200ms', '30ms')).toBe(230);
    expect(ghostLifetimeMs('0s', '0s')).toBe(0);
    expect(ghostLifetimeMs('40s', '0s')).toBe(GHOST_MAX_MS);
    expect(ghostLifetimeMs('', '')).toBe(0);
  });

  it('times enter and exit with the motion tokens only, compositor properties only', () => {
    const decls = declarations('motion.css', MOTION);
    for (const d of decls.filter((x) => /^(animation|transition)/.test(x.prop) && x.prop !== 'animation-name')) {
      if (d.prop === 'animation-timeline' || d.prop === 'animation-range') continue;
      expect(d.value, `${d.prop} at line ${d.line}`).toMatch(/var\(--(dur|ease)-|^none$|linear both/);
    }
    // Every enter / exit keyframe moves opacity and translate only (no scale, no size).
    for (const block of MOTION.match(/@keyframes motion-[a-z-]+ \{[\s\S]*?\n\}/g) ?? []) {
      const props = [...block.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      expect(new Set(props)).toEqual(new Set(['opacity', 'translate']));
    }
    for (const selector of [
      '.workbench > .walkthrough',
      '.app-notice-stack > *',
      '.problems-panel:not([hidden])',
      '.workbench .ai-chat',
      '.workbench.narrow .files:not([hidden])',
      ".workbench [data-motion='exit']",
      '.problems-panel[hidden]',
    ])
      expect(MOTION).toContain(selector);
    expect(MOTION).toMatch(/display var\(--dur-fast\) allow-discrete/);
  });

  it('is loaded before glass.css, whose reduced-motion gate zeroes the stagger step too', () => {
    const main = css('main.tsx');
    expect(main.indexOf("'./motion.css'")).toBeGreaterThan(main.indexOf("'./styles.css'"));
    expect(main.indexOf("'./motion.css'")).toBeLessThan(main.indexOf("'./glass.css'"));
    expect(css('glass.css')).toMatch(/prefers-reduced-motion: reduce\) \{\s+:root \{[^}]*--dur-stagger: 0ms;/);
    expect(css('styles.css')).toMatch(/--dur-stagger: 30ms;/);
  });
});

describe('S47.2 collapsible groups', () => {
  it('folds with grid-template-rows 0fr / 1fr', () => {
    expect(MOTION).toMatch(/\.collapsible \{\s+display: grid;\s+grid-template-rows: 1fr;/);
    expect(MOTION).toMatch(/\.collapsible\[data-open='false'\] \{\s+grid-template-rows: 0fr;\s+visibility: hidden;/);
  });

  it('is inert and hidden from assistive technology while closed, and held open while asked', () => {
    const closed = renderToStaticMarkup(createElement(Collapsible, { open: false, id: 'x', children: 'body' }));
    expect(closed).toContain('data-open="false"');
    expect(closed).toContain('inert=""');
    expect(closed).toContain('aria-hidden="true"');
    const open = renderToStaticMarkup(createElement(Collapsible, { open: true, children: 'body' }));
    expect(open).toContain('data-open="true"');
    expect(open).not.toContain('inert');
    const held = renderToStaticMarkup(createElement(Collapsible, { open: false, held: true, children: 'body' }));
    expect(held).toContain('data-open="true"');
    expect(isShown(false, true)).toBe(true);
    expect(isShown(false, false)).toBe(false);
  });
});

describe('S47.2 steps fold and chip stagger in the chat', () => {
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
  const render = (state: Partial<ChatState>) =>
    renderToStaticMarkup(
      createElement(ChatPanelView, {
        state: {
          ...INITIAL_CHAT_STATE,
          open: true,
          availability: { kind: 'ready', provider: 'anthropic', consent: true },
          ...state,
        },
        projectId: 'p1',
        actions,
        consent: () => null,
        t: (key: MessageKey) => translate('zh-CN', key),
      }),
    );
  const turn = (status: ChatTurn['status']): ChatTurn => ({
    id: 't1',
    kind: 'agent',
    mode: 'chat',
    prompt: '改一下标题',
    context: [],
    requestId: 'r1',
    status,
    stopping: false,
    parts: [
      { kind: 'text', text: '我先看看文件。' },
      { kind: 'step', tool: 'read', summary: '读取 index.html' },
      { kind: 'step', tool: 'read', summary: '读取 style.css' },
      { kind: 'text', text: '好了。' },
    ],
  });
  const withTurn = (t: ChatTurn): Partial<ChatState> => ({
    conversations: [{ id: 'c1', projectKey: 'p1', title: 'x', turns: [t] }],
    active: { p1: 'c1' },
  });

  it('groups consecutive steps and keeps every other part in place', () => {
    const items = groupAnswer(turn('done').parts);
    expect(items.map((i) => i.kind)).toEqual(['part', 'steps', 'part']);
    expect(items[1]).toMatchObject({ kind: 'steps', start: 1 });
    expect(items[1]?.kind === 'steps' && items[1].steps).toHaveLength(2);
    expect(items[2]).toMatchObject({ kind: 'part', index: 3 });
  });

  it('holds the fold open while the answer streams, and lets it fold once complete', () => {
    const live = render(withTurn(turn('streaming')));
    expect(live.match(/data-testid="ai-steps"/g)).toHaveLength(1);
    expect(live.match(/data-testid="ai-step"/g)).toHaveLength(2);
    expect(live).toMatch(/data-testid="ai-steps" data-held="true"/);
    expect(live).toMatch(/aria-expanded="true" [^>]*aria-disabled="true"/);
    expect(live).toContain(translate('zh-CN', 'ai.chat.stepsHeld'));
    const done = render(withTurn(turn('done')));
    expect(done).not.toContain('data-held');
    expect(done).not.toContain('aria-disabled');
    expect(done).toMatch(/data-testid="ai-steps-fold"[^>]*>|data-open="true"/);
  });

  it('staggers chips 30 ms apart, capped at 8', () => {
    expect([0, 1, 7, 8, 30, -2].map(staggerIndex)).toEqual([0, 1, 7, 7, 7, 0]);
    expect(STAGGER_CAP).toBe(8);
    expect(staggerStyle(3)).toEqual({ '--stagger': 3 });
    expect(MOTION).toMatch(/animation-delay: calc\(var\(--stagger, 0\) \* var\(--dur-stagger\)\)/);
    const chips = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      item: { kind: 'file' as const, relPath: `f${i}.html` },
    }));
    const html = render({ drafts: { p1: { ...draftOf(INITIAL_CHAT_STATE, 'p1'), chips } } } as never);
    const steps = [...html.matchAll(/--stagger:(\d+)/g)].map((m) => Number(m[1]));
    expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 7, 7]);
  });
});
