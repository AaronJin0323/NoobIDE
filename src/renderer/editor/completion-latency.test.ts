import { describe, expect, it } from 'vitest';
import { completionContextAt } from './completion-context';
import { suggestPaths } from './path-suggest';
import { ProjectIndex } from './project-index';

/**
 * S43.6 latency budget (decision 0032): what the completion provider does per request — merge the project's ids and
 * classes, find the context, build the items — stays within 10 ms p95 for 200 HTML/CSS files and 2 000 classes.
 * Extraction happens once when files are read, not per request; it is measured in completion-perf.test.ts.
 *
 * The budget is the provider's compute cost. On hosted CI runners (3–4 vCPUs shared by four vitest workers) a single
 * descheduling of this worker inflates every sample of a batch (main saw 21 ms p95 against 0.9 ms on the dev
 * machine), so the test measures up to BATCHES independent batches and judges the best one: a batch that fits the
 * budget proves the compute cost does, and a stalled batch is noise, not provider work (contention and GC add time
 * to a sample and never remove any). Every batch is judged against the same, unchanged budget (S06.6).
 */
function project(): Record<string, string> {
  const disk: Record<string, string> = {};
  for (let f = 0; f < 100; f += 1) {
    const rows = Array.from({ length: 10 }, (_, i) => `  <div id="item-${f}-${i}" class="c-${f}-${i} shared">x</div>`);
    disk[`pages/page-${f}.html`] = `<main>\n${rows.join('\n')}\n</main>\n`;
    const rules = Array.from({ length: 10 }, (_, i) => `.k-${f}-${i} {\n  color: red;\n}`);
    disk[`css/style-${f}.css`] = `${rules.join('\n')}\n`;
  }
  for (let i = 0; i < 300; i += 1) disk[`images/pic-${i}.png`] = '';
  return disk;
}

const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] ?? Infinity;

const BUDGET_MS = 10;
const RUNS = 60;
/** The first runs include JIT compilation, which a user pays once per session, not per request. */
const WARM_UP = 10;
const BATCHES = 5;

describe('completion latency budget (S43.6)', () => {
  it('a selector and a path request each take <= 10 ms p95 on a 200-file project', async () => {
    const disk = project();
    const index = new ProjectIndex({ read: async (relPath) => ({ text: disk[relPath] ?? '' }) });
    await index.open(Object.keys(disk).map((relPath) => ({ relPath, uri: `file:///p/${relPath}` })));
    const symbols = index.symbols();
    expect(symbols.classes.size).toBeGreaterThanOrEqual(2_000);
    const before = `const cards = [];\n${'let x = 1;\n'.repeat(150)}document.querySelector('.c-4`;

    const batch = (runs: number, warmUp: number) => {
      const selector: number[] = [];
      const paths: number[] = [];
      for (let run = 0; run < runs + warmUp; run += 1) {
        let started = performance.now();
        const context = completionContextAt('javascript', before.slice(-2_000));
        const table = index.symbols();
        const items = [...table.classes].map(([name, files]) => ({ label: name, description: files.join(', ') }));
        if (run >= warmUp) selector.push(performance.now() - started);
        expect(context?.kind).toBe('class');
        expect(items.length).toBe(table.classes.size);

        started = performance.now();
        const pathContext = completionContextAt('html', '<img src="../images/');
        const suggestions = suggestPaths({
          files: index.files(),
          fromRelPath: 'pages/page-1.html',
          prefix: '../images/',
          accept: 'media',
          js: false,
        });
        if (run >= warmUp) paths.push(performance.now() - started);
        expect(pathContext?.kind).toBe('path');
        expect(suggestions.length).toBeGreaterThan(0);
      }
      return { selectorP95: p95(selector), pathP95: p95(paths) };
    };

    const batches: { selectorP95: number; pathP95: number }[] = [];
    for (let b = 0; b < BATCHES; b += 1) {
      const result = batch(RUNS, b === 0 ? WARM_UP : 0);
      batches.push(result);
      if (result.selectorP95 <= BUDGET_MS && result.pathP95 <= BUDGET_MS) break;
    }
    const best = {
      selectorP95: Math.min(...batches.map((r) => r.selectorP95)),
      pathP95: Math.min(...batches.map((r) => r.pathP95)),
    };
    // Numbers only (docs/perf/completion-latency.md): NOOBIDE_PERF_PRINT=1 npx vitest run completion-latency
    if (process.env.NOOBIDE_PERF_PRINT) console.log(JSON.stringify({ ...best, batches }));
    const perBatch = (key: 'selectorP95' | 'pathP95') => batches.map((r) => r[key].toFixed(2)).join(', ');
    expect(best.selectorP95, `selector p95 per batch: ${perBatch('selectorP95')} ms`).toBeLessThanOrEqual(BUDGET_MS);
    expect(best.pathP95, `path p95 per batch: ${perBatch('pathP95')} ms`).toBeLessThanOrEqual(BUDGET_MS);
  });
});
