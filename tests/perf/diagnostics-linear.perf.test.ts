import { describe, expect, it } from 'vitest';
import { checkBeginnerCss, checkBeginnerHtml } from '../../src/diagnostics/beginner-checks';
import { checkHtml } from '../../src/diagnostics/html-check';
import { checkBudget } from './budget';

/**
 * The HTML and CSS checks stay linear on large files (whole-program audit, PR #42: each case below used to be
 * quadratic, seconds to many seconds). Moved out of src/diagnostics/beginner-checks.test.ts and html-check.test.ts by
 * S58.8 (ADR 0038): enforced by `npm run verify` on the dev machine, reported on GitHub Actions. What the checks
 * report for these inputs stays tested there.
 */
function timed<T>(run: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = run();
  return { value, ms: performance.now() - started };
}

describe('diagnostics stay linear on large files', () => {
  it('beginner HTML check: 12 000 unclosed <p> < 700 ms; 20 000 stray closing tags < 1.5 s', () => {
    const paragraphs = timed(() => checkBeginnerHtml('<p>text <b>x</b> <a href="#">y</a>\n'.repeat(12_000)));
    expect(paragraphs.value).toEqual([]);
    checkBudget('beginner HTML check: 12 000 paragraphs without </p>', paragraphs.ms, 700);
    const strays = timed(() => checkBeginnerHtml(`${'<span>'.repeat(20_000)}${'</b>'.repeat(20_000)}`));
    expect(strays.value).toHaveLength(20_000);
    checkBudget('beginner HTML check: 20 000 stray closing tags', strays.ms, 1500);
  });

  it('beginner CSS check: a 100 000-space run inside a declaration < 1 s', () => {
    const css = timed(() => checkBeginnerCss(`a { width: 10px${' '.repeat(100_000)}color: red }`));
    expect(css.value).toEqual([]);
    checkBudget('beginner CSS check: 100 000 spaces inside one declaration', css.ms, 1000);
  });

  it('unclosed-element check: 30 000 stray closing tags over 30 000 open <div> < 1.5 s', () => {
    const html = timed(() => checkHtml(`${'<div>'.repeat(30_000)}${'</b>'.repeat(30_000)}`));
    expect(html.value).toHaveLength(30_000);
    checkBudget('unclosed-element check: 30 000 stray closing tags', html.ms, 1500);
  });
});
