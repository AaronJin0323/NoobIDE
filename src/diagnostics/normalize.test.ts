import { describe, expect, it } from 'vitest';
import { createProblemRecord } from '../shared/problem';
import {
  CROSS_ORIGIN_SCRIPT_ERROR,
  isOpaqueCrossOriginError,
  normalizePageError,
  projectPathFromUrl,
} from './normalize';
import { renderExplanation } from './rules/engine';
import { honestyViolations } from './rules/honesty';
import { explain } from './rules';

const opts = {
  projectId: 'p',
  preview: { sessionId: 's4', generation: 2 },
  previewOrigin: 'http://127.0.0.1:51734',
  at: 42,
};

describe('normalizePageError', () => {
  it('maps a same-origin script URL to a decoded project path with line and column', () => {
    const input = normalizePageError(
      {
        kind: 'error',
        message: 'Uncaught ReferenceError: userNmae is not defined',
        filename: 'http://127.0.0.1:51734/%E6%88%91%E7%9A%84%20%E4%B8%BB%E9%A1%B5/script.js?v=2',
        lineno: 12,
        colno: 20,
        stack: 'ReferenceError: userNmae is not defined\n    at …',
      },
      opts,
    );
    expect(input).toMatchObject({
      source: 'runtime',
      code: 'ReferenceError',
      file: '我的 主页/script.js',
      line: 12,
      column: 20,
      preview: opts.preview,
      at: 42,
      message: 'Uncaught ReferenceError: userNmae is not defined',
    });
  });

  it('keeps scripts on other origins out of the project, recording their URL', () => {
    const input = normalizePageError(
      {
        kind: 'error',
        message: 'Uncaught TypeError: x is undefined',
        filename: 'https://cdn.example.com/lib.js',
        lineno: 1,
        colno: 9,
        errorName: 'TypeError',
      },
      opts,
    );
    expect(input.file).toBeUndefined();
    expect(input.line).toBeUndefined();
    expect(input.data).toEqual({ scriptUrl: 'https://cdn.example.com/lib.js' });
    expect(input.code).toBe('TypeError');
  });

  it('unhandled rejections get their own code; line 0 means unknown', () => {
    const input = normalizePageError(
      {
        kind: 'unhandledrejection',
        message: 'Uncaught (in promise) Error: nope',
        filename: 'http://127.0.0.1:51734/a.js',
        lineno: 0,
      },
      opts,
    );
    expect(input.code).toBe('unhandledrejection');
    expect(input.file).toBe('a.js');
    expect(input.line).toBeUndefined();
  });

  it('projectPathFromUrl rejects other origins and bad URLs', () => {
    expect(projectPathFromUrl('http://127.0.0.1:9999/a.js', opts.previewOrigin)).toBeUndefined();
    expect(projectPathFromUrl('not a url', opts.previewOrigin)).toBeUndefined();
    expect(projectPathFromUrl('http://127.0.0.1:51734/', opts.previewOrigin)).toBeUndefined();
  });
});

describe("cross-origin 'Script error.' (S16.6)", () => {
  const opaque = { kind: 'error', message: 'Script error.', filename: '', lineno: 0, colno: 0 } as const;

  it('is recognised only without a location', () => {
    expect(isOpaqueCrossOriginError(opaque)).toBe(true);
    expect(isOpaqueCrossOriginError({ ...opaque, filename: 'http://127.0.0.1:51734/a.js', lineno: 3 })).toBe(false);
    expect(isOpaqueCrossOriginError({ ...opaque, message: 'Uncaught Error: Script error.' })).toBe(false);
  });

  it('produces a record with no location that explains why the location is unavailable', () => {
    const record = createProblemRecord(normalizePageError(opaque, opts));
    expect(record.code).toBe(CROSS_ORIGIN_SCRIPT_ERROR);
    expect(record.file).toBeUndefined();
    expect(record.line).toBeUndefined();
    expect(record.originalMessage).toBe('Script error.');

    const exp = explain(record, { externalScripts: ['https://cdn.example.com/lib.min.js'] });
    expect(exp.ruleId).toBe(CROSS_ORIGIN_SCRIPT_ERROR);
    expect(exp.actions.map((a) => a.kind)).toEqual(['show-original']); // no "Go to code": there is no location
    expect(honestyViolations(record, exp)).toEqual([]);
    const zh = renderExplanation('zh-CN', record, exp);
    expect(zh.location).toBeUndefined();
    expect(zh.explanation).toContain('无法显示文件名和行号');
    expect(zh.causes).toEqual(['页面加载了另一个网站的脚本：https://cdn.example.com/lib.min.js']);
    expect(renderExplanation('en', record, exp).explanation).toContain('cannot show a file name or line number');
  });

  it('a "Script error." that reached the store without the code is still explained', () => {
    const record = createProblemRecord({
      source: 'runtime',
      severity: 'error',
      projectId: 'p',
      code: 'Error',
      message: 'Script error.',
      at: 1,
    });
    expect(explain(record).ruleId).toBe(CROSS_ORIGIN_SCRIPT_ERROR);
  });
});
