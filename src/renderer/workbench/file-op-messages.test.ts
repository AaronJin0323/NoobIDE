import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/index';
import { fill, nameProblemMessage, opErrorMessage } from './file-op-messages';

const zh = (key: MessageKey) => translate('zh-CN', key);
const en = (key: MessageKey) => translate('en', key);

describe('file operation explanations (S08.2, S08.4)', () => {
  it('fills placeholders', () => {
    expect(fill('移到{trash}：{name}', { trash: '回收站', name: 'a.html' })).toBe('移到回收站：a.html');
    expect(fill('{unknown}', {})).toBe('{unknown}');
  });

  it('explains every invalid-name problem, in both languages', () => {
    for (const t of [zh, en]) {
      for (const name of ['', '..', 'a\tb', 'CON', 'page.', '.env', 'x'.repeat(256)]) {
        expect(nameProblemMessage(t, name)).toBeTruthy();
      }
      expect(nameProblemMessage(t, 'index.html')).toBeNull();
    }
    expect(nameProblemMessage(zh, 'a?b*.html')).toContain('? *');
    expect(nameProblemMessage(zh, 'CON.html')).toContain('Windows');
    expect(nameProblemMessage(en, 'page ')).toContain('Windows');
  });

  it('names the existing file when refusing to overwrite or a case conflict', () => {
    expect(opErrorMessage(zh, 'exists', 'index.html', 'index.html')).toContain('“index.html”');
    expect(opErrorMessage(zh, 'exists', 'index.html', 'index.html')).toContain('不会覆盖');
    expect(opErrorMessage(en, 'case-conflict', 'Index.html', 'index.html')).toContain('"Index.html"');
  });

  it('names the temporary name when a case-only rename was interrupted', () => {
    expect(opErrorMessage(zh, 'interrupted', 'NoobIDE-renaming-1a2b3c4d-Index.html', 'Index.html')).toContain(
      '“NoobIDE-renaming-1a2b3c4d-Index.html”',
    );
  });

  it('has a message for every refusal code', () => {
    const codes = [
      'unknown-project',
      'outside-project',
      'not-found',
      'invalid-name',
      'exists',
      'case-conflict',
      'into-itself',
      'permission-denied',
      'busy',
      'trash-failed',
      'interrupted',
      'op-failed',
      'invalid-request',
      'forbidden-sender',
    ] as const;
    for (const code of codes) expect(opErrorMessage(en, code, '', 'CON').length).toBeGreaterThan(5);
  });
});
