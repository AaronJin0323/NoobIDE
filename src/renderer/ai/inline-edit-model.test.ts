import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/index';
import { I18nValueProvider } from '../i18n/I18nProvider';
import {
  acceptProposal,
  EDIT_CONTEXT_CHARS,
  EDIT_CONTEXT_LINES,
  EDIT_MAX_RANGE_CHARS,
  buildEditRequest,
  editContext,
  editLinesOf,
  fixInstruction,
  fixLinesOf,
  initialEditState,
  inlineEditReducer,
  normalizeProposal,
  proposalDiff,
  rangeTooLarge,
  sameRangeText,
  type InlineEditState,
} from './inline-edit-model';
import { InlineEditPanel, statusText, targetText, errorText } from './InlineEditPanel';
import { AI_ERROR_CODES } from './chat-text';

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

describe('inline edit range (S35.1)', () => {
  it('uses the selected whole lines, clamped to the file; the whole file without a selection', () => {
    expect(editLinesOf(10, { startLine: 3, endLine: 5 })).toEqual({ startLine: 3, endLine: 5, wholeFile: false });
    expect(editLinesOf(10, { startLine: 8, endLine: 40 })).toEqual({ startLine: 8, endLine: 10, wholeFile: false });
    expect(editLinesOf(10, null)).toEqual({ startLine: 1, endLine: 10, wholeFile: true });
    expect(editLinesOf(0, null)).toEqual({ startLine: 1, endLine: 1, wholeFile: true });
  });

  it('"Fix with AI" rewrites a few lines around the reported line, inside the file', () => {
    expect(fixLinesOf(20, 10)).toEqual({ startLine: 7, endLine: 13 });
    expect(fixLinesOf(20, 1)).toEqual({ startLine: 1, endLine: 4 });
    expect(fixLinesOf(5, 99)).toEqual({ startLine: 2, endLine: 5 });
  });
});

describe('bounded context and the request (S35.1)', () => {
  it('sends at most EDIT_CONTEXT_LINES lines before and after the range, nearest lines first', () => {
    const text = lines(200);
    const { before, after } = editContext(text, { startLine: 100, endLine: 101 });
    const b = before.split('\n');
    const a = after.split('\n');
    expect(b).toHaveLength(EDIT_CONTEXT_LINES);
    expect(b[b.length - 1]).toBe('line 99');
    expect(a).toHaveLength(EDIT_CONTEXT_LINES);
    expect(a[0]).toBe('line 102');
  });

  it('keeps each side within EDIT_CONTEXT_CHARS', () => {
    const long = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(300, 'x')).join('\n');
    const { before, after } = editContext(long, { startLine: 30, endLine: 30 });
    expect(before.length).toBeLessThanOrEqual(EDIT_CONTEXT_CHARS);
    expect(after.length).toBeLessThanOrEqual(EDIT_CONTEXT_CHARS);
    expect(before.endsWith('x')).toBe(true);
    expect(before.split('\n').pop()?.startsWith('28')).toBe(true);
    expect(after.startsWith('30')).toBe(true);
  });

  it('the start and end of a file have empty context on that side', () => {
    expect(editContext('a\nb\nc', { startLine: 1, endLine: 3 })).toEqual({ before: '', after: '' });
  });

  it('builds an edit request with the instruction, the range, the context and the locale', () => {
    const request = buildEditRequest({
      projectId: 'p',
      relPath: '页面/index.html',
      languageId: 'html',
      instruction: '  make it blue ',
      fullText: 'a\nb\nc\n',
      range: { startLine: 2, endLine: 2 },
      original: 'b',
      locale: 'zh-CN',
    });
    expect(request).toEqual({
      kind: 'edit',
      projectId: 'p',
      relPath: '页面/index.html',
      languageId: 'html',
      instruction: 'make it blue',
      selection: 'b',
      before: 'a',
      after: 'c',
      locale: 'zh-CN',
    });
  });

  it('refuses ranges too large to send, before sending', () => {
    expect(rangeTooLarge('x'.repeat(EDIT_MAX_RANGE_CHARS))).toBe(false);
    expect(rangeTooLarge('x'.repeat(EDIT_MAX_RANGE_CHARS + 1))).toBe(true);
  });

  it('the fix instruction carries the line and the original error verbatim', () => {
    const text = fixInstruction({
      line: 3,
      code: 'ReferenceError',
      originalMessage: 'Uncaught ReferenceError: userNmae is not defined',
    });
    expect(text).toContain('line 3');
    expect(text).toContain('Uncaught ReferenceError: userNmae is not defined');
  });
});

