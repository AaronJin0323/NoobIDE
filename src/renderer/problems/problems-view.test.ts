import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemInput, type ProblemRecord } from '../../shared/problem';
import { activeIds, announcementFor, buildView } from './problems-view';

const P = 'project-1';
let n = 0;
const rec = (input: Partial<ProblemInput> & { stale?: boolean }): ProblemRecord => {
  const { stale, ...rest } = input;
  const r = createProblemRecord(
    { source: 'static', severity: 'error', projectId: P, code: 'x', message: 'm', at: 1, ...rest },
    `r${++n}`,
  );
  return stale ? { ...r, stale } : r;
};

describe('Problems panel view (S17.1)', () => {
  it('sorts records into static, runtime and resource sections; console errors are runtime', () => {
    const view = buildView(
      P,
      [rec({ file: 'b.js', line: 2 }), rec({ severity: 'warning', file: 'a.css', line: 1 })],
      [
        rec({ source: 'runtime', code: 'ReferenceError' }),
        rec({ source: 'console', code: 'console-error' }),
        rec({ source: 'resource', code: 'resource-failed', resource: { requestedUrl: 'x' } }),
      ],
    );
    expect(view.sections.static.map((r) => r.file)).toEqual(['b.js', 'a.css']); // errors before warnings
    expect(view.sections.runtime.map((r) => r.source)).toEqual(expect.arrayContaining(['runtime', 'console']));
    expect(view.sections.resource).toHaveLength(1);
    expect(view).toMatchObject({ errors: 4, warnings: 1, total: 5, resolvedCandidates: 0 });
  });

  it('shows only the current project; stale problems are listed but not counted', () => {
    const view = buildView(
      P,
      [rec({ projectId: 'other' })],
      [rec({ source: 'runtime', stale: true }), rec({ source: 'runtime' })],
    );
    expect(view.sections.static).toEqual([]);
    expect(view.sections.runtime.map((r) => Boolean(r.stale))).toEqual([false, true]);
    expect(view).toMatchObject({ total: 1, errors: 1, resolvedCandidates: 1 });
    expect(buildView(null, [rec({})], []).total).toBe(0);
  });

  it('announces only news: new problems, or that none are left', () => {
    const a = rec({});
    const b = rec({ source: 'runtime' });
    const first = buildView(P, [a], []);
    expect(announcementFor(new Set(), first)).toEqual({ kind: 'new', count: 1 });
    const same = buildView(P, [{ ...a, count: 3 }], []);
    expect(announcementFor(activeIds(first), same)).toBeNull();
    const more = buildView(P, [a], [b]);
    expect(announcementFor(activeIds(first), more)).toEqual({ kind: 'new', count: 1 });
    expect(announcementFor(activeIds(more), buildView(P, [], []))).toEqual({ kind: 'cleared' });
    expect(announcementFor(new Set(), buildView(P, [], []))).toBeNull();
  });
});
