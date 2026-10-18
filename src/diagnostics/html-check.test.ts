import { describe, expect, it } from 'vitest';
import { checkHtml, unclosedMessage } from './html-check';
import { explain } from './rules';
import { createProblemRecord } from '../shared/problem';

const tags = (html: string) => checkHtml(html).map((f) => `${f.tagName}@${f.line}:${f.column}`);

describe('HTML unclosed-element check (S19.2)', () => {
  it('reports every stray closing tag over a deep stack of open elements', () => {
    // 30 000 open <div> and 30 000 stray </b> (≈ 270 kB): each stray used to scan the whole stack (seconds). The time
    // budget is in tests/perf/diagnostics-linear.perf.test.ts (S58.8, ADR 0038).
    const html = `${'<div>'.repeat(30_000)}${'</b>'.repeat(30_000)}`;
    const found = checkHtml(html);
    expect(found).toHaveLength(30_000);
  });

  it('reports an element that is never closed, at its tag name', () => {
    const html = '<body>\n  <div class="card">\n    <h1>Hi</h1>\n</body>\n';
    expect(checkHtml(html)).toEqual([
      {
        code: 'html-unclosed-tag',
        tagName: 'div',
        line: 2,
        column: 4,
        endColumn: 7,
        message: 'Unclosed element `div`.',
      },
    ]);
  });

  it('accepts well-formed documents, void elements, self-closing tags and optional end tags', () => {
    const html = [
      '<!doctype html>',
      '<html lang="zh-CN"><head><meta charset="utf-8"><title>a < b</title>',
      '<link rel="stylesheet" href="style.css"></head>',
      '<body>',
      '  <!-- <div> in a comment -->',
      '  <p>One<p>Two',
      '  <ul><li>a<li>b</ul>',
      '  <img src="x.png" alt="<div>"><br><input />',
      '  <svg><path d="M0 0" /></svg>',
      '  <script>if (a < b) { document.write("<div>"); }</script>',
      '  <style>div > p { color: red; }</style>',
      '  <table><tr><td>1<td>2</table>',
      '</body>',
      '</html>',
    ].join('\n');
    expect(tags(html)).toEqual([]);
  });

  it('reports each unclosed element once, in document order', () => {
    expect(tags('<main>\n<section>\n<span>x\n</main>\n')).toEqual(['section@2:2', 'span@3:2']);
    expect(tags('<div><div></div>')).toEqual(['div@1:2']);
  });

  it('ignores stray closing tags and unfinished tags', () => {
    expect(tags('<p>x</p></div>')).toEqual([]);
    expect(tags('<div></div>\n<span class="')).toEqual([]);
  });

  it('feeds the html-unclosed-tag explanation rule (codes the rules expect)', () => {
    const [finding] = checkHtml('<div>\n');
    const record = createProblemRecord({
      source: 'static',
      severity: 'warning',
      projectId: 'p',
      file: 'index.html',
      line: finding?.line ?? 1,
      column: finding?.column ?? 1,
      code: finding?.code ?? '',
      message: finding?.message ?? '',
      data: { tagName: finding?.tagName ?? '' },
      at: 0,
    });
    expect(explain(record).ruleId).toBe('html-unclosed-tag');
    expect(unclosedMessage('div')).toBe('Unclosed element `div`.');
  });
});
