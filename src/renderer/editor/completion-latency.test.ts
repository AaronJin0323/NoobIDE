import { describe, expect, it } from 'vitest';
import { completionContextAt } from './completion-context';
import { suggestPaths } from './path-suggest';
import { ProjectIndex } from './project-index';

/**
 * S43.6 latency budget (decision 0032): what the completion provider does per request — merge the project's ids and
 * classes, find the context, build the items — stays within 10 ms p95 for 200 HTML/CSS files and 2 000 classes.
 * Extraction happens once when files are read, not per request; it is measured in completion-perf.test.ts.
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

describe('completion latency budget (S43.6)', () => {
  it('a selector and a path request each take <= 10 ms p95 on a 200-file project', async () => {
    const disk = project();
    const index = new ProjectIndex({ read: async (relPath) => ({ text: disk[relPath] ?? '' }) });
    await index.open(Object.keys(disk).map((relPath) => ({ relPath, uri: `file:///p/${relPath}` })));
    const symbols = index.symbols();
    expect(symbols.classes.size).toBeGreaterThanOrEqual(2_000);
    const before = `const cards = [];\n${'let x = 1;\n'.repeat(150)}document.querySelector('.c-4`;
    const selector: number[] = [];
    const paths: number[] = [];
    // The first runs include JIT compilation, which a user pays once per session, not per request.
    const WARM_UP = 10;
    for (let run = 0; run < 60 + WARM_UP; run += 1) {
      let started = performance.now();
      const context = completionContextAt('javascript', before.slice(-2_000));
      const table = index.symbols();
      const items = [...table.classes].map(([name, files]) => ({ label: name, description: files.join(', ') }));
      if (run >= WARM_UP) selector.push(performance.now() - started);
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
      if (run >= WARM_UP) paths.push(performance.now() - started);
      expect(pathContext?.kind).toBe('path');
      expect(suggestions.length).toBeGreaterThan(0);
    }
    // Numbers only (docs/perf/completion-latency.md): NOOBIDE_PERF_PRINT=1 npx vitest run completion-latency
    if (process.env.NOOBIDE_PERF_PRINT)
      console.log(JSON.stringify({ selectorP95: p95(selector), pathP95: p95(paths) }));
    expect(p95(selector)).toBeLessThanOrEqual(10);
    expect(p95(paths)).toBeLessThanOrEqual(10);
  });
});
