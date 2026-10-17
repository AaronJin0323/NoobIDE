import { describe, expect, it } from 'vitest';
import type { ProblemInput } from '../shared/problem';
import { ProblemStore } from './store';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const err = (over: Partial<ProblemInput> = {}): ProblemInput => ({
  source: 'runtime',
  severity: 'error',
  projectId: 'p',
  preview: { sessionId: 's1', generation: 1 },
  file: 'script.js',
  line: 12,
  column: 20,
  code: 'ReferenceError',
  message: 'Uncaught ReferenceError: userNmae is not defined',
  stack: 'ReferenceError: userNmae is not defined\n    at http://127.0.0.1:5000/script.js:12:20',
  at: 0,
  ...over,
});

describe('ProblemStore dedupe (S16.5)', () => {
  it('collapses duplicates into one record with a count, keeping the original and the latest verbatim', () => {
    const c = clock(1000);
    const store = new ProblemStore({ now: c.now });
    expect(store.add(err({ at: 1000 }))).toBe('added');
    c.advance(5000);
    expect(store.add(err({ at: 6000, stack: 'different stack', preview: { sessionId: 's1', generation: 2 } }))).toBe(
      'repeat',
    );
    expect(store.add(err({ at: 7000 }))).toBe('repeat');
    const [r, ...rest] = store.list();
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({
      count: 3,
      firstSeen: 1000,
      lastSeen: 7000,
      originalMessage: err().message,
      originalStack: err().stack,
    });
    expect(r?.preview).toEqual({ sessionId: 's1', generation: 1 });
    expect(r?.last?.at).toBe(7000);
  });

  it('keeps different problems apart (different line, message, source)', () => {
    const store = new ProblemStore();
    store.add(err());
    store.add(err({ line: 13 }));
    store.add(err({ message: 'other' }));
    store.add(err({ source: 'console', code: 'console.error' }));
    expect(store.list()).toHaveLength(4);
    expect(store.list('console')).toHaveLength(1);
    expect(store.list('runtime')).toHaveLength(3);
  });
});

describe('ProblemStore volume limits (S16.5)', () => {
  it('rate-limits new records after the burst, counts the dropped ones, and refills over time', () => {
    const c = clock();
    const store = new ProblemStore({ now: c.now, burst: 10, ratePerSecond: 5 });
    const outcomes = Array.from({ length: 25 }, (_, i) =>
      store.add(err({ source: 'console', code: 'console.log', message: `tick ${i}` })),
    );
    expect(outcomes.filter((o) => o === 'added')).toHaveLength(10);
    expect(store.stats().dropped.console).toBe(15);
    c.advance(1000); // 5 tokens back
    const later = Array.from({ length: 8 }, (_, i) =>
      store.add(err({ source: 'console', code: 'console.log', message: `late ${i}` })),
    );
    expect(later.filter((o) => o === 'added')).toHaveLength(5);
    expect(store.stats().dropped.console).toBe(18);
  });

  it('rate limits per source: a console flood does not starve the runtime error that follows', () => {
    const store = new ProblemStore({ now: () => 0, burst: 5, ratePerSecond: 0 });
    for (let i = 0; i < 1000; i++) store.add(err({ source: 'console', code: 'console-error', message: `spam ${i}` }));
    expect(store.stats().dropped.console).toBe(995);
    expect(store.add(err())).toBe('added');
    expect(store.stats().dropped.runtime).toBe(0);
  });

  it('still counts repeats of an existing problem while new ones are being dropped', () => {
    const store = new ProblemStore({ now: () => 0, burst: 1, ratePerSecond: 0 });
    store.add(err());
    expect(store.add(err({ message: 'new' }))).toBe('dropped');
    for (let i = 0; i < 100; i++) expect(store.add(err())).toBe('repeat');
    expect(store.list()[0]?.count).toBe(101);
  });

  it('is a ring buffer per source: evicts the least recently seen record and counts evictions', () => {
    const store = new ProblemStore({ capacity: { runtime: 3 }, burst: 1000 });
    store.add(err({ line: 1 }));
    store.add(err({ line: 2 }));
    store.add(err({ line: 3 }));
    store.add(err({ line: 1 })); // line 1 seen again → most recent
    store.add(err({ line: 4 })); // evicts line 2
    expect(store.list('runtime').map((r) => r.line)).toEqual([1, 3, 4]);
    expect(store.stats().evicted.runtime).toBe(1);
  });

  it('console floods cannot push out runtime errors', () => {
    const store = new ProblemStore({ capacity: { console: 50 }, burst: 100000, ratePerSecond: 0 });
    store.add(err());
    for (let i = 0; i < 20000; i++) store.add(err({ source: 'console', code: 'console.log', message: `spam ${i}` }));
    expect(store.list('runtime')).toHaveLength(1);
    expect(store.list('console')).toHaveLength(50);
    expect(store.list('console').at(-1)?.originalMessage).toBe('spam 19999');
  });

  // The 100k-event throughput budget (CPU time) lives in tests/perf/problem-store.perf.test.ts (S50.3).

  it('revision changes on every visible change; update/clear/get work by id', () => {
    const store = new ProblemStore();
    const r0 = store.revision;
    store.add(err());
    expect(store.revision).toBeGreaterThan(r0);
    const id = store.list()[0]!.id;
    expect(store.get(id)?.line).toBe(12);
    expect(store.update(id, (r) => ({ ...r, stale: true }))).toBe(true);
    expect(store.get(id)?.stale).toBe(true);
    expect(store.update('missing', (r) => r)).toBe(false);
    expect(store.clear((r) => r.source === 'console')).toBe(0);
    expect(store.clear()).toBe(1);
    expect(store.list()).toEqual([]);
    store.resetStats();
    expect(store.stats().dropped.runtime).toBe(0);
  });
});
