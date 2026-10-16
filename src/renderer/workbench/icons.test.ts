import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as ai from '../ai/ai-icons';
import * as problems from '../problems/problem-icons';
import * as wb from './icons';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SIZES = [14, 16, 18, 32];
/** Filled / illustration glyphs that are not outline icons. */
const NOT_OUTLINE = new Set(['SeverityIcon', 'SaveStateIcon', 'NoobIdeLogo', 'NoobIdeMark', 'DotIcon', 'MoreIcon']);

type Factory = (props: Record<string, unknown>) => ReactElement;

function outlineIcons(): [string, ReactElement][] {
  const out: [string, ReactElement][] = [];
  for (const [prefix, mod] of [
    ['wb', wb],
    ['ai', ai],
    ['problems', problems],
  ] as const) {
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || !/Icon$/.test(name) || NOT_OUTLINE.has(name)) continue;
      const make = value as unknown as Factory;
      if (name === 'TreeFolderIcon') {
        out.push([`${prefix}.${name}(open)`, createElement(make, { open: true })]);
        out.push([`${prefix}.${name}(closed)`, createElement(make, { open: false })]);
      } else {
        out.push([`${prefix}.${name}`, createElement(make, {})]);
      }
    }
  }
  // Icons with a size prop, at each size their call sites use (CSS never resizes them, spec: Icons).
  for (const size of [14, 16, 18]) {
    out.push([`ai.AiIcon(${size})`, createElement(ai.AiIcon, { size })]);
    out.push([`ai.ExplainIcon(${size})`, createElement(ai.ExplainIcon, { size })]);
  }
  for (const severity of ['error', 'warning', 'info'] as const) {
    out.push([`problems.SeverityIcon(${severity})`, createElement(problems.SeverityIcon, { severity })]);
  }
  for (const state of ['clean', 'saved', 'dirty', 'saving', 'failed', 'conflict', 'deleted'] as const) {
    out.push([`wb.SaveStateIcon(${state})`, createElement(wb.SaveStateIcon, { state })]);
  }
  return out;
}

describe('icon system: one stroke, four sizes', () => {
  const icons = outlineIcons();

  it('covers the outline icons', () => {
    expect(icons.length).toBeGreaterThan(25);
  });

  for (const [name, element] of icons) {
    it(`${name} uses an allowed size and a ~1.5px effective stroke`, () => {
      const html = renderToStaticMarkup(element);
      const attr = (n: string) => new RegExp(`<svg[^>]*? ${n}="([^"]+)"`).exec(html)?.[1];
      expect(html).toContain('aria-hidden="true"');
      const size = Number(attr('width'));
      expect(Number(attr('height'))).toBe(size);
      const strokeWidth = attr('stroke-width');
      if (strokeWidth === undefined) {
        // Filled glyphs (dirty dot) carry no stroke at all.
        expect(html).toContain('fill="currentColor"');
        return;
      }
      const nonScaling = html.includes('non-scaling-stroke');
      const effective = nonScaling ? Number(strokeWidth) : (Number(strokeWidth) * size) / 16;
      expect(SIZES).toContain(size);
      expect(Math.abs(effective - 1.5)).toBeLessThanOrEqual(0.05);
    });
  }
});

/** S46.7: glyphs that used to be inline <svg> in components and now come from icons.tsx. */
const MOVED = ['PlayIcon', 'RefreshIcon', 'PencilIcon', 'ListIcon', 'CheckIcon', 'ApproximateIcon', 'NoticeIcon'];

/**
 * Components draw no inline <svg>: glyphs come from workbench/icons.tsx or ai/ai-icons.tsx (calm design spec,
 * Amendments). Exceptions are listed here with their reason.
 */
const INLINE_SVG_ALLOWED: Record<string, string> = {
  'workbench/icons.tsx': 'the icon module (outline icons, the NoobIDE mark and logo)',
  'ai/ai-icons.tsx': 'the AI icon module',
};

describe('icon sources (S46.7)', () => {
  it('exports the moved glyphs from icons.tsx', () => {
    for (const name of MOVED) expect(typeof (wb as Record<string, unknown>)[name], name).toBe('function');
  });

  it('components contain no inline <svg> outside the icon modules', () => {
    const offenders = readdirSync(RENDERER, { recursive: true, encoding: 'utf8' })
      .map((f) => f.replaceAll('\\', '/'))
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .filter((f) => !(f in INLINE_SVG_ALLOWED))
      .filter((f) => /<svg[\s>]/.test(readFileSync(path.join(RENDERER, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
