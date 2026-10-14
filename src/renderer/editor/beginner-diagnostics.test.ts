/**
 * S19.2 fixture proof outside the app: the static-diagnostics fixtures really contain the noise the tuning removes.
 * Type-checks tests/fixtures/static-diagnostics/*.js with the TypeScript compiler (checkJs, DOM typings — what the
 * editor's JavaScript service does) and compares the raw diagnostics with what is left after NOISY_TS_CODES.
 * The workbench e2e (tests/e2e/problems.spec.ts) checks the same fixtures in the real editor.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { KEPT_TS_CODES, NOISY_TS_CODES } from './language-config';

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/static-diagnostics',
);

function diagnose(file: string): { line: number; code: number }[] {
  const fileName = path.join(fixtures, file);
  const program = ts.createProgram([fileName], {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    strict: false,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
  });
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`fixture not found: ${file}`);
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .map((d) => ({ line: source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, code: d.code }))
    .sort((a, b) => a.line - b.line || a.code - b.code);
}

const kept = (list: { line: number; code: number }[]) => list.filter((d) => !NOISY_TS_CODES.includes(d.code));

describe('beginner-tuned JavaScript diagnostics (S19.2)', () => {
  it('noisy.js: plain browser code that type checking flags on many lines; only the control mistake is kept', () => {
    const raw = diagnose('noisy.js');
    const noise = raw.filter((d) => NOISY_TS_CODES.includes(d.code));
    // The fixture has teeth: without the tuning a beginner would see this many false alarms.
    expect(noise.length).toBeGreaterThanOrEqual(6);
    expect(new Set(noise.map((d) => d.code)).size).toBeGreaterThanOrEqual(5);
    expect(kept(raw)).toEqual([{ line: 20, code: 2304 }]);
  });

  it('errors.js: undefined names and syntax errors are all kept', () => {
    const raw = diagnose('errors.js');
    expect(kept(raw)).toEqual(raw);
    const codes = raw.map((d) => d.code);
    expect(codes).toEqual(expect.arrayContaining([2552, 2304, 1005]));
    for (const code of codes) expect(code < 2000 || KEPT_TS_CODES.includes(code)).toBe(true);
  });

  it('the template script stays quiet', () => {
    expect(kept(diagnose('template.js'))).toEqual([]);
  });
});