describe('proposal normalisation, diff and the apply guard (S35.1)', () => {
  it('keeps the range trailing line break as it was and uses the file line endings', () => {
    expect(normalizeProposal('a\nb', 'x\ny\n', '\n')).toBe('x\ny');
    expect(normalizeProposal('a\nb\n', 'x\ny', '\n')).toBe('x\ny\n');
    expect(normalizeProposal('a\r\nb', 'x\ny\n', '\r\n')).toBe('x\r\ny');
    expect(normalizeProposal('a', 'x\r\ny', '\n')).toBe('x\ny');
    expect(normalizeProposal('a\n', '', '\n')).toBe('');
  });

  it('the range is unchanged only when it reads exactly what was sent (line endings aside)', () => {
    expect(sameRangeText('a\r\nb', 'a\nb')).toBe(true);
    expect(sameRangeText('a\nbX', 'a\nb')).toBe(false);
    expect(sameRangeText(null, 'a')).toBe(false);
  });

  it('the diff marks removed and added lines', () => {
    const diff = proposalDiff('<h1>Hi</h1>\n<p>red</p>', '<h1>Hi</h1>\n<p>blue</p>');
    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(1);
    expect(diff.lines).toEqual([
      { kind: 'same', text: '<h1>Hi</h1>' },
      { kind: 'removed', text: '<p>red</p>' },
      { kind: 'added', text: '<p>blue</p>' },
    ]);
  });
});

describe('inline edit session (S35.1)', () => {
  const run = (state: InlineEditState, ...actions: Parameters<typeof inlineEditReducer>[1][]) =>
    actions.reduce(inlineEditReducer, state);

  it('instruction → running → review → applying → applied', () => {
    let s = run(initialEditState('instruction'), { type: 'instruction', text: 'make it blue' }, { type: 'send' });
    expect(s.phase).toBe('running');
    s = run(s, { type: 'started', requestId: 'r1' }, { type: 'answer', original: 'red', text: 'blue\n', eol: '\n' });
    expect(s).toMatchObject({ phase: 'review', proposal: 'blue', requestId: null });
    s = run(s, { type: 'accept' });
    expect(s.phase).toBe('applying');
    expect(run(s, { type: 'applied' }).phase).toBe('applied');
    expect(run(s, { type: 'save-failed', code: 'disk-full' })).toMatchObject({
      phase: 'save-failed',
      saveError: 'disk-full',
    });
  });

  it('an empty instruction is not sent', () => {
    expect(run(initialEditState('instruction'), { type: 'send' }).phase).toBe('instruction');
  });

  it('a changed range is stale; an unchanged answer is "no change"; an empty answer is an error', () => {
    const review = run(
      initialEditState('instruction', 'x'),
      { type: 'send' },
      { type: 'answer', original: 'a', text: 'b', eol: '\n' },
    );
    expect(run(review, { type: 'accept' }, { type: 'stale' }).phase).toBe('stale');
    expect(
      run(
        initialEditState('instruction', 'x'),
        { type: 'send' },
        { type: 'answer', original: 'a', text: 'a\n', eol: '\n' },
      ).phase,
    ).toBe('no-change');
    expect(
      run(
        initialEditState('instruction', 'x'),
        { type: 'send' },
        { type: 'answer', original: 'a', text: '  ', eol: '\n' },
      ),
    ).toMatchObject({ phase: 'error', error: { code: 'empty-answer' } });
  });

  it('Stop cancels; errors keep their code; try again sends again', () => {
    const running = run(initialEditState('instruction', 'x'), { type: 'send' }, { type: 'started', requestId: 'r' });
    expect(run(running, { type: 'cancelled' }).phase).toBe('cancelled');
    const failed = run(running, { type: 'failed', code: 'offline', message: 'fake offline' });
    expect(failed).toMatchObject({ phase: 'error', error: { code: 'offline' } });
    expect(run(failed, { type: 'send' }).phase).toBe('running');
    // A late answer after Stop changes nothing.
    expect(run(running, { type: 'cancelled' }, { type: 'answer', original: 'a', text: 'b', eol: '\n' }).phase).toBe(
      'cancelled',
    );
  });

  it('Accept on a file that cannot be changed right now applies nothing and says why; trying again is possible', () => {
    const calls: string[] = [];
    const zone = {
      apply: (text: string) => {
        calls.push(text);
        return { ok: true as const, text };
      },
    };
    // Renamed, moved or trashed meanwhile (or read-only): the zone is never asked to apply the proposal.
    expect(acceptProposal(true, zone, 'blue', 'red')).toEqual({ ok: false, reason: 'blocked' });
    expect(calls).toEqual([]);
    expect(acceptProposal(false, zone, 'blue', 'red')).toEqual({ ok: true, text: 'blue' });
    expect(calls).toEqual(['blue']);
    const changed = { apply: () => ({ ok: false as const, reason: 'changed' }) };
    expect(acceptProposal(false, changed, 'blue', 'red')).toEqual({ ok: false, reason: 'stale' });

    const review = run(
      initialEditState('instruction', 'x'),
      { type: 'send' },
      { type: 'answer', original: 'a', text: 'b', eol: '\n' },
    );
    const blocked = run(review, { type: 'accept' }, { type: 'blocked' });
    expect(blocked.phase).toBe('blocked');
    expect(run(blocked, { type: 'applied' }).phase).toBe('blocked');
    expect(run(blocked, { type: 'send' }).phase).toBe('running');
    expect(run(initialEditState('instruction', 'x'), { type: 'blocked' }).phase).toBe('instruction');
  });

  it('consent comes first; Accept only from review', () => {
    expect(run(initialEditState('consent', 'x'), { type: 'send' }).phase).toBe('consent');
    expect(run(initialEditState('consent', 'x'), { type: 'consented' }).phase).toBe('instruction');
    expect(run(initialEditState('instruction', 'x'), { type: 'accept' }).phase).toBe('instruction');
  });
});

