import { describe, expect, it } from 'vitest';
import { detectIndentation } from '../../src/renderer/editor/indent-detect';
import { checkBudget } from './budget';

/**
 * S43.2 / decision 0032: indentation detection of a 5 000-line file stays well inside a frame (measured ≈ 0.3 ms on
 * the dev machine, docs/perf/completion-latency.md). Moved out of src/renderer/editor/indent-detect.test.ts by S50.3
 * (ADR 0038): enforced by `npm run verify` on the dev machine, reported on GitHub Actions.
 */
describe('indentation detection budget (S43.2)', () => {
  it('handles a 5 000-line file quickly: median < 20 ms', () => {
    const block = [
      'function f(a) {',
      '    // comment',
      '    const s = `x ${a} y`;',
      '    if (a) {',
      "        return 'b';",
      '    }',
      '    /* block */',
      '    return s;',
      '}',
      '',
    ];
    const lines: string[] = [];
    while (lines.length < 5000) lines.push(...block);
    const text = lines.slice(0, 5000).join('\n');
    detectIndentation(text, 'javascript'); // warm up
    const times: number[] = [];
    for (let run = 0; run < 7; run++) {
      const t0 = performance.now();
      const g = detectIndentation(text, 'javascript');
      times.push(performance.now() - t0);
      expect(g).toMatchObject({ insertSpaces: true, tabSize: 4, confidence: 'high' });
    }
    times.sort((a, b) => a - b);
    checkBudget('indentation detection: 5 000-line file, median', times[3] ?? Infinity, 20);
  });
});
