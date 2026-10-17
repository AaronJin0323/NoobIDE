import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AiFileChange } from '../../shared/ipc/ai-contract';
import { I18nValueProvider } from '../i18n/I18nProvider';
import { translate, type Locale } from '../i18n/index';
import { ProposalReview, type ReviewView } from './ProposalReview';
import { changedLines, primaryIndex, PROPOSAL_STATES, toneOf } from './proposal-tone';

const EDIT: AiFileChange = {
  kind: 'edit',
  relPath: 'style.css',
  before: 'h1 {\n  color: red;\n}\n',
  after: 'h1 {\n  color: blue;\n  margin: 0;\n}\n',
};
const CREATE: AiFileChange = { kind: 'create', relPath: 'about.html', after: '<p>hi</p>\n' };
const DELETE: AiFileChange = { kind: 'delete', relPath: 'old.js' };

function review(locale: Locale, views: readonly ReviewView[], changes: readonly AiFileChange[]) {
  return renderToStaticMarkup(
    createElement(
      I18nValueProvider,
      { value: { locale, t: (key) => translate(locale, key), setLocale: () => undefined } },
      createElement(ProposalReview, {
        proposalId: 'p',
        changes,
        reason: 'r',
        views,
        busy: false,
        onAccept: () => undefined,
        onReject: () => undefined,
        onAcceptAll: () => undefined,
        onRejectAll: () => undefined,
      }),
    ),
  );
}

/** The `<li>` of each change, in order. */
const items = (html: string) => html.match(/<li class="agent-change"[\s\S]*?<\/li>/g) ?? [];
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('proposal tones (S48.8)', () => {
  it('maps every state to its own tone and icon shape', () => {
    const tones = PROPOSAL_STATES.map((state) => toneOf(state).tone);
    const icons = PROPOSAL_STATES.map((state) => toneOf(state).icon);
    expect(new Set(tones).size).toBe(PROPOSAL_STATES.length);
    expect(new Set(icons).size).toBe(PROPOSAL_STATES.length);
    expect(toneOf('pending').tone).toBe('attention');
    expect(toneOf('applying').tone).toBe('running');
    expect(toneOf('applied').tone).toBe('ok');
    expect(toneOf('failed').tone).toBe('danger');
    expect(toneOf('rejected').tone).toBe('muted');
  });

  it('picks the one primary action', () => {
    expect(primaryIndex([{ state: 'applied' }, { state: 'pending' }])).toBe(1);
    expect(primaryIndex([{ state: 'pending' }, { state: 'pending' }])).toBe('all');
    expect(primaryIndex([{ state: 'rejected' }, { state: 'expired' }])).toBeNull();
  });

  it('finds the changed lines of an edit', () => {
    expect(changedLines(EDIT.kind === 'edit' ? EDIT.before : '', EDIT.after)).toEqual({ from: 2, to: 3 });
    expect(changedLines('a\nb\nc', 'a\nc')).toEqual({ from: 2, to: 2 });
    expect(changedLines('a', 'a')).toBeNull();
    expect(changedLines('', 'x\ny')).toEqual({ from: 1, to: 2 });
  });

  for (const locale of ['zh-CN', 'en'] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

    it(`${locale}: each state shows its tone with an icon and a word`, () => {
      const views: ReviewView[] = PROPOSAL_STATES.map((state) =>
        state === 'failed' ? { state, failure: { code: 'not-found' } } : { state },
      );
      const html = review(
        locale,
        views,
        PROPOSAL_STATES.map(() => EDIT),
      );
      const lis = items(html);
      expect(lis).toHaveLength(PROPOSAL_STATES.length);
      PROPOSAL_STATES.forEach((state, i) => {
        const li = lis[i] ?? '';
        const { tone } = toneOf(state);
        expect(li).toContain(`data-state="${state}" data-tone="${tone}"`);
        const badge = /<span class="agent-change-state"[^>]*>([\s\S]*?)<\/span>/.exec(li)?.[0] ?? '';
        expect(badge).toContain(`data-tone="${tone}"`);
        expect(badge).toContain('<svg'); // the icon
        const word =
          state === 'failed'
            ? t('agent.state.failed').replace('{reason}', t('agent.failure.not-found'))
            : t(`agent.state.${state}`);
        expect(li).toContain(word);
      });
    });

    it(`${locale}: only pending changes have the decision buttons, and the card has one primary action`, () => {
      const one = review(
        locale,
        [{ state: 'applied' }, { state: 'pending' }, { state: 'rejected' }],
        [EDIT, CREATE, DELETE],
      );
      expect(count(one, 'class="primary-button"')).toBe(1);
      const [applied, pending, rejected] = items(one);
      expect(pending).toContain('class="primary-button" data-testid="agent-accept"');
      expect(pending).toContain(`>${t('agent.change.accept')}</button>`);
      expect(applied).not.toContain('agent-accept');
      expect(rejected).not.toContain('agent-accept');
      expect(one).not.toContain('agent-accept-all');

      const many = review(locale, [{ state: 'pending' }, { state: 'pending' }], [EDIT, CREATE]);
      expect(count(many, 'class="primary-button"')).toBe(1);
      expect(many).toContain('class="primary-button" data-testid="agent-accept-all"');
      expect(count(many, 'class="secondary-button" data-testid="agent-accept"')).toBe(2);

      const none = review(locale, [{ state: 'expired' }, { state: 'applying' }], [EDIT, CREATE]);
      expect(count(none, 'primary-button')).toBe(0);
    });

    it(`${locale}: the structured input and the result are closed disclosures`, () => {
      const html = review(
        locale,
        [{ state: 'applied' }, { state: 'pending' }, { state: 'rejected' }],
        [EDIT, CREATE, DELETE],
      );
      expect(count(html, '<details data-testid="agent-change-input">')).toBe(3);
      expect(count(html, '<details data-testid="agent-change-result">')).toBe(3);
      expect(html).not.toMatch(/<details[^>]* open/);
      const [edit, create, del] = items(html);
      expect(edit).toContain(`<summary>${t('agent.details.input')}</summary>`);
      expect(edit).toContain('<dd class="agent-change-path">style.css</dd>');
      expect(edit).toContain(t('agent.details.lines').replace('{from}', '2').replace('{to}', '3'));
      expect(edit).toContain(`<summary>${t('agent.details.result')}</summary>`);
      expect(edit).toContain(t('agent.result.applied'));
      expect(edit).toContain('data-testid="agent-diff-summary"');
      expect(create).toContain(t('agent.result.pending'));
      expect(del).toContain(t('agent.details.wholeFile'));
      expect(del).toContain(t('agent.result.rejected'));
      expect(del).not.toContain('agent-diff-summary');
    });
  }

  it('only the attention tone draws the prominent border; tones use the soft fills and theme tokens', () => {
    const css = readFileSync(new URL('./agent.css', import.meta.url), 'utf8');
    const borders = css.match(/\.agent-change\[data-tone='[a-z]+'\] \{[^}]*border-color[^}]*\}/g) ?? [];
    expect(borders).toHaveLength(1);
    expect(borders[0]).toContain("[data-tone='attention']");
    expect(css).toMatch(/\[data-tone='ok'\] \{\s*background: var\(--ok-soft\);\s*color: var\(--ok\);/);
    expect(css).toMatch(/\[data-tone='danger'\] \{\s*background: var\(--danger-soft\);\s*color: var\(--danger\);/);
    expect(css).toMatch(/\[data-tone='muted'\] \{\s*background: var\(--raised\);\s*color: var\(--muted\);/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
