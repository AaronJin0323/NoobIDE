import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S46 calm design language (docs/product/calm-design-spec.md, decision 0034): every stylesheet of the renderer uses
 * the shared shape, type, elevation and colour tokens, so the look cannot drift back to one-off radii, bold 12 px
 * text, stacked shadows, gradients and literal colours. Custom-property definitions are the token source and are only
 * checked for removed names; @keyframes blocks are skipped (overlay motion may scale, decision 0029).
 * S47.1: motion uses the --dur-* / --ease-* tokens of styles.css :root; no transition or animation declaration
 * carries a literal duration or curve, and only the reduced-motion gate redefines a duration token (to 0ms).
 */
const RENDERER = path.dirname(fileURLToPath(import.meta.url));

const REMOVED = [
  '--material-chrome',
  '--material-hairline',
  '--shadow-chrome',
  '--shadow-panel',
  '--shadow-prominent',
  '--radius-rail',
  '--radius-rail-item',
  '--radius-menu',
  '--radius-menu-item',
  '--radius-field',
  '--ambient-a',
  '--ambient-b',
  '--glass-chrome',
  '--glass-chrome-solid',
  '--glass-highlight',
  '--border',
];

const RADIUS = /^(0|50%|inherit|var\(--radius-(sm|control|panel|sheet|capsule)\))$/;
const FONT_SIZE = /^(inherit|[\d.]+em|[\d.]+%|var\(--text-(xs|sm|md|lg|xl|2xl)\))$/;
const FONT_WEIGHT = /^(400|500|600|normal|inherit|var\(--weight-(regular|medium|strong)\))$/;
const SHADOW_PART =
  /^(none|var\(--(shadow|ring)-[a-z-]+\)|(inset\s+)?0\s+0\s+0\s+[\d.]+px\s+(var\(--[a-z-]+\)|Highlight|CanvasText|ButtonText|transparent|currentColor))$/;
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i;
const NAMED_COLOUR = /(^|[\s,(])(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|silver)(?=$|[\s,)])/i;
const MOTION_PROP = /^(-webkit-)?(transition|animation)(-|$)/;
const LITERAL_DURATION = /(^|[\s,(])[+-]?(\d*\.)?\d+m?s(?=$|[\s,)])/;
// `linear` alone stays allowed: it is the identity curve that scroll-driven timelines need.
const LITERAL_CURVE =
  /\b(cubic-bezier|linear|steps)\(|(^|[\s,])(ease|ease-in|ease-out|ease-in-out|step-start|step-end)(?=$|[\s,])/;
const MOTION_TOKEN = /^--(dur|ease)-/;
/** The stylesheet whose :root block is the source of the motion tokens. */
const TOKEN_SHEET = 'styles.css';
const COLOUR_PROP =
  /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|fill|stroke|caret-color|text-decoration(-color)?|accent-color|box-shadow)$/;

interface Declaration {
  file: string;
  line: number;
  prop: string;
  value: string;
}

/** Splits a value on commas that are not inside parentheses. */
function splitTop(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

/** Declarations of a stylesheet, without comments and @keyframes blocks. */
export function declarations(file: string, css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out: Declaration[] = [];
  let buf = '';
  let line = 1;
  let bufLine = 1;
  let skipDepth = 0; // > 0 while inside @keyframes
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') {
      depth++;
      if (skipDepth === 0 && /^@keyframes\b/.test(buf.trim())) skipDepth = depth;
      buf = '';
      bufLine = line;
    } else if (ch === '}' || ch === ';') {
      const decl = buf.trim();
      if (skipDepth === 0 && decl.includes(':')) {
        const i = decl.indexOf(':');
        out.push({ file, line: bufLine, prop: decl.slice(0, i).trim(), value: decl.slice(i + 1).trim() });
      }
      if (ch === '}') {
        if (skipDepth === depth) skipDepth = 0;
        depth--;
      }
      buf = '';
      bufLine = line;
    } else {
      if (buf.trim() === '' && ch.trim() !== '') bufLine = line;
      buf += ch;
    }
    if (ch === '\n') line++;
  }
  return out;
}

