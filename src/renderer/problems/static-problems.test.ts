import { describe, expect, it } from 'vitest';
import type { ProblemRecord } from '../../shared/problem';
import { StaticProblems, codeOf, markerToProblem, severityOf, type MarkerLike } from './static-problems';

const marker = (over: Partial<MarkerLike> = {}): MarkerLike => ({
  owner: 'javascript',
  severity: 8,
  code: '2304',
  message: "Cannot find name 'userNmae'.",
  startLineNumber: 12,
  startColumn: 20,
  endLineNumber: 12,
  endColumn: 28,
  ...over,
});

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      set: (callback: () => void) => {
        pending.set(++next, callback);
        return next;
      },
      clear: (handle: unknown) => void pending.delete(handle as number),
    },
    pending,
    fire: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const c of callbacks) c();
    },
  };
}

function setup() {
  const t = fakeTimers();
  const published: (readonly ProblemRecord[])[] = [];
  let now = 1000;
  const problems = new StaticProblems({
    projectId: 'p1',
    onChange: (records) => published.push(records),
    timers: t.timers,
    now: () => now,
  });
  return { problems, published, ...t, tick: (ms: number) => (now += ms) };
}

describe('marker → ProblemRecord (S19.1)', () => {
  it('maps a TypeScript marker to a static record with the original message, position and code', () => {
    const record = markerToProblem(marker(), { projectId: 'p1', relPath: 'js/script.js', at: 5 });
    expect(record).toMatchObject({
      source: 'static',
      severity: 'error',
      projectId: 'p1',
      file: 'js/script.js',
      line: 12,
      column: 20,
      code: '2304',
      originalMessage: "Cannot find name 'userNmae'.",
      data: { endLine: 12, endColumn: 28, owner: 'javascript' },
      count: 1,
    });
    expect(record?.id).toMatch(/^s-/);
    // Same marker → same id (stable list keys and card state across marker refreshes).
    expect(markerToProblem(marker(), { projectId: 'p1', relPath: 'js/script.js', at: 9 })?.id).toBe(record?.id);
  });

  it('maps severities and drops hints', () => {
    expect([8, 4, 2, 1].map(severityOf)).toEqual(['error', 'warning', 'info', null]);
    expect(markerToProblem(marker({ severity: 1 }), { projectId: 'p', relPath: 'a.js', at: 0 })).toBeNull();
  });

  it('reads codes in either Monaco form and falls back to the owner', () => {
    expect(codeOf(marker({ code: 'unknownProperties' }))).toBe('unknownProperties');
    expect(codeOf(marker({ code: { value: '2552' } }))).toBe('2552');
    expect(codeOf(marker({ code: undefined, owner: 'css' }))).toBe('css');
  });
});

describe('StaticProblems (S19.1)', () => {
  it('debounces: a burst of marker updates is published once', () => {
    const { problems, published, fire, pending } = setup();
    problems.update('a.js', [marker()]);
    problems.update('a.js', [marker({ startLineNumber: 13 })]);
    problems.update('b.css', [
      marker({ owner: 'css', code: 'unknownProperties', message: "Unknown property: 'colr'" }),
    ]);
    expect(published).toEqual([]);
    expect(pending.size).toBe(1);
    fire();
    expect(published).toHaveLength(1);
    expect(published[0]?.map((r) => `${r.file}:${r.line}`)).toEqual(['a.js:13', 'b.css:12']);
  });

  it('clears correctly: empty markers, closed files, and a project switch', () => {
    const { problems, published, fire } = setup();
    problems.update('a.js', [marker()]);
    problems.update('b.js', [marker()]);
    fire();
    problems.update('a.js', []); // the user fixed it
    fire();
    expect(published.at(-1)?.map((r) => r.file)).toEqual(['b.js']);
    problems.retain(['c.js']); // b.js was closed
    fire();
    expect(published.at(-1)).toEqual([]);
    problems.update('c.js', [marker()]);
    problems.dispose(); // project closed: nothing is published any more
    fire();
    expect(published.at(-1)).toEqual([]);
  });

  it('a problem that stays keeps its first-seen time; one that comes back later is new', () => {
    const { problems, published, fire, tick } = setup();
    problems.update('a.js', [marker()]);
    fire();
    const first = published.at(-1)?.[0]?.firstSeen;
    tick(5000);
    problems.update('a.js', [marker()]);
    fire();
    expect(published.at(-1)?.[0]?.firstSeen).toBe(first);
    problems.update('a.js', []);
    fire();
    tick(5000);
    problems.update('a.js', [marker()]);
    fire();
    expect(published.at(-1)?.[0]?.firstSeen).toBe((first ?? 0) + 10_000);
  });

  it('flush publishes at once', () => {
    const { problems, published } = setup();
    problems.update('a.js', [marker()]);
    problems.flush();
    expect(published).toHaveLength(1);
  });
});
