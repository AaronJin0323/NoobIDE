import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemRecord } from '../../shared/problem';
import { translate } from '../i18n/index';
import {
  AI_PROMPT_PENDING_CODE,
  atLineEnd,
  buildGenerateRequest,
  enterRuns,
  fixWithAiRoute,
  fitIndent,
  GENERATE_CONTEXT_CHARS,
  isPromptLanguage,
  linesAfterChanges,
  linesTouched,
  parsePromptLine,
  promptLinesOf,
  promptMarkersWanted,
  promptProblems,
  promptsEnabled,
  PROMPT_PROBLEM_CHARS,
} from './ai-prompt-model';

/** S42.2 (decision 0031): how an `/ai` line is recognised, when Enter runs it and what is sent. */
describe('parsePromptLine', () => {
  it('recognises /ai requests in English and Chinese, indented, with ASCII or full-width spaces', () => {
    expect(parsePromptLine('/ai center this heading')).toEqual({ indent: '', prompt: 'center this heading' });
    expect(parsePromptLine('    /ai 做一个点击后数字加一的按钮')).toEqual({
      indent: '    ',
      prompt: '做一个点击后数字加一的按钮',
    });
    expect(parsePromptLine('\t/ai　把标题居中　 ')).toEqual({ indent: '\t', prompt: '把标题居中' });
    expect(parsePromptLine('/ai  two  spaces  ')).toEqual({ indent: '', prompt: 'two  spaces' });
  });

  it('a bare /ai has no request yet', () => {
    expect(parsePromptLine('/ai')).toEqual({ indent: '', prompt: '' });
    expect(parsePromptLine('  /ai   ')).toEqual({ indent: '  ', prompt: '' });
  });

  it('does not take look-alikes or real code', () => {
    for (const text of [
      '/aim high',
      '/AI center',
      'x /ai y',
      '// /ai center',
      '<!-- /ai center -->',
      '/* /ai */',
      'const re = /ai/g;',
      '/ai/.test(s)',
      'a /ai',
      '',
    ]) {
      expect(parsePromptLine(text), text).toBeNull();
    }
  });

  it('only HTML, CSS and JavaScript files have prompts; lines are found anywhere', () => {
    expect(['html', 'css', 'javascript'].every(isPromptLanguage)).toBe(true);
    expect(['json', 'markdown', 'plaintext', 'typescript'].some(isPromptLanguage)).toBe(false);
    expect(promptLinesOf('<p>\r\n/ai a\n  /ai\nx')).toEqual([2, 3]);
  });
});

describe('when plain Enter runs a prompt', () => {
  const run = (lineText: string, column: number, armed = true, quiet = true) =>
    enterRuns({ lineText, column, armed, quiet });

  it('at the end of an armed line with a request, trailing spaces allowed', () => {
    expect(run('/ai center', 11)).toBe(true);
    expect(run('/ai center  ', 11)).toBe(true);
    expect(run('/ai 居中', 7)).toBe(true);
    expect(atLineEnd('/ai x', 6)).toBe(true);
  });

  it('never on an unarmed line, mid-line, a bare /ai, with a selection/suggestion/IME, or on other text', () => {
    expect(run('/ai center', 11, false)).toBe(false);
    expect(run('/ai center', 5)).toBe(false);
    expect(run('/ai', 4)).toBe(false);
    expect(run('/ai center', 11, true, false)).toBe(false);
    expect(run('<p>hi</p>', 10)).toBe(false);
  });

  it('undo/redo with several changes arms the lines in the text after the edit', () => {
    const change = (start: number, end: number, offset: number, text: string) => ({
      range: { startLineNumber: start, endLineNumber: end },
      rangeOffset: offset,
      text,
    });
    // Reported last-first: line 2 gains two lines, so the change at old line 5 lands on line 7.
    expect(linesAfterChanges([change(5, 5, 50, '/ai x'), change(2, 2, 10, 'a\nb\nc')])).toEqual([2, 3, 4, 7]);
    // Line 2–4 collapse into one: the change at old line 6 lands on line 4.
    expect(linesAfterChanges([change(2, 4, 10, 'z'), change(6, 6, 80, 'y')])).toEqual([2, 4]);
  });

  it('a change arms the lines it typed or pasted', () => {
    expect(linesTouched({ startLine: 4, text: 'x' })).toEqual([4]);
    expect(linesTouched({ startLine: 4, text: '' })).toEqual([4]);
    expect(linesTouched({ startLine: 2, text: 'a\r\n/ai b\nc' })).toEqual([2, 3, 4]);
  });
});

const record = (patch: Partial<ProblemRecord>): ProblemRecord => ({
  id: Math.random().toString(36),
  dedupeKey: 'k',
  source: 'static',
  severity: 'error',
  projectId: 'p',
  file: 'index.html',
  line: 1,
  code: 'c',
  originalMessage: 'm',
  firstSeen: 0,
  lastSeen: 0,
  count: 1,
  ...patch,
});

