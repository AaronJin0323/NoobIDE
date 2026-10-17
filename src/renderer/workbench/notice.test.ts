/**
 * S50.2: the one Notice anatomy (tone icon, one-line title, at most one sentence, details behind a disclosure,
 * trailing actions with at most one primary), its tones (only a failure has the danger fill) and the app notices
 * built on it, rendered to static markup in both locales. No notice has a timer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { LOCALES, translate, type Locale, type MessageKey } from '../i18n/index';
import { JournalHealthNotice } from '../recovery/RecoveryDialog';
import { EntryNotice } from './EntryNotice';
import { Notice, type NoticeTone } from './Notice';
import { SettingsNotice } from './SettingsNotice';
import { TransferNoticeView } from './TransferNotice';

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.dirname(here);

/** Renders inside the i18n provider in `locale` (the provider reads the locale from sessionStorage first). */
function renderIn(locale: Locale, element: ReactElement): string {
  vi.stubGlobal('window', { sessionStorage: { getItem: () => locale, setItem: () => undefined } });
  return renderToStaticMarkup(h(I18nProvider, null, element));
}
afterEach(() => vi.unstubAllGlobals());

const at = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
};

describe('Notice anatomy', () => {
  const html = renderToStaticMarkup(
    h(Notice, {
      tone: 'warning',
      role: 'alert',
      testId: 'n',
      title: 'A title',
      body: 'One sentence.',
      details: h('span', null, 'EACCES'),
      detailsLabel: 'Details',
      actions: [
        h('button', { key: 's', className: 'secondary-button' }, 'Later'),
        h('button', { key: 'p', className: 'primary-button' }, 'Fix'),
      ],
    }),
  );

  it('orders icon, title, sentence, details, then the trailing actions', () => {
    const order = ['notice-icon', 'notice-title', 'notice-body', 'notice-detail', 'notice-actions'].map((c) =>
      at(html, `class="${c}`),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/^<div class="notice notice-warning" role="alert" data-testid="n" data-tone="warning">/);
    expect(html).toContain('<p class="notice-title" title="A title">A title</p>');
  });

  it('puts the details behind a closed disclosure and the icon out of the accessibility tree', () => {
    expect(html).toContain('<details class="notice-detail"><summary>Details</summary>');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toMatch(/<span class="notice-icon"><svg[^>]*aria-hidden="true"/);
  });

  it('puts the one primary last', () => {
    const actions = html.slice(at(html, 'class="notice-actions"'));
    expect(actions.match(/primary-button/g)).toHaveLength(1);
    expect(actions.indexOf('primary-button')).toBeGreaterThan(actions.indexOf('secondary-button'));
  });

  it('draws each tone with its own icon shape, not colour alone', () => {
    const icon = (tone: NoticeTone) =>
      renderToStaticMarkup(h(Notice, { tone, role: 'status', testId: 'n', title: 't' })).replace(/^.*?<svg/, '<svg');
    expect(new Set((['info', 'success', 'warning', 'danger'] as const).map(icon)).size).toBe(4);
  });

  it('only the danger tone has the danger fill in the stylesheet', () => {
    const css = readFileSync(path.join(renderer, 'styles.css'), 'utf8');
    const block = (selector: string) => new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)?.[1];
    expect(block('.notice-danger')).toContain('background: var(--danger-soft)');
    for (const tone of ['notice', 'notice-success', 'notice-warning']) {
      expect(block(`.${tone}`), tone).not.toContain('danger');
    }
  });
});