describe('inline edit texts in zh-CN and en (S35.1)', () => {
  const target = { relPath: 'index.html', startLine: 2, endLine: 4, wholeFile: false };
  it('says what is changed, the state in words and every error code', () => {
    const zh = (key: Parameters<typeof translate>[1]) => translate('zh-CN', key);
    const en = (key: Parameters<typeof translate>[1]) => translate('en', key);
    expect(targetText(zh, target)).toBe('要修改的代码：index.html 第 2–4 行');
    expect(targetText(en, { ...target, wholeFile: true })).toBe('Code to change: all of index.html');
    expect(statusText(en, { ...initialEditState('running') }, 'windows')).toBe('The AI is writing the change…');
    expect(statusText(zh, { ...initialEditState('stale') }, 'windows')).toContain('没有应用');
    expect(statusText(zh, { ...initialEditState('blocked') }, 'windows')).toContain('正在重命名、移动或删除');
    expect(statusText(en, { ...initialEditState('blocked') }, 'windows')).toContain('being renamed, moved or deleted');
    expect(statusText(en, { ...initialEditState('applied') }, 'mac')).toContain('⌘Z');
    expect(statusText(en, { ...initialEditState('applied') }, 'windows')).toContain('Ctrl+Z');
    for (const code of [...AI_ERROR_CODES, 'empty-answer']) {
      expect(errorText(zh, code)).not.toBe(zh('ai.error.generic'));
      expect(errorText(en, code)).not.toBe(en('ai.error.generic'));
    }
  });

  it('the review shows the diff with signs and words, and Accept / Reject buttons', () => {
    const state: InlineEditState = { ...initialEditState('review'), proposal: '<p>blue</p>' };
    const noop = () => undefined;
    const actions = {
      instruction: noop,
      send: noop,
      stop: noop,
      accept: noop,
      reject: noop,
      close: noop,
      openSettings: noop,
    };
    const html = renderToStaticMarkup(
      createElement(
        I18nValueProvider,
        { value: { locale: 'en', t: (key) => translate('en', key), setLocale: noop } },
        createElement(InlineEditPanel, { state, target, original: '<p>red</p>', platform: 'windows', actions }),
      ),
    );
    expect(html).toContain('Proposed change: 1 lines removed, 1 lines added');
    expect(html).toMatch(/data-kind="removed".*−.*removed: .*&lt;p&gt;red&lt;\/p&gt;/);
    expect(html).toMatch(/data-kind="added".*\+.*added: .*&lt;p&gt;blue&lt;\/p&gt;/);
    expect(html).toContain('data-testid="inline-edit-accept"');
    expect(html).toContain('data-testid="inline-edit-reject"');
    // Accept / Reject come before the diff, so they are in view however long the proposed change is.
    expect(html.indexOf('data-testid="inline-edit-accept"')).toBeLessThan(
      html.indexOf('data-testid="inline-edit-diff"'),
    );
    expect(html.indexOf('data-testid="inline-edit-reject"')).toBeLessThan(
      html.indexOf('data-testid="inline-edit-diff"'),
    );
  });
});