describe('promptProblems', () => {
  it('sends the file’s problems, errors first and nearest first, without the prompt’s own noise', () => {
    const records = [
      record({ line: 40, code: 'far-error' }),
      record({ line: 11, code: 'near-warning', severity: 'warning' }),
      record({ line: 12, code: 'near-error', source: 'runtime' }),
      (({ line: _line, ...rest }) => rest)(record({ code: 'no-line', source: 'console' })),
      record({ line: 10, code: 'prompt-syntax-error' }),
      record({ line: 3, code: AI_PROMPT_PENDING_CODE, severity: 'warning' }),
      record({ line: 9, code: 'other-file', file: 'style.css' }),
      record({ line: 9, code: 'stale', stale: true }),
    ];
    const out = promptProblems(records, 'index.html', 10, new Set([10]));
    expect(out.map((p) => p.code)).toEqual(['near-error', 'far-error', 'no-line', 'near-warning']);
    expect(out[0]).toEqual({ line: 12, severity: 'error', source: 'runtime', code: 'near-error', message: 'm' });
    expect(out[2]).not.toHaveProperty('line');
  });

  it('is bounded in count and message size', () => {
    const many = Array.from({ length: 20 }, (_, i) => record({ line: i + 1, originalMessage: 'x'.repeat(5000) }));
    const out = promptProblems(many, 'index.html', 1, new Set());
    expect(out).toHaveLength(8);
    expect(out.every((p) => p.message.length === PROMPT_PROBLEM_CHARS)).toBe(true);
  });
});

describe('buildGenerateRequest', () => {
  it('is an edit request in generate mode with the code around the prompt line', () => {
    const fullText = ['<body>', '  <h1>Hi</h1>', '  /ai center this heading', '</body>', ''].join('\n');
    const request = buildGenerateRequest({
      projectId: 'p',
      relPath: '中文 文件夹/index.html',
      languageId: 'html',
      prompt: ' center this heading ',
      fullText,
      line: 3,
      problems: [],
      locale: 'en',
    });
    expect(request).toEqual({
      kind: 'edit',
      projectId: 'p',
      relPath: '中文 文件夹/index.html',
      languageId: 'html',
      instruction: 'center this heading',
      selection: '',
      before: '<body>\n  <h1>Hi</h1>',
      after: '</body>',
      locale: 'en',
      mode: 'generate',
      problems: [],
    });
  });

  it('sends more context than Ctrl/Cmd+I but stays bounded', () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i} ${'x'.repeat(80)}`);
    lines[300] = '/ai make a list';
    const request = buildGenerateRequest({
      projectId: 'p',
      relPath: 'a.js',
      languageId: 'javascript',
      prompt: 'make a list',
      fullText: lines.join('\n'),
      line: 301,
      problems: [],
      locale: 'zh-CN',
    });
    expect(request.before.length).toBeGreaterThan(4000);
    expect(request.before.length).toBeLessThanOrEqual(GENERATE_CONTEXT_CHARS);
    expect(request.after.length).toBeLessThanOrEqual(GENERATE_CONTEXT_CHARS);
    expect(request.before.endsWith(lines[299] ?? '')).toBe(true);
    expect(request.after.startsWith(lines[301] ?? '')).toBe(true);
  });
});

describe('fitIndent', () => {
  it('indents an unindented answer like the prompt line, keeping blank lines and indented answers', () => {
    expect(fitIndent('<button>+1</button>\n\n<p>0</p>', '  ')).toBe('  <button>+1</button>\n\n  <p>0</p>');
    expect(fitIndent('  <p>x</p>\n  <p>y</p>', '  ')).toBe('  <p>x</p>\n  <p>y</p>');
    expect(fitIndent('a\nb', '')).toBe('a\nb');
    expect(fitIndent('', '\t')).toBe('');
  });
});

/** Integration fixes between S35 / S42 / S43 (decision 0031). */
describe('promptsEnabled', () => {
  it('is on only when AI can answer: AI on and a key stored', () => {
    expect(promptsEnabled({ kind: 'ready', provider: 'anthropic', consent: false })).toBe(true);
    expect(promptsEnabled({ kind: 'ready', provider: 'openai', consent: true })).toBe(true);
    for (const kind of ['no-key', 'no-secure-storage', 'disabled', 'loading', 'unavailable'] as const) {
      expect(promptsEnabled({ kind })).toBe(false);
    }
  });
});

describe('promptMarkersWanted', () => {
  const base = { enabled: true, languageId: 'css', scheme: 'file', editable: true };
  it('warns on an editable project file of a prompt language while prompts are enabled', () => {
    expect(promptMarkersWanted(base)).toBe(true);
  });
  it('no warning on a read-only tab, an in-memory model, another language or with prompts off', () => {
    expect(promptMarkersWanted({ ...base, editable: false })).toBe(false);
    expect(promptMarkersWanted({ ...base, scheme: 'inmemory' })).toBe(false);
    expect(promptMarkersWanted({ ...base, languageId: 'markdown' })).toBe(false);
    expect(promptMarkersWanted({ ...base, enabled: false })).toBe(false);
  });
  it('the warning tells, in both locales, that the pending line is saved into the file as text', () => {
    expect(translate('en', 'aiPrompt.marker')).toMatch(/saved into the file as plain text/);
    expect(translate('zh-CN', 'aiPrompt.marker')).toMatch(/保存在文件里/);
  });
});

describe('fixWithAiRoute', () => {
  const record = (code: string, source: 'static' | 'runtime' = 'static') =>
    createProblemRecord({
      source,
      severity: 'warning',
      projectId: 'p',
      file: 'style.css',
      line: 3,
      code,
      message: 'm',
      at: 0,
    });
  it('runs the prompt on the pending /ai warning', () => {
    expect(fixWithAiRoute(record(AI_PROMPT_PENDING_CODE))).toBe('run-prompt');
  });
  it('opens the fix review for every other problem', () => {
    expect(fixWithAiRoute(record('unknownProperties'))).toBe('fix');
    expect(fixWithAiRoute(record('SyntaxError', 'runtime'))).toBe('fix');
    expect(fixWithAiRoute(record(AI_PROMPT_PENDING_CODE, 'runtime'))).toBe('fix');
  });
});
