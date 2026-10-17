import { describe, expect, it } from 'vitest';
import { completionContextAt } from '../../src/renderer/editor/completion-context';
import { extractCssSymbols, extractHtmlSymbols } from '../../src/renderer/editor/project-symbols';
import { checkBudget } from './budget';

/**
 * Decision 0032 budget (S43.4 / S43.5): for a project of 200 HTML/CSS files with 2 000 classes, extracting the
 * symbols, finding the context and filtering the classes by prefix stays well inside a typing frame. The assertion is
 * generous (50 ms median); the unit budget for the provider itself is 10 ms p95 (completion-latency.perf.test.ts).
 * Perf project (S58.3, ADR 0038): enforced by `npm run verify` on the dev machine, reported on GitHub Actions.
 */
function project(): { html: string[]; css: string[] } {
  const html: string[] = [];
  const css: string[] = [];
  for (let f = 0; f < 100; f++) {
    let h = '<!doctype html><html><body>\n';
    let c = '/* sheet */\n';
    for (let k = 0; k < 10; k++) {
      const n = f * 10 + k;
      h += `<section id="sec-${n}" class="card card-${n} theme-${n % 7}"><p class="text-${n}">内容 ${n}</p></section>\n`;
      c += `.box-${n}, #panel-${n} > .row-${n} { color: #fff; margin: .5em ${n}px; }\n@media (min-width: 600px) { .wide-${n} { } }\n`;
    }
    html.push(`${h}<style>.inline-${f} { color: #000 }</style></body></html>`);
    css.push(c);
  }
  return { html, css };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

describe('completion performance (S43.4)', () => {
  it('extract 200 files + context + filter 2 000 classes: median < 50 ms', () => {
    const { html, css } = project();
    const samples: number[] = [];
    let classCount = 0;
    let hits = 0;
    for (let run = 0; run < 15; run++) {
      const t0 = performance.now();
      const classes = new Set<string>();
      for (const text of html) for (const c of extractHtmlSymbols(text).classes) classes.add(c);
      for (const text of css) for (const c of extractCssSymbols(text).classes) classes.add(c);
      const ctx = completionContextAt('javascript', "const el = document.querySelector('.card-1");
      const prefix = ctx && ctx.kind === 'class' ? ctx.prefix : '';
      hits = [...classes].filter((c) => c.startsWith(prefix)).length;
      samples.push(performance.now() - t0);
      classCount = classes.size;
    }
    expect(classCount).toBeGreaterThanOrEqual(2000);
    expect(hits).toBeGreaterThan(0);
    checkBudget('symbol extraction: 200 files + context + filter, median', median(samples), 50);
  });

  it('context alone on a 2 000-char window: median < 50 ms over many calls', () => {
    const filler = 'const a = 1; // note\n'.repeat(90);
    const windows = [
      ['javascript', `${filler}document.getElementById('ti`],
      ['css', `${'.a { color: #fff }\n'.repeat(100)}.ca`],
      ['html', `${'<p class="x">t</p>\n'.repeat(100)}<img src="images/`],
    ] as const;
    const samples: number[] = [];
    for (let run = 0; run < 15; run++) {
      const t0 = performance.now();
      for (let k = 0; k < 100; k++) for (const [lang, before] of windows) completionContextAt(lang, before);
      samples.push((performance.now() - t0) / 100);
    }
    checkBudget('completion context on a 2 000-char window, median', median(samples), 50);
  });
});
