/**
 * i18n invariant (S02.5): components must not contain hardcoded UI text. Scans every .tsx file under src/renderer
 * with the TypeScript parser and fails on:
 *   - JSX text containing letters (Latin or CJK), e.g. <p>Files</p> or <p>文件</p>
 *   - string literals in user-visible attributes (title, aria-label, placeholder, alt, …)
 *   - any CJK string literal anywhere in a component file
 * Text must come from the i18n dictionaries via t('key').
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const USER_VISIBLE_ATTRIBUTES = new Set([
  'title',
  'alt',
  'placeholder',
  'label',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
]);
const LETTERS = /[A-Za-z\u3400-\u9fff\uf900-\ufaff]/;
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

export interface Finding {
  line: number;
  text: string;
  kind: 'jsx-text' | 'attribute' | 'cjk-literal';
}

export function findHardcodedUiStrings(source: string, fileName = 'component.tsx'): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const add = (node: ts.Node, text: string, kind: Finding['kind']) =>
    findings.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: text.trim(), kind });

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && LETTERS.test(node.text)) {
      add(node, node.text, 'jsx-text');
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      const literal = ts.isStringLiteral(init)
        ? init
        : ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
          ? init.expression
          : undefined;
      if (literal && USER_VISIBLE_ATTRIBUTES.has(name) && LETTERS.test(literal.text)) {
        add(node, `${name}="${literal.text}"`, 'attribute');
        return;
      }
    } else if (ts.isStringLiteralLike(node) && CJK.test(node.text)) {
      add(node, node.text, 'cjk-literal');
    } else if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteralLike(node.expression)) {
      // {'Some text'} as a child is still hardcoded text.
      if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) {
        if (LETTERS.test(node.expression.text)) add(node, node.expression.text, 'jsx-text');
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function componentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return componentFiles(full);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [full] : [];
  });
}

describe('hardcoded UI string checker', () => {
  it('catches Latin and CJK JSX text, visible attributes and CJK literals', () => {
    const bad = `
      export const A = () => (
        <div title="Open file" aria-label={'打开'}>
          Files
          <span>文件</span>
          {'Save'}
          <input placeholder="Name" />
        </div>
      );
      const label = '保存';`;
    const kinds = findHardcodedUiStrings(bad).map((f) => `${f.kind}:${f.text}`);
    expect(kinds).toEqual([
      'attribute:title="Open file"',
      'attribute:aria-label="打开"',
      'jsx-text:Files',
      'jsx-text:文件',
      'jsx-text:Save',
      'attribute:placeholder="Name"',
      'cjk-literal:保存',
    ]);
  });

  it('allows translated text, technical attributes, punctuation and code identifiers', () => {
    const good = `
      export const B = ({ t }) => (
        <section className="region preview" data-testid="region-preview" role="tab" aria-label={t('region.preview')}>
          {t('preview.placeholder')} · — {count}
          <CodeEditor uri="inmemory://noobide/welcome.html" language="html" />
        </section>
      );`;
    expect(findHardcodedUiStrings(good)).toEqual([]);
  });
});

describe('renderer components contain no hardcoded UI text (i18n invariant)', () => {
  const rendererDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = componentFiles(rendererDir);

  it('finds the component files', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files.map((f) => [path.relative(rendererDir, f), f]))('%s', (_rel, file) => {
    expect(findHardcodedUiStrings(readFileSync(file, 'utf8'), file)).toEqual([]);
  });
});
