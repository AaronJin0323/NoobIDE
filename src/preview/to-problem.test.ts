import { describe, expect, it } from 'vitest';
import { ProblemStore } from '../diagnostics/store';
import { validateProblemInput } from '../shared/problem';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import { previewEntryToProblem } from './to-problem';

const ORIGIN = 'http://127.0.0.1:51734';
const opts = {
  projectId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
  preview: { sessionId: 's1', generation: 0 },
  previewOrigin: ORIGIN,
};

// The raw records the S05.4 e2e test observed for the "预览 错误" fixture.
const exception: PreviewLogEntry = {
  source: 'exception',
  level: 'error',
  message: 'Uncaught ReferenceError: userNmae is not defined',
  url: `${ORIGIN}/js/errors.js`,
  line: 3,
  at: 1,
};
const consoleError: PreviewLogEntry = {
  source: 'console',
  level: 'error',
  message: '自定义错误：找不到按钮',
  url: `${ORIGIN}/js/errors.js`,
  line: 1,
  at: 2,
};
const image404: PreviewLogEntry = {
  source: 'network',
  level: 'error',
  message: '404 GET image',
  url: `${ORIGIN}/%E5%9B%BE%E7%89%87/missing.png`,
  status: 404,
  resourceType: 'image',
  at: 3,
};
const moduleFailure: PreviewLogEntry = {
  source: 'network',
  level: 'error',
  message: '404 GET script',
  url: `${ORIGIN}/js/missing-module.js`,
  status: 404,
  resourceType: 'script',
  at: 4,
};

describe('preview records → ProblemInput (S05.4 → S16)', () => {
  it('maps an uncaught exception through normalizePageError to a project file and line', () => {
    expect(previewEntryToProblem(exception, opts)).toMatchObject({
      source: 'runtime',
      code: 'ReferenceError',
      file: 'js/errors.js',
      line: 3,
      message: exception.message,
    });
  });

  it('maps console errors with their location, and ignores plain log output', () => {
    expect(previewEntryToProblem(consoleError, opts)).toMatchObject({
      source: 'console',
      severity: 'error',
      file: 'js/errors.js',
      line: 1,
    });
    expect(previewEntryToProblem({ ...consoleError, level: 'info' }, opts)).toBeNull();
  });

  it('maps failed resources (image 404, module load failure) with the requested project path', () => {
    expect(previewEntryToProblem(image404, opts)).toMatchObject({
      source: 'resource',
      code: 'resource-failed',
      resource: { requestedPath: '图片/missing.png', status: 404, resourceType: 'image' },
    });
    expect(previewEntryToProblem(moduleFailure, opts)).toMatchObject({
      resource: { requestedPath: 'js/missing-module.js', resourceType: 'script' },
    });
    expect(
      previewEntryToProblem(
        {
          source: 'network',
          level: 'error',
          message: 'net::ERR_BLOCKED_BY_CLIENT GET fetch',
          url: 'http://localhost:6000/',
          at: 5,
        },
        opts,
      ),
    ).toMatchObject({ resource: { netError: 'net::ERR_BLOCKED_BY_CLIENT', requestedUrl: 'http://localhost:6000/' } });
  });

  it('produces inputs the shared validator and ProblemStore accept', () => {
    const store = new ProblemStore();
    for (const entry of [exception, consoleError, image404, moduleFailure, exception]) {
      const input = previewEntryToProblem(entry, opts);
      expect(input).not.toBeNull();
      if (!input) continue;
      expect(validateProblemInput(input)).toEqual({ ok: true });
      store.add(input);
    }
    const records = store.list();
    expect(records).toHaveLength(4);
    expect(records.find((r) => r.code === 'ReferenceError')?.count).toBe(2);
  });

  it('page-load notices are not problems', () => {
    expect(
      previewEntryToProblem({ source: 'page-load', level: 'warning', message: 'navigation blocked', at: 1 }, opts),
    ).toBeNull();
  });
});
