import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { citedCaseIds, cursorOf, parseCases } from './capability-cases';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const suite = JSON.parse(readFileSync(path.join(repoRoot, 'tests/fixtures/lang-capabilities/cases.json'), 'utf8'));

describe('capability case format (S18.1, S18.2)', () => {
  it('finds the cursor marker', () => {
    expect(cursorOf('ab|c')).toEqual({ text: 'abc', line: 1, column: 3 });
    expect(cursorOf('a\n  bo|\n')).toEqual({ text: 'a\n  bo\n', line: 2, column: 5 });
  });

  it('rejects malformed cases', () => {
    expect(() => parseCases({})).toThrow(/cases/);
    expect(() =>
      parseCases({ cases: [{ id: 'x-y', language: 'html', kind: 'completion', text: 'no cursor', expect: ['a'] }] }),
    ).toThrow(/cursor/);
    expect(() =>
      parseCases({ cases: [{ id: 'x-y', language: 'php', kind: 'hover', text: '|', expect: ['a'] }] }),
    ).toThrow(/language/);
    const ok = { id: 'x-y', language: 'css', kind: 'hover', text: '|', expect: ['a'] };
    expect(() => parseCases({ cases: [ok, ok] })).toThrow(/duplicate/);
  });

  it('the suite in tests/fixtures/lang-capabilities is valid and covers HTML, CSS and JavaScript', () => {
    const cases = parseCases(suite);
    for (const language of ['html', 'css', 'javascript'])
      for (const kind of ['completion', 'hover'])
        expect(
          cases.some((c) => c.language === language && c.kind === kind),
          `${language} ${kind}`,
        ).toBe(true);
  });
});

describe('docs/capabilities.md lists only validated capabilities (S18.2)', () => {
  const doc = readFileSync(path.join(repoRoot, 'docs/capabilities.md'), 'utf8');
  const cited = citedCaseIds(doc);
  const ids = new Set(parseCases(suite).map((c) => c.id));

  it('cites at least one case per row and only case ids the suite contains', () => {
    expect(cited.length).toBeGreaterThanOrEqual(10);
    expect(cited.filter((id) => !ids.has(id))).toEqual([]);
  });

  it('every capability row names its case', () => {
    const rows = doc
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line) && !/^\|\s*Capability/.test(line));
    for (const row of rows) expect(citedCaseIds(row).length, row).toBeGreaterThan(0);
  });
});

describe('citedCaseIds', () => {
  it('reads case ids from table rows only', () => {
    expect(citedCaseIds('`not-a-row`\n| a | `html-tag-completion` |\n| `not-last-cell` | `css-x`, `js-y-z` |')).toEqual(
      ['html-tag-completion', 'css-x', 'js-y-z'],
    );
  });
});
