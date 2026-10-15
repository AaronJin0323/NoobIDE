import { describe, expect, it } from 'vitest';
import { LOCALES, translate } from '../i18n/index';
import type { PortabilityIssue } from '../../shared/portability';
import { MAX_SHOWN_ISSUES, transferIssueText, transferNoticeView } from './transfer-notice';

const ISSUES: PortabilityIssue[] = [
  { kind: 'unportable-name', relPath: 'a/what?.html', problems: ['invalid-char'], invalidChars: ['?'] },
  { kind: 'case-conflict', folder: '', names: ['Logo.svg', 'logo.svg'] },
  { kind: 'unicode-conflict', folder: '页面', names: ['café.html', 'café.html'] },
  { kind: 'decomposed-name', relPath: '页面/café.html' },
  { kind: 'mixed-eol', relPath: 'crlf-mixed.js' },
];

describe('transfer notice text (S13.5)', () => {
  it.each(LOCALES)('every issue kind has a filled-in message in %s naming the file as it is', (locale) => {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    for (const issue of ISSUES) {
      const text = transferIssueText(t, issue);
      expect(text).not.toMatch(/\{\w+\}/);
      const names = 'names' in issue ? issue.names : [issue.relPath];
      for (const name of names) expect(text).toContain(name);
    }
    expect(transferIssueText(t, ISSUES[0]!)).toContain('?');
    expect(transferIssueText(t, ISSUES[1]!)).toContain(translate(locale, 'transfer.rootFolder'));
  });

  it('shows nothing when there are no issues, and lists at most a few', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('en', key);
    expect(transferNoticeView(t, { issues: [], truncated: false })).toBeNull();
    const many = Array.from({ length: MAX_SHOWN_ISSUES + 3 }, (_, i) => ({
      kind: 'mixed-eol' as const,
      relPath: `f${i}.js`,
    }));
    const view = transferNoticeView(t, { issues: many, truncated: true });
    expect(view?.lines).toHaveLength(MAX_SHOWN_ISSUES);
    expect(view?.more).toBe(3);
    expect(view?.truncated).toBe(true);
  });
});
