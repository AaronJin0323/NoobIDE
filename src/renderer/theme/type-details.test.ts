import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = (file: string) => readFileSync(path.join(RENDERER, file), 'utf8');
const MOTION = css('motion.css');
const S475 = MOTION.slice(MOTION.indexOf('/* ── S47.5'));

/** The declarations block of the first rule whose selector list contains `selector`. */
function ruleWith(sheet: string, selector: string): { selectors: string[]; body: string } {
  const text = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(/,(?![^(]*\))/).map((s) => s.trim());
    if (selectors.includes(selector)) return { selectors, body: match[2] ?? '' };
  }
  throw new Error(`no rule for ${selector}`);
}

describe('S47.5 wrapping', () => {
  it('gives the shared path class the CJK anti-split combination', () => {
    const { selectors, body } = ruleWith(S475, '.path-text');
    expect(body).toMatch(/overflow-wrap: anywhere;/);
    expect(body).toMatch(/word-break: normal;/);
    expect(body).toMatch(/min-width: 0;/);
    // Every path, file name and URL element of the workbench shares it.
    for (const selector of [
      '.tree-name',
      '.tab-name',
      '.problem-where',
      '.problem-card-location',
      '.preview-console-where',
      '.preview-page-path',
      '.welcome-recent-path',
      '.wizard-path',
      '.history-path',
      '.md-link-url',
      '.ai-chip-label',
    ])
      expect(selectors).toContain(selector);
  });

  it('never breaks words apart elsewhere (break-all would split a Chinese name per character)', () => {
    const sheets = readdirSync(RENDERER, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'));
    for (const file of sheets) expect(css(file), file).not.toMatch(/word-break:\s*break-(all|word)/);
  });

  it('balances dialog and welcome headings and keeps prose pretty', () => {
    expect(ruleWith(S475, '.welcome-title').body).toMatch(/text-wrap: balance;/);
    expect(ruleWith(S475, '.dialog-title').body).toMatch(/text-wrap: balance;/);
    for (const prose of ['.ai-msg-answer :is(p, li)', '.walkthrough-body', '.problem-card-text'])
      expect(ruleWith(S475, prose).body).toMatch(/text-wrap: pretty;/);
  });
});

describe('S47.5 inline icons', () => {
  it('aligns inline icons by one shared rule: -0.125em, -0.075em in 11–12 px text', () => {
    expect(S475).toMatch(/> svg \{\s+vertical-align: -0\.125em;\s+\}/);
    expect(S475).toMatch(/\.ai-hint[^{]*svg \{\s+vertical-align: -0\.075em;\s+\}/);
    expect(ruleWith(S475, '.inline-alert > svg').body).toMatch(/height: 1lh;/);
  });

  it('has no per-component icon nudges left', () => {
    const sheets = readdirSync(RENDERER, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'));
    const nudge = /svg[^{}]*\{[^}]*(margin-top|top|margin-block-start):\s*-?[1-4]px/;
    for (const file of sheets) expect(css(file).replace(/\/\*[\s\S]*?\*\//g, ''), file).not.toMatch(nudge);
    const verticals = sheets.flatMap((file) =>
      [...css(file).matchAll(/vertical-align:\s*([^;]+);/g)].map((m) => `${file}: ${m[1]}`),
    );
    expect(verticals.filter((v) => !/motion\.css|middle/.test(v))).toEqual([]);
  });
});

describe('S47.5 font stacks', () => {
  it('names PingFang SC and Microsoft YaHei in the UI and the code stacks', () => {
    const root = css('styles.css');
    const stack = (name: string) => root.match(new RegExp(`${name}:([^;]+);`))?.[1] ?? '';
    for (const name of ['--font-ui', '--font-code']) {
      expect(stack(name)).toContain("'PingFang SC'");
      expect(stack(name)).toContain("'Microsoft YaHei'");
    }
    // After the UI / code face, before the generic family.
    expect(stack('--font-ui').indexOf("'Segoe UI'")).toBeLessThan(stack('--font-ui').indexOf("'PingFang SC'"));
    expect(stack('--font-code').indexOf('Consolas')).toBeLessThan(stack('--font-code').indexOf("'Microsoft YaHei'"));
    expect(stack('--font-code').trim().endsWith('monospace')).toBe(true);
  });
});
