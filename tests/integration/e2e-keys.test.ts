// S58.7 — document start/end in E2E specs go through tests/e2e/keys.ts, never a literal chord.
//
// Monaco binds Ctrl+Home / Ctrl+End only on Windows and Linux; on macOS it binds ⌘↑ / ⌘↓ and leaves ⌘Home / ⌘End
// unbound, so Playwright's `ControlOrMeta+Home` moves nothing inside the editor there. A spec that presses the literal
// passes on a Mac only while its cursor already sits where it wanted to go (run 39033368439 caught two that did not:
// authoring.spec.ts and authoring-offline.spec.ts typed into the middle of `</body>`). DOC_START / DOC_END pick the
// chord Monaco binds on the running platform. This guard reads every TypeScript file under tests/e2e and fails, naming
// the file and line, when any of them spells the chord out — `ControlOrMeta`, `Control` or `Meta` with `Home` or
// `End` — so the mistake cannot come back. keys.ts itself is the one place allowed to mention the chords.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_END, DOC_START } from '../e2e/keys';

const root = path.resolve(__dirname, '../..');
const E2E_DIR = path.join(root, 'tests/e2e');
const ALLOWED = new Set(['keys.ts']);

/** Every editor-bound document start/end chord written as a Playwright key literal. */
const FORBIDDEN_CHORD = /\b(?:ControlOrMeta|Control|Meta)\+(?:Home|End)\b/g;

/** All `.ts` files under tests/e2e (specs and helpers), as paths relative to tests/e2e with `/` separators. */
function listTypeScriptFiles(dir = E2E_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listTypeScriptFiles(full, relative));
    else if (name.endsWith('.ts')) out.push(relative);
  }
  return out;
}

/** `file:line: text` for every forbidden chord in `source`. */
export function findLiteralChords(file: string, source: string): string[] {
  const hits: string[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(FORBIDDEN_CHORD)) {
      hits.push(`${file}:${index + 1}: ${match[0]} (use DOC_START / DOC_END from tests/e2e/keys.ts)`);
    }
  });
  return hits;
}

describe('tests/e2e/keys.ts is the only place that spells out the document start/end chords', () => {
  it('finds a literal chord in a spec and reports it with file and line', () => {
    const source = [
      "import { expect, test } from '@playwright/test';",
      "await page.keyboard.press('ControlOrMeta+Home');",
      'await page.keyboard.press("ControlOrMeta+End");',
      "await page.keyboard.press('Control+End'); // Windows only",
      "await page.keyboard.press('Meta+Home');",
      "await page.keyboard.press('Home'); // the line start: fine, it is the same key everywhere",
      "await input.press('End');",
      'await page.keyboard.press(DOC_START);',
    ].join('\n');
    expect(findLiteralChords('x.spec.ts', source)).toEqual([
      'x.spec.ts:2: ControlOrMeta+Home (use DOC_START / DOC_END from tests/e2e/keys.ts)',
      'x.spec.ts:3: ControlOrMeta+End (use DOC_START / DOC_END from tests/e2e/keys.ts)',
      'x.spec.ts:4: Control+End (use DOC_START / DOC_END from tests/e2e/keys.ts)',
      'x.spec.ts:5: Meta+Home (use DOC_START / DOC_END from tests/e2e/keys.ts)',
    ]);
  });

  it('keys.ts exports the chords Monaco binds on this platform', () => {
    // A Playwright chord: modifiers joined by `+`, the key last. Never the macOS-unbound Home/End with a modifier.
    expect(DOC_START).toMatch(/^(Control\+Home|Meta\+ArrowUp)$/);
    expect(DOC_END).toMatch(/^(Control\+End|Meta\+ArrowDown)$/);
    expect(DOC_START.startsWith('Meta')).toBe(DOC_END.startsWith('Meta'));
  });

  it('no spec or helper under tests/e2e presses a literal document start/end chord', () => {
    const files = listTypeScriptFiles();
    expect(files).toContain('keys.ts');
    expect(files.length).toBeGreaterThan(40); // the whole suite was really scanned, specs and helpers alike
    const hits = files
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => findLiteralChords(file, readFileSync(path.join(E2E_DIR, file), 'utf8')));
    expect(hits, `literal document start/end chords in tests/e2e:\n${hits.join('\n')}`).toEqual([]);
  });
});
