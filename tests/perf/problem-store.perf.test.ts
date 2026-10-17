import { describe, expect, it } from 'vitest';
import { ProblemStore } from '../../src/diagnostics/store';
import type { ProblemInput } from '../../src/shared/problem';
import { checkBudget } from './budget';

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

/**
 * S16 review: the problem store stays O(1) per event under a console flood. Budget is CPU time of this test process,
 * best of 3 runs, not wall-clock: CPU time only counts work done, so it still catches a real regression — the run
 * takes ~30–50 ms of CPU on the dev machine; an accidental O(n²) step over 100k events would exceed 2 s by orders of
 * magnitude. Moved out of src/diagnostics/store.test.ts by S58.3 (ADR 0038): enforced by `npm run verify` on the dev
 * machine, reported on GitHub Actions.
 */
describe('problem store throughput budget', () => {
  it('handles 100k events quickly with bounded memory', () => {
    const cpuMs = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const store = new ProblemStore({ now: () => 0 });
      const t = cpuMs();
      for (let i = 0; i < 100000; i++)
        store.add(err({ source: 'console', code: 'console.log', message: `m${i % 5000}` }));
      best = Math.min(best, cpuMs() - t);
      expect(store.list().length).toBeLessThanOrEqual(1000);
    }
    checkBudget('problem store: 100k console events, best-of-3 CPU time', best, 2000);
  });
});
