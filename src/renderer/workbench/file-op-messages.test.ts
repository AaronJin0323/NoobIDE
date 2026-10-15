import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/index';
import { fill, nameProblemMessage, opErrorMessage, protectedFolderMessage, saveErrorKey } from './file-op-messages';
import { documentReducer, INITIAL_DOCUMENT_STATE } from './document-state';
import { createErrorMessage } from '../welcome/welcome-model';

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

describe('S25.3: OS privacy protection explained', () => {
  it('names the macOS setting and the Windows setting, in both languages', () => {
    expect(opErrorMessage(en, 'protected-folder', 'EPERM', 'a.html', 'mac')).toContain('Files and Folders');
    expect(opErrorMessage(zh, 'protected-folder', 'EPERM', 'a.html', 'mac')).toContain('文件和文件夹');
    expect(opErrorMessage(en, 'protected-folder', 'EPERM', 'a.html', 'windows')).toContain('Controlled folder access');
    expect(opErrorMessage(zh, 'protected-folder', 'EPERM', 'a.html', 'windows')).toContain('受控文件夹访问');
    expect(protectedFolderMessage(en, 'other')).toContain('privacy');
    // Never the plain "read-only" text: the fix is in the OS settings, not in the file.
    expect(opErrorMessage(en, 'protected-folder', 'EPERM', 'a.html', 'mac')).not.toBe(en('op.permission'));
  });

  it('a save blocked by the OS protection gets the platform explanation, not "read-only"', () => {
    expect(saveErrorKey('protected-folder', 'mac')).toBe('protected.mac');
    expect(saveErrorKey('protected-folder', 'windows')).toBe('protected.windows');
    expect(saveErrorKey('permission-denied', 'mac')).toBe('save.error.permission');
  });

  it('project creation and opening explain it too', () => {
    expect(createErrorMessage(en, 'protected-folder', 'EPERM', 'a', 'windows')).toBe(en('protected.windows'));
    expect(createErrorMessage(zh, 'protected-folder', 'EPERM', 'a', 'mac')).toBe(zh('protected.mac'));
    const failed = documentReducer(INITIAL_DOCUMENT_STATE, { type: 'projectOpenFailed', code: 'protected-folder' });
    expect(failed.openFailed).toBe('protected-folder');
    expect(documentReducer(INITIAL_DOCUMENT_STATE, { type: 'projectOpenFailed' }).openFailed).toBe(true);
  });
});
