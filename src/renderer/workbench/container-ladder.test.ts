import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S49.6: the container-query ladder lives in navigation.css. These checks pin its shape (named containers, the four
 * tiers per container, the field cap) and the hit-box arithmetic (32px border box, the same amount taken back by a
 * negative margin-block, so the visual row does not grow). The layout itself is tests/e2e/container-ladder.spec.ts.
 */
const CSS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'navigation.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Top-level and nested `selector { body }` blocks, flattened (good enough for this file's simple rules). */
function rules(css: string): { selector: string; body: string; container: string | null }[] {
  const out: { selector: string; body: string; container: string | null }[] = [];
  const at = /@container\s+([\w-]+)\s*\(([^)]*)\)\s*\{/g;
  let rest = css;
  let match: RegExpExecArray | null;
  // Pull out @container blocks first (balanced braces), then parse what is left as plain rules.
  while ((match = at.exec(rest))) {
    let depth = 1;
    let i = at.lastIndex;
    while (depth > 0 && i < rest.length) {
      if (rest[i] === '{') depth += 1;
      if (rest[i] === '}') depth -= 1;
      i += 1;
    }
    const inner = rest.slice(at.lastIndex, i - 1);
    for (const r of plain(inner)) out.push({ ...r, container: `${match[1]} (${match[2]?.trim()})` });
    rest = rest.slice(0, match.index) + rest.slice(i);
    at.lastIndex = match.index;
  }
  for (const r of plain(rest)) out.push({ ...r, container: null });
  return out;
}

function plain(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
}

const prop = (body: string, name: string) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

describe('container-query ladder (S49.6)', () => {
  const all = rules(CSS);

  it('names the preview toolbar rows and the composer chin as inline-size containers', () => {
    const named = all.filter((r) => r.container === null && prop(r.body, 'container'));
    expect(named.map((r) => [r.selector.replace(/\s+/g, ' '), prop(r.body, 'container')])).toEqual([
      ['.preview-header, .preview-toolbar', 'preview-toolbar / inline-size'],
      ['.ai-composer-row', 'composer-chin / inline-size'],
    ]);
  });

  it('has the three narrowing tiers below the full >= 576px row (the preview rows start at < 384px)', () => {
    const expected: Record<string, string[]> = {
      'preview-toolbar': ['preview-toolbar (width < 384px)', 'preview-toolbar (width < 320px)'],
      'composer-chin': [
        'composer-chin (width < 480px)',
        'composer-chin (width < 384px)',
        'composer-chin (width < 320px)',
      ],
    };
    for (const name of ['preview-toolbar', 'composer-chin']) {
      const tiers = [...new Set(all.filter((r) => r.container?.startsWith(name)).map((r) => r.container))];
      expect(tiers, name).toEqual(expected[name]);
    }
    // Nothing is hidden at 480px and wider: the full tier is the default.
    expect(all.some((r) => /width\s*[<>]=?\s*(5\d\d|[6-9]\d\d)px/.test(r.container ?? ''))).toBe(false);
  });

  it('< 480px hides the keyboard hint, never a preview action; < 384px goes icon-only with 4rem labels', () => {
    const at = (tier: string) => all.filter((r) => r.container?.endsWith(`(width < ${tier})`));
    const hidden = at('480px').filter((r) => prop(r.body, 'display') === 'none');
    expect(hidden.map((r) => r.selector)).toEqual(['.ai-hint']);
    // Nothing in the preview rows is ever display:none (each button is the only visible way to its action).
    expect(all.filter((r) => r.container?.startsWith('preview-toolbar') && prop(r.body, 'display') === 'none')).toEqual(
      [],
    );
    const narrow = at('384px');
    expect(narrow.filter((r) => r.selector === '.cq-label' && prop(r.body, 'clip-path') === 'inset(50%)')).toHaveLength(
      2,
    );
    expect(
      narrow.filter((r) => prop(r.body, 'max-width') === '4rem' && prop(r.body, 'text-overflow') === 'ellipsis'),
    ).toHaveLength(2);
  });

  it('< 320px uses 4px padding and caps fields at max(6rem, 100cqw - 4rem)', () => {
    const tiny = all.filter((r) => r.container?.endsWith('(width < 320px)'));
    expect(tiny.filter((r) => prop(r.body, 'padding-inline') === '4px').length).toBeGreaterThanOrEqual(2);
    expect(tiny.filter((r) => prop(r.body, 'max-width') === 'max(6rem, calc(100cqw - 4rem))')).toHaveLength(2);
  });

  it('every compensated control is 32px tall and gives the extra back with a negative margin-block', () => {
    const compensated = all.filter((r) => r.container === null && prop(r.body, 'margin-block')?.startsWith('-'));
    expect(compensated.length).toBeGreaterThanOrEqual(4);
    for (const r of compensated) {
      const pull = Number(/^-(\d+)px$/.exec(prop(r.body, 'margin-block') ?? '')?.[1]);
      expect(prop(r.body, 'height'), r.selector).toBe('32px');
      // The transparent block borders are exactly what the margin takes back: the visual row is 32 - 2 × pull.
      const border = prop(r.body, 'border-block') ?? prop(r.body, 'border-width');
      expect(border, r.selector).toMatch(new RegExp(`^${pull}px( solid transparent| 0)$`));
      expect(prop(r.body, 'background-clip'), r.selector).toBe('padding-box');
      expect(32 - 2 * pull, r.selector).toBeLessThanOrEqual(28);
    }
  });
});