describe('app notices on the shared Notice, in both locales', () => {
  for (const locale of LOCALES) {
    it(`the entry-page confirmation is a success, not a danger fill (${locale})`, () => {
      const html = renderIn(
        locale,
        h(EntryNotice, { state: { relPath: '页面/首页.html', error: null }, onDismiss() {} }),
      );
      expect(html).toContain('class="notice notice-success" role="status" data-testid="entry-notice"');
      expect(html).toContain('data-state="set"');
      expect(html).toContain('页面/首页.html');
      expect(html).not.toContain('danger');
      expect(html).not.toContain('save-alert');
      expect(html).toContain(`<summary>${translate(locale, 'notice.details')}</summary>`);
    });

    it(`the transfer report is a warning-tone status with its issues behind the disclosure (${locale})`, () => {
      const html = renderIn(
        locale,
        h(TransferNoticeView, { view: { lines: ['“我的 页面.html”'], more: 2, truncated: false }, onDismiss() {} }),
      );
      expect(html).toContain('class="notice notice-warning" role="status" data-testid="transfer-notice"');
      expect(html).not.toContain('danger');
      expect(html).not.toContain('save-alert');
      expect(html.indexOf('data-testid="transfer-issue"')).toBeGreaterThan(at(html, '<details'));
      expect(html).toContain(`<summary>${translate(locale, 'notice.transfer.details').replace('{n}', '3')}</summary>`);
    });

    it(`an entry-page failure is a danger alert (${locale})`, () => {
      const html = renderIn(
        locale,
        h(EntryNotice, { state: { relPath: 'a.html', error: 'invalid-existing' }, onDismiss() {} }),
      );
      expect(html).toContain('class="notice notice-danger" role="alert" data-testid="entry-notice"');
      expect(html).toContain(translate(locale, 'notice.entry.invalidTitle'));
    });

    it(`the settings notice keeps the backup path behind the disclosure (${locale})`, () => {
      const html = renderIn(
        locale,
        h(SettingsNotice, {
          snapshot: { notice: 'corrupt', backupPath: 'C:/数据/settings.corrupt-1.json' } as never,
          onDismiss() {},
        }),
      );
      expect(html).toContain('class="notice notice-warning" role="alert" data-testid="settings-notice"');
      expect(html.indexOf('settings.corrupt-1.json')).toBeGreaterThan(at(html, '<details'));
      expect(html).toContain(translate(locale, 'notice.settings.corruptTitle'));
    });

    it(`the journal-health notice is a danger alert with a title and one sentence (${locale})`, () => {
      const html = renderIn(locale, h(JournalHealthNotice, { health: 'EACCES' }));
      expect(html).toContain('class="notice notice-danger recovery-health" role="alert" data-testid="journal-health"');
      expect(html).toContain(translate(locale, 'notice.journal.body'));
    });
  }
});

describe('notice copy and rules', () => {
  /** Sentence ends: CJK full stops anywhere, Latin ones before a space or the end (so ".noobide" is not one). */
  const sentences = (text: string) => (text.match(/[。！？]|[.!?](?=\s|$)/g) ?? []).length || 1;
  const TITLES: MessageKey[] = [
    'notice.entry.title',
    'notice.entry.failedTitle',
    'notice.entry.invalidTitle',
    'notice.transfer.title',
    'notice.settings.corruptTitle',
    'notice.settings.newerTitle',
    'notice.journal.title',
  ];
  const BODIES: MessageKey[] = [
    'notice.entry.body',
    'notice.entry.invalidBody',
    'notice.transfer.body',
    'notice.settings.newerBody',
    'settings.reset',
    'notice.journal.body',
  ];
  for (const locale of LOCALES) {
    it(`titles are one short line and bodies one sentence (${locale})`, () => {
      for (const key of TITLES) {
        const text = translate(locale, key);
        expect(sentences(text), key).toBe(1);
        expect(text.length, key).toBeLessThanOrEqual(locale === 'en' ? 60 : 30);
        expect(text, key).not.toMatch(/[。.]$/);
      }
      for (const key of BODIES) expect(sentences(translate(locale, key)), key).toBe(1);
    });
  }

  it('the app notices use <Notice> and no notice runs a timer', () => {
    for (const file of [
      'workbench/EntryNotice.tsx',
      'workbench/TransferNotice.tsx',
      'workbench/SettingsNotice.tsx',
      'recovery/RecoveryDialog.tsx',
    ]) {
      const source = readFileSync(path.join(renderer, file), 'utf8');
      expect(source, file).toMatch(/<Notice(View)?\b/);
      expect(source, file).not.toMatch(/useAutoDismiss|setTimeout|setInterval/);
      expect(source, file).not.toContain('save-alert app-notice');
    }
    expect(readFileSync(path.join(here, 'Notice.tsx'), 'utf8')).not.toMatch(/setTimeout|setInterval/);
  });
});