export function violations(decls: readonly Declaration[]): string[] {
  const bad: string[] = [];
  for (const { file, line, prop, value } of decls) {
    const where = `${file}:${line} ${prop}: ${value}`;
    const v = value.replace(/\s*!important$/, '');
    for (const name of REMOVED) {
      if (prop === name || new RegExp(`var\\(${name}[,)]`).test(v)) bad.push(`${where} — removed token ${name}`);
    }
    if (MOTION_TOKEN.test(prop) && file !== TOKEN_SHEET && !(prop.startsWith('--dur-') && v === '0ms'))
      bad.push(`${where} — motion tokens are defined in ${TOKEN_SHEET} :root (only the reduced-motion gate sets 0ms)`);
    if (prop.startsWith('--')) continue;
    if (MOTION_PROP.test(prop) && LITERAL_DURATION.test(v))
      bad.push(`${where} — literal duration; use a --dur-* token`);
    if (MOTION_PROP.test(prop) && LITERAL_CURVE.test(v)) bad.push(`${where} — literal curve; use an --ease-* token`);
    const mask = /^(-webkit-)?mask/.test(prop);
    if (/radius$/.test(prop) && !v.split(/\s+|\//).every((t) => t === '' || RADIUS.test(t)))
      bad.push(`${where} — radius must be a --radius-* token`);
    if (!mask && /gradient\(/.test(v)) bad.push(`${where} — no gradients outside masks`);
    if (prop === 'font-size' && !FONT_SIZE.test(v)) bad.push(`${where} — font-size must be a --text-* token`);
    if (prop === 'font' && v !== 'inherit' && !/var\(--text-(xs|sm|md|lg|xl|2xl)\)/.test(v))
      bad.push(`${where} — font shorthand must use a --text-* token`);
    if (prop === 'font-weight' && !FONT_WEIGHT.test(v)) bad.push(`${where} — font-weight must be 400/500/600`);
    if (prop === 'box-shadow' && !splitTop(v).every((p) => SHADOW_PART.test(p)))
      bad.push(`${where} — box-shadow must be none, a --shadow-*/--ring-* token or a plain ring`);
    if (!mask && LITERAL_COLOUR.test(v)) bad.push(`${where} — literal colour; use a token`);
    if (!mask && COLOUR_PROP.test(prop) && NAMED_COLOUR.test(v)) bad.push(`${where} — named colour; use a token`);
    if (/^(border|outline|text-decoration|column-rule)/.test(prop) && /\bdashed\b/.test(v))
      bad.push(`${where} — no dashed lines`);
    if (/^(-webkit-)?(backdrop-)?filter$/.test(prop) && /brightness\(|drop-shadow\(/.test(v))
      bad.push(`${where} — no brightness or drop-shadow filters`);
    if (prop === 'text-shadow' && v !== 'none') bad.push(`${where} — no text shadows`);
    if (prop === 'font' && /(^|\s)(bold|bolder|lighter|[1-9]00)(\s|$)/.test(v) && !/(^|\s)(400|500|600)(\s|$)/.test(v))
      bad.push(`${where} — font shorthand weight must be 400/500/600`);
    if (prop === 'outline' && /^(none|0)$/.test(v))
      bad.push(`${where} — hide outlines with outline-color: transparent (forced colours)`);
    if ((prop === 'transform' || prop === 'scale') && (/scale\(/.test(v) || prop === 'scale'))
      bad.push(`${where} — controls do not scale`);
  }
  return bad;
}

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.css'))
    .map((f) => path.join(dir, f))
    .sort();
}

describe('calm design rules (S46)', () => {
  it('parses declarations and skips comments and keyframes', () => {
    const css = '/* a: b; */\n.x:hover { color: var(--text); }\n@keyframes k { from { transform: scale(0.9); } }';
    expect(declarations('t.css', css)).toEqual([{ file: 't.css', line: 2, prop: 'color', value: 'var(--text)' }]);
  });

  it('flags each kind of violation', () => {
    const css = `.a { border-radius: 7px; font-size: 12px; font-weight: 700; box-shadow: 0 4px 8px black;
      color: #fff; background: linear-gradient(red, blue); outline: 1px dashed var(--line);
      filter: brightness(1.1); transform: scale(0.96); border: 1px solid var(--border); }`;
    // 10 rules, plus the named colours in the shadow and the gradient.
    expect(violations(declarations('t.css', css))).toHaveLength(12);
    const more = `.b { color: white; text-shadow: 0 1px 0 x; font: 700 var(--text-md)/1 x; outline: none;
      text-decoration: underline dashed; -webkit-filter: drop-shadow(0 0 1px x); }`;
    expect(violations(declarations('t.css', more))).toHaveLength(6);
    const ok = `.a { border-radius: var(--radius-control) 0 0 var(--radius-control); font: var(--text-md)/1.5 x;
      font-weight: 500; box-shadow: var(--shadow-overlay), inset 0 0 0 1px var(--accent-rim);
      color: color-mix(in srgb, var(--text) 50%, transparent); mask-image: linear-gradient(#000, transparent); }`;
    expect(violations(declarations('t.css', ok))).toEqual([]);
  });

  it('flags literal motion and stray motion tokens (S47.1)', () => {
    const css = `.a { transition: transform 0.1s; animation: k 200ms cubic-bezier(0.2, 0, 0, 1) both;
      transition-duration: var(--dur-fast), 1s; transition-timing-function: ease-in-out; animation-delay: 30ms;
      animation-timing-function: linear(0, 1); transition: color var(--dur-fast) ease; --dur-fast: 100ms;
      --ease-swift: ease; }`;
    // 0.1s; 200ms + cubic-bezier; 1s; ease-in-out; 30ms; linear(); ease; two stray tokens.
    expect(violations(declarations('t.css', css))).toHaveLength(10);
    const ok = `.a { transition: transform var(--dur-fast) var(--ease-swift), color var(--dur-base) var(--ease-out);
      animation: scroll-edge-reveal linear both; animation-range: 0 32px; transition: none; --dur-base: 0ms;
      animation-duration: var(--dur-fast); width: 0.5s; }`;
    expect(violations(declarations('t.css', ok))).toEqual([]);
    expect(violations(declarations(TOKEN_SHEET, ':root { --dur-slow: 450ms; --ease-enter: ease; }'))).toEqual([]);
  });

  it(`defines the motion tokens only in the :root block of ${TOKEN_SHEET} (S47.1)`, () => {
    const css = readFileSync(path.join(RENDERER, TOKEN_SHEET), 'utf8');
    const start = css.indexOf(':root {');
    const root = css.slice(start, css.indexOf('\n}\n', start));
    const all = declarations(TOKEN_SHEET, css).filter((d) => MOTION_TOKEN.test(d.prop));
    const inRoot = declarations(TOKEN_SHEET, root).filter((d) => MOTION_TOKEN.test(d.prop));
    expect(inRoot.map((d) => d.prop)).toEqual(
      expect.arrayContaining(['--dur-instant', '--dur-fast', '--dur-base', '--dur-sheet', '--dur-slow']),
    );
    expect(inRoot.map((d) => d.prop)).toEqual(
      expect.arrayContaining(['--ease-swift', '--ease-expand', '--ease-enter']),
    );
    expect(declarations(TOKEN_SHEET, root).find((d) => d.prop === '--dur-instant')?.value).toBe('60ms');
    expect(declarations(TOKEN_SHEET, root).find((d) => d.prop === '--dur-slow')?.value).toBe('450ms');
    expect(all).toHaveLength(inRoot.length);
  });

  const files = stylesheets(RENDERER);
  it('finds the stylesheets', () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  it.each(files.map((f) => [path.relative(RENDERER, f).replaceAll('\\', '/'), f]))('%s', (name, file) => {
    expect(violations(declarations(name, readFileSync(file, 'utf8')))).toEqual([]);
  });
});
