import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  createProblemRecord,
  problemDedupeKey,
  recordRepeat,
  validateProblemInput,
  type ProblemInput,
} from './problem';

const STACK =
  'ReferenceError: userNmae is not defined\n    at HTMLButtonElement.<anonymous> (http://127.0.0.1:51734/script.js:12:20)';

const runtime: ProblemInput = {
  source: 'runtime',
  severity: 'error',
  projectId: 'proj-1',
  preview: { sessionId: 's4', generation: 2 },
  file: 'script.js',
  line: 12,
  column: 20,
  code: 'ReferenceError',
  message: 'Uncaught ReferenceError: userNmae is not defined',
  stack: STACK,
  at: 1000,
};

describe('ProblemRecord model (S16.1)', () => {
  it('carries every PLAN §9 field and keeps the original message and stack verbatim', () => {
    const r = createProblemRecord(runtime, 'id-1');
    expect(r).toMatchObject({
      id: 'id-1',
      source: 'runtime',
      severity: 'error',
      projectId: 'proj-1',
      preview: { sessionId: 's4', generation: 2 },
      file: 'script.js',
      line: 12,
      column: 20,
      code: 'ReferenceError',
      originalMessage: runtime.message,
      originalStack: STACK,
      firstSeen: 1000,
      lastSeen: 1000,
      count: 1,
    });
    expect(r.truncated).toBeUndefined();
    expect(r.explanation).toBeUndefined();
    expect(typeof r.dedupeKey).toBe('string');
  });

  it('supports all four sources, with location optional (e.g. cross-origin errors have none)', () => {
    for (const source of ['static', 'runtime', 'resource', 'console'] as const) {
      const r = createProblemRecord({ ...runtime, source });
      expect(r.source).toBe(source);
    }
    const noLocation = createProblemRecord({
      source: 'runtime',
      severity: 'error',
      projectId: 'p',
      code: 'cross-origin-script-error',
      message: 'Script error.',
      at: 1,
    });
    expect(noLocation.file).toBeUndefined();
    expect(noLocation.line).toBeUndefined();
  });

  it('keeps resource facts and structured data (paths with Chinese characters and spaces intact)', () => {
    const r = createProblemRecord({
      source: 'resource',
      severity: 'error',
      projectId: 'p',
      code: 'resource-failed',
      message: 'GET http://127.0.0.1:5000/images/%E5%A4%B4%E5%83%8F.PNG 404 (Not Found)',
      resource: {
        requestedUrl: 'http://127.0.0.1:5000/images/头像.PNG',
        requestedPath: 'images/头像.PNG',
        status: 404,
        resourceType: 'image',
        initiatorFile: '我的 主页/index.html',
      },
      data: { tagName: 'img' },
      at: 5,
    });
    expect(r.resource?.requestedPath).toBe('images/头像.PNG');
    expect(r.resource?.initiatorFile).toBe('我的 主页/index.html');
    expect(r.data).toEqual({ tagName: 'img' });
  });

  it('caps huge messages and stacks and flags the record as truncated', () => {
    const r = createProblemRecord({
      ...runtime,
      message: 'x'.repeat(MAX_MESSAGE_CHARS + 50),
      stack: 'y'.repeat(MAX_STACK_CHARS * 2),
    });
    expect(r.originalMessage).toHaveLength(MAX_MESSAGE_CHARS);
    expect(r.originalStack).toHaveLength(MAX_STACK_CHARS);
    expect(r.truncated).toBe(true);
  });

  it('dedupe key: same problem → same key, regardless of time or preview generation', () => {
    const a = problemDedupeKey(runtime);
    expect(problemDedupeKey({ ...runtime, preview: { sessionId: 's4', generation: 3 } })).toBe(a);
    expect(problemDedupeKey({ ...runtime, line: 13 })).not.toBe(a);
    expect(problemDedupeKey({ ...runtime, message: 'other' })).not.toBe(a);
    expect(problemDedupeKey({ ...runtime, projectId: 'proj-2' })).not.toBe(a);
    expect(problemDedupeKey({ ...runtime, source: 'console' })).not.toBe(a);
  });

  it('a repeat increments the count, keeps the first original and stores the latest occurrence verbatim', () => {
    const first = createProblemRecord(runtime);
    const again = recordRepeat(first, {
      ...runtime,
      at: 2000,
      stack: STACK + '\n    at other',
      preview: { sessionId: 's4', generation: 3 },
    });
    expect(again.count).toBe(2);
    expect(again.firstSeen).toBe(1000);
    expect(again.lastSeen).toBe(2000);
    expect(again.originalMessage).toBe(runtime.message);
    expect(again.originalStack).toBe(STACK);
    expect(again.last).toEqual({
      at: 2000,
      message: runtime.message,
      stack: STACK + '\n    at other',
      preview: { sessionId: 's4', generation: 3 },
    });
    expect(first.count).toBe(1); // records are immutable
  });

  it('validates input crossing a trust boundary', () => {
    expect(validateProblemInput(runtime)).toEqual({ ok: true });
    expect(validateProblemInput(null)).toMatchObject({ ok: false });
    expect(validateProblemInput({ ...runtime, source: 'network' })).toMatchObject({
      ok: false,
      code: 'invalid-source',
    });
    expect(validateProblemInput({ ...runtime, severity: 'fatal' })).toMatchObject({
      ok: false,
      code: 'invalid-severity',
    });
    expect(validateProblemInput({ ...runtime, line: 0 })).toMatchObject({ ok: false, code: 'invalid-location' });
    expect(validateProblemInput({ ...runtime, column: 1.5 })).toMatchObject({ ok: false, code: 'invalid-location' });
    expect(validateProblemInput({ ...runtime, file: undefined })).toMatchObject({ ok: false, field: 'file' });
    expect(validateProblemInput({ ...runtime, message: 42 })).toMatchObject({ ok: false, field: 'message' });
    expect(validateProblemInput({ ...runtime, preview: { sessionId: 's', generation: -1 } })).toMatchObject({
      ok: false,
      field: 'preview',
    });
    expect(validateProblemInput({ ...runtime, data: { a: {} } })).toMatchObject({ ok: false, field: 'data' });
  });
});
