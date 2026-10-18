// S58.8 — keeps wall-clock budgets out of `npm test` (ADR 0038, docs/perf/ci-runners.md). S58.3 moved every budget to
// the perf project, but the rule was only a review grep, and new ones crept back into the required matrix: the S51.5
// quick-open "< 50 ms per keystroke" failed hosted macOS twice (75.7 ms in run 39081924736, 59.7 ms in 39055086790).
// This test is that grep, automated. It runs in the static CI job, so a new budget fails the cheap job in a minute.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Functional timeouts that compare elapsed wall-clock time on purpose ("did not hang"), each with at least 5× headroom
 * over the timer it checks (docs/perf/ci-runners.md §1). A new entry needs a row there with the same reasoning.
 */
const FUNCTIONAL_TIMEOUTS: Record<string, string> = {
  'src/ai/fake-provider.test.ts': 'cancelling a slow fake stream returns in < 5 s',
  'src/preview/page-snapshot.test.ts': 'a 50 ms outline timeout fires in < 1 s',
  'tests/integration/wake-recovery.test.ts': 'answers(300) gives up in < 2 s on a silent socket',
  'src/workspace/time-limit.test.ts': 'a 50 ms regex limit stops a pattern that runs for hours in < 1 s',
  'tests/integration/project-search.test.ts': 'a 100 ms per-file regex limit ends the search in < 2 s (gap < 1 s)',
};

interface TimingAssertion {
  readonly line: number;
  readonly text: string;
}

/**
 * The `toBeLessThan` / `toBeLessThanOrEqual` assertions of a test file that compare wall-clock time: any of them in a
 * file that reads `performance.now()` (it only exists to measure), and any whose `expect(...)` reads `Date.now()`.
 */
function timingAssertions(source: string): TimingAssertion[] {
  const measures = /\bperformance\.now\(/.test(source);
  const found: TimingAssertion[] = [];
  source.split(/\r?\n/).forEach((text, i) => {
    if (text.trim().startsWith('//') || !/\.toBeLessThan(OrEqual)?\(/.test(text)) return;
    if (measures || /expect\([^;]*\bDate\.now\(\)/.test(text)) found.push({ line: i + 1, text: text.trim() });
  });
  return found;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...testFiles(rel));
    else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) out.push(rel);
  }
  return out;
}

describe('no wall-clock budget in npm test (S58.8, ADR 0038)', () => {
  it('the detector finds measured budgets and Date.now() comparisons, and ignores counts and comments', () => {
    const measured = [
      'const t0 = performance.now();',
      'run();',
      'expect(performance.now() - t0).toBeLessThan(700);',
      'expect(result.length).toBeLessThan(10);',
      '// expect(x).toBeLessThan(1)',
    ].join('\n');
    expect(timingAssertions(measured).map((a) => a.line)).toEqual([3, 4]);
    const plain = ['const started = Date.now();', 'expect(Date.now() - started).toBeLessThan(5000);'].join('\n');
    expect(timingAssertions(plain)).toEqual([{ line: 2, text: 'expect(Date.now() - started).toBeLessThan(5000);' }]);
    expect(timingAssertions('expect(list.length).toBeLessThanOrEqual(1000);')).toEqual([]);
  });

  it('src and tests/integration hold no performance budget; measurements live in tests/perf', () => {
    const files = [...testFiles('src'), ...testFiles('tests/integration')];
    expect(files.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const file of files) {
      if (file === 'tests/integration/timing-budgets.test.ts' || FUNCTIONAL_TIMEOUTS[file]) continue;
      for (const a of timingAssertions(readFileSync(path.join(ROOT, file), 'utf8'))) {
        offenders.push(`${file}:${a.line}  ${a.text}`);
      }
    }
    // Move each one to tests/perf/<name>.perf.test.ts and read it through checkBudget() (tests/perf/budget.ts), or,
    // for a genuine "did not hang" bound, add the file to FUNCTIONAL_TIMEOUTS and docs/perf/ci-runners.md.
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every allow-listed functional timeout still exists and is documented in docs/perf/ci-runners.md', () => {
    const doc = readFileSync(path.join(ROOT, 'docs/perf/ci-runners.md'), 'utf8');
    for (const file of Object.keys(FUNCTIONAL_TIMEOUTS)) {
      expect(timingAssertions(readFileSync(path.join(ROOT, file), 'utf8')).length, file).toBeGreaterThan(0);
      expect(doc, file).toContain(`\`${file}:`);
    }
  });
});
