import { describe, expect, it } from 'vitest';
import { translate, type MessageKey } from '../i18n/index';
import {
  compareVersion,
  groupUndoText,
  historyErrorKey,
  reasonKey,
  restoreOutcomeKey,
  sortHistoryFiles,
  storageText,
} from './history-model';

const zh = (key: MessageKey) => translate('zh-CN', key);
const en = (key: MessageKey, count?: number) => translate('en', key, count);

describe('local history view model (S21.3, S21.4)', () => {
  it('compares a version with the current content: + lines come back, − lines would be replaced', () => {
    const result = compareVersion('<h1>小雨</h1>\n<p>new</p>\n', '<h1>你好</h1>\n<p>new</p>\n');
    expect(result.mode).toBe('diff');
    if (result.mode !== 'diff') return;
    expect(result.diff).toMatchObject({ identical: false, added: 1, removed: 1 });
    expect(result.diff.lines.filter((l) => l.kind === 'added').map((l) => 'text' in l && l.text)).toEqual([
      '<h1>你好</h1>',
    ]);
    expect(compareVersion('same', 'same')).toMatchObject({ mode: 'diff', diff: { identical: true } });
  });

  it('a deleted file shows the whole version instead of a diff', () => {
    expect(compareVersion(null, 'body {}')).toEqual({ mode: 'deleted', text: 'body {}' });
  });

  it('names every snapshot reason in both languages', () => {
    for (const reason of ['before-save', 'after-save', 'before-format', 'before-delete', 'before-restore'] as const) {
      expect(zh(reasonKey(reason)).trim()).not.toBe('');
      expect(en(reasonKey(reason)).trim()).not.toBe('');
    }
    expect(zh(reasonKey('before-restore'))).toBe('恢复前');
  });

  it('explains every restore outcome and history error', () => {
    for (const outcome of ['restored', 'save-failed', 'read-only', 'failed'] as const) {
      expect(zh(restoreOutcomeKey(outcome))).not.toBe('');
    }
    expect(zh(restoreOutcomeKey('restored'))).toContain('已经保存为一个版本');
    expect(en(restoreOutcomeKey('save-failed'))).toContain('still in the editor');
    for (const code of [
      'unknown-project',
      'unavailable',
      'not-found',
      'corrupt',
      'not-text',
      'exists',
      'outside-project',
      'permission-denied',
      'disk-full',
      'restore-failed',
      'clear-failed',
      'invalid-request',
      'forbidden-sender',
    ] as const) {
      expect(en(historyErrorKey(code)).trim(), code).not.toBe('');
    }
    expect(zh(historyErrorKey('exists'))).toContain('不会覆盖');
  });

  it('describes storage use against the limit and the cleanup policy', () => {
    const usage = {
      totalBytes: 3 * 1024 * 1024,
      onDiskBytes: 4 * 1024 * 1024,
      versions: 12,
      quarantined: 0,
      unavailable: 0,
      maxTotalBytes: 256 * 1024 * 1024,
      maxVersionsPerFile: 50,
      maxBytesPerFile: 32 * 1024 * 1024,
    };
    expect(storageText(zh, usage)).toEqual({
      usage: '历史占用 3.0 MB（上限 256.0 MB）',
      policy: '每个文件最多保留 50 个版本、32.0 MB；超过上限时最旧的版本会被自动清理，每个文件的最新版本始终保留。',
    });
    expect(storageText(en, usage).usage).toBe('History uses 3.0 MB (limit 256.0 MB)');
  });

  it('lists existing files first, then deleted ones', () => {
    expect(
      sortHistoryFiles([
        { relPath: 'b.css', exists: false },
        { relPath: 'index.html', exists: true },
        { relPath: 'a.js', exists: true },
      ]).map((f) => f.relPath),
    ).toEqual(['a.js', 'index.html', 'b.css']);
  });

  it('describes an undone AI turn: all undone, per-file reasons, or the turn not found (S34.2)', () => {
    expect(groupUndoText(zh, { undone: 3, failed: [] })).toEqual({
      ok: true,
      text: '已撤销这一轮的修改（3 处）。撤销前的内容也保存为版本了，可以再恢复回来。',
    });
    expect(groupUndoText(en, { undone: 1, failed: [{ relPath: 'style.css', reason: 'changed' }] })).toEqual({
      ok: false,
      text: '1 change undone; 1 not undone: style.css: changed',
    });
    expect(groupUndoText(en, { undone: 0, failed: [{ relPath: null, reason: 'x' }] }).text).toBe(
      'This turn is no longer in History (it may have been cleared).',
    );
    expect(zh('history.reason.before-ai' as MessageKey)).toBe('AI 助手修改前');
    expect(zh('history.group.title' as MessageKey)).toBe('AI 助手的修改 · {n} 个文件');
    expect(en('history.group.title' as MessageKey)).toBe('AI assistant changes · {n} files');
  });
});
