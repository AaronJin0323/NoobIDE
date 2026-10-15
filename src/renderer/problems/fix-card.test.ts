import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../../shared/problem';
import { translate, type Locale } from '../i18n/index';
import { FixCardBody, fixStatusText } from './FixCard';
import { startFix, type FixPhase, type FixState, type ReplaceTextAction } from './fix-model';

const action: ReplaceTextAction = {
  kind: 'replace-text',
  label: { key: 'action.replaceWith', params: { name: 'userName' } },
  span: { file: 'script.js', line: 12, column: 20, endColumn: 28 },
  from: 'userNmae',
  to: 'userName',
};
const runtime = createProblemRecord(
  {
    source: 'runtime',
    severity: 'error',
    projectId: 'p',
    preview: { sessionId: 's4', generation: 3 },
    file: 'script.js',
    line: 12,
    column: 20,
    code: 'ReferenceError',
    message: 'Uncaught ReferenceError: userNmae is not defined',
    at: 1,
  },
  'r',
);
const staticRecord = { ...runtime, source: 'static' as const, code: '2304' };
const state = (phase: FixPhase, extra: Partial<FixState> = {}, record = runtime): FixState => ({
  ...startFix(record, action),
  phase,
  version: 3,
  ...extra,
});
const status = (fix: FixState, locale: Locale = 'zh-CN', platform: 'mac' | 'windows' = 'windows') =>
  fixStatusText(fix, (key) => translate(locale, key), platform);

const PHASES: FixPhase[] = [
  'applying',
  'not-applied',
  'save-failed',
  'checking',
  'unchecked',
  'awaiting-refresh',
  'still-reported',
  'resolved',
  'undoing',
  'undone',
  'undo-failed',
];

describe('fix result in words (S22.5)', () => {
  it('every phase has its own text in both locales, with no unfilled placeholder', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      const texts = PHASES.map((phase) => status(state(phase, { saveError: 'busy' }), locale));
      for (const text of texts) expect(text).not.toMatch(/\{\w+\}/);
      expect(new Set(texts).size).toBe(PHASES.length);
    }
  });

  it('a failed save says so, names the reason, keeps the change and never claims it is resolved', () => {
    const fix = state('save-failed', { saveError: 'permission-denied' });
    const zh = status(fix);
    expect(zh).toContain('保存失败');
    expect(zh).toContain('没有写入权限');
    expect(zh).toContain('修改还在编辑器里');
    expect(zh).not.toMatch(/已解决/);
    const en = status(fix, 'en');
    expect(en).toContain('saving failed');
    expect(en).toContain('not resolved');
  });

  it('resolved names the file and line and what confirmed it', () => {
    expect(status(state('resolved', {}, staticRecord))).toBe(
      '已解决：script.js 第 12 行，重新检查后不再报告这个问题。',
    );
    expect(status(state('resolved'))).toContain('刷新预览后都没有再出现');
    expect(status(state('resolved'), 'en')).toContain('Resolved: script.js line 12');
    expect(status(state('awaiting-refresh'))).toContain('等预览刷新后');
  });

  it('the undo hint uses the shortcut of each platform', () => {
    expect(status(state('undo-failed'), 'zh-CN', 'mac')).toContain('⌘Z');
    expect(status(state('undo-failed'), 'en', 'windows')).toContain('Ctrl+Z');
  });
});

describe('fix card (S22.5)', () => {
  const render = (fix: FixState, locale: Locale = 'zh-CN', originalOpen = false) =>
    renderToStaticMarkup(
      createElement(FixCardBody, {
        fix,
        t: (key) => translate(locale, key),
        locale,
        platform: 'windows',
        actions: {
          undo: () => undefined,
          retrySave: () => undefined,
          recheck: () => undefined,
          clear: () => undefined,
        },
        onGoTo: () => undefined,
        originalOpen,
        onToggleOriginal: () => undefined,
      }),
    );

  it('announces the result politely as text, and offers Undo, Go to code, Show original and Clear as buttons', () => {
    const html = render(state('resolved'));
    expect(html).toMatch(/role="status" aria-live="polite"[^>]*>已解决/);
    expect(html).toContain('data-phase="resolved"');
    for (const id of ['problem-fix-undo', 'problem-fix-go-to', 'problem-fix-show-original', 'problem-fix-clear']) {
      expect(html).toMatch(new RegExp(`<button type="button"[^>]*data-testid="${id}"`));
    }
    expect(html).toContain('script.js，第 12 行：');
    expect(html).toContain('Ctrl+Z');
  });

  it('keeps the original error available until cleared', () => {
    expect(render(state('resolved'), 'en', true)).toContain('Uncaught ReferenceError: userNmae is not defined');
  });

  it('a failed save offers Undo and Save again; nothing to undo before the fix is in', () => {
    const failed = render(state('save-failed', { saveError: 'busy' }));
    expect(failed).toContain('problem-fix-undo');
    expect(failed).toContain('problem-fix-retry');
    const notApplied = render({ ...startFix(runtime, action), phase: 'not-applied', reason: 'changed' });
    expect(notApplied).not.toContain('problem-fix-undo');
    expect(notApplied).toContain('没有修改');
  });
});
