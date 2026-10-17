import { describe, expect, it } from 'vitest';
import { extractHtmlSymbols } from '../../src/renderer/editor/project-symbols';
import { checkBudget } from './budget';

/**
 * S43.4: extracting ids and classes from a 256 KB HTML document is bounded (one pass, no backtracking). The
 * correctness half of this case stays in src/renderer/editor/project-symbols.test.ts; the time budget lives here
 * (S58.3, ADR 0038): enforced by `npm run verify` on the dev machine, reported on GitHub Actions.
 */
describe('symbol extraction budget (S43.4)', () => {
  it('extracts the symbols of a 256 KB document in < 500 ms', () => {
    const chunk = '<div id="i{n}" class="c{n} shared"><style>.s{n} { color: #fff; margin: .5em }</style></div>\n';
    let text = '';
    for (let n = 0; text.length < 256 * 1024; n++) text += chunk.replaceAll('{n}', String(n));
    extractHtmlSymbols(text); // warm up
    const t0 = performance.now();
    const symbols = extractHtmlSymbols(text);
    const ms = performance.now() - t0;
    expect(symbols.ids.length).toBeGreaterThan(1000);
    expect(symbols.classes).toContain('shared');
    checkBudget('symbol extraction: 256 KB HTML document', ms, 500);
  });
});
