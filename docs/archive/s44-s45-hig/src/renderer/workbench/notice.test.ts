import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate, LOCALES, type MessageKey } from '../i18n/index';
import { Notice, NoticeDetail } from './Notice';
import { HEADER_FITS, pickHeaderFit, stripFits, type HeaderFit } from './header-fit';

/** S45.2: every file notice is a one-line title plus at most one sentence. */
const TITLES: MessageKey[] = [
  'notice.conflict.title',
  'notice.deleted.title',
  'notice.reloaded.title',
  'notice.session.title',
  'notice.transfer.title',
  'notice.entry.title',
  'entry.failed',
  'settings.corrupt',
  'settings.newer',
];
const SENTENCES: MessageKey[] = [
  'notice.conflict.body',
  'conflict.loading',
  'notice.deleted.body',
  'notice.deleted.confirmBody',
  'deleted.resaveFailed',
  'notice.reloaded.body',
  'notice.transfer.body',
  'notice.entry.body',
  'entry.invalidExisting',
  'notice.save.body',
  'settings.reset',
  'notice.settings.newerBody',
];
/** Sentence ends: CJK full stops anywhere, Latin ones before a space or the end (so ".noobide" is not one). */
const sentences = (text: string) => (text.match(/[。！？]|[.!?](?=\s|$)/g) ?? []).length || 1;

describe('notice copy (S45.2)', () => {
  for (const locale of LOCALES) {
    it(`titles are short and bodies are one sentence (${locale})`, () => {
      for (const key of TITLES) {
        const text = translate(locale, key);
        expect(sentences(text), key).toBe(1);
        expect(text.length, key).toBeLessThanOrEqual(locale === 'en' ? 60 : 30);
      }
      for (const key of SENTENCES) expect(sentences(translate(locale, key)), key).toBe(1);
    });
  }
});

const button = (label: string, className: string) => createElement('button', { type: 'button', className }, label);

describe('Notice anatomy (S45.2)', () => {
  const html = renderToStaticMarkup(
    createElement(
      Notice,
      {
        tone: 'warning',
        role: 'alert',
        testId: 'conflict-banner',
        title: '“a.css” changed',
        titleHint: 'styles/a.css',
        body: 'One sentence.',
        actions: [button('Secondary', 'secondary-button'), button('Primary', 'primary-button')],
      },
      createElement(NoticeDetail, { summary: 'Details', text: 'EACCES' }),
    ),
  );

  it('renders icon, title, sentence, extras, then the actions — in that order', () => {
    const order = ['notice-icon', 'notice-title', 'notice-body', 'notice-detail', 'notice-actions'].map((c) =>
      html.indexOf(`class="${c}"`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="conflict-banner"');
    expect(html).toContain('title="styles/a.css"');
  });

  it('puts the primary action last and the icon out of the accessibility tree', () => {
    const actions = html.slice(html.indexOf('class="notice-actions"'));
    expect(actions.lastIndexOf('primary-button')).toBeGreaterThan(actions.lastIndexOf('secondary-button'));
    expect(html).toMatch(/<span class="notice-icon"><svg[^>]*aria-hidden="true"/);
    expect(html).toContain('<details class="notice-detail"><summary>Details</summary>');
  });

  it('marks the tone in a data attribute and with a distinct icon shape, not colour alone', () => {
    const icon = (tone: 'info' | 'success' | 'warning') =>
      renderToStaticMarkup(createElement(Notice, { tone, role: 'status', testId: 'n', title: 't' })).replace(
        /^.*?<svg/,
        '<svg',
      );
    expect(new Set([icon('info'), icon('success'), icon('warning')]).size).toBe(3);
  });

  it('floats only app-level notices', () => {
    const floating = renderToStaticMarkup(
      createElement(Notice, { tone: 'info', role: 'status', testId: 'n', title: 't', floating: true }),
    );
    expect(floating).toContain('class="notice notice-info app-notice"');
    expect(html).not.toContain('app-notice');
  });
});

describe('editor header fit (S45.2)', () => {
  it('drops the action labels first, then the role tag, until the tabs fit', () => {
    const run = (fitsAt: HeaderFit | null) => {
      const applied: HeaderFit[] = [];
      const chosen = pickHeaderFit(
        (fit) => applied.push(fit),
        () => fitsAt !== null && HEADER_FITS.indexOf(applied.at(-1)!) >= HEADER_FITS.indexOf(fitsAt),
      );
      return { chosen, applied };
    };
    expect(run('full')).toEqual({ chosen: 'full', applied: ['full'] });
    expect(run('icons')).toEqual({ chosen: 'icons', applied: ['full', 'icons'] });
    expect(run('tight')).toEqual({ chosen: 'tight', applied: ['full', 'icons', 'tight'] });
    // Even the tightest level overflows: the strip scrolls, the header stays at the tightest level.
    expect(run(null).chosen).toBe('tight');
  });

  it('treats a strip as fitting when nothing is hidden (1 px of rounding allowed)', () => {
    expect(stripFits({ scrollWidth: 300, clientWidth: 300 })).toBe(true);
    expect(stripFits({ scrollWidth: 301, clientWidth: 300 })).toBe(true);
    expect(stripFits({ scrollWidth: 320, clientWidth: 300 })).toBe(false);
  });
});
