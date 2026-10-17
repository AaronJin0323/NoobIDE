import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown } from './md-parse';
import { Markdown, type MarkdownLabels } from './Markdown';

const labels: MarkdownLabels = {
  copy: '复制代码',
  copied: '已复制',
  copyFailed: '复制失败',
  codeCaption: (lang) => (lang ? `代码（${lang}）` : '代码'),
};
const html = (source: string) => renderToStaticMarkup(createElement(Markdown, { source, labels }));

describe('Markdown subset parser (S33.1)', () => {
  it('parses paragraphs, headings, lists, quotes, rules and fenced code', () => {
    const blocks = parseMarkdown(
      '# 标题\n\n第一段\n第二行\n\n- 一\n- 二\n  续行\n\n3. 三\n4. 四\n\n> 引用\n\n---\n\n```js\nlet a = 1;\n\nlet b;\n```\n尾巴',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'quote',
      'rule',
      'code',
      'paragraph',
    ]);
    expect(blocks[1]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: '第一段\n第二行' }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: '一' }], [{ text: '二\n续行' }]] });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[6]).toEqual({ type: 'code', lang: 'js', file: '', text: 'let a = 1;\n\nlet b;', closed: true });
  });

  it('treats an unclosed fence as code that is still arriving', () => {
    expect(parseMarkdown('看：\n```html\n<p>半')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '看：' }] },
      { type: 'code', lang: 'html', file: '', text: '<p>半', closed: false },
    ]);
  });

  it('parses inline code, bold, italic, links and escapes', () => {
    expect(parseInline('用 `let` 和 **加粗 `x`** 以及 *斜体* 和 _也是_')).toEqual([
      { type: 'text', text: '用 ' },
      { type: 'code', text: 'let' },
      { type: 'text', text: ' 和 ' },
      {
        type: 'strong',
        children: [
          { type: 'text', text: '加粗 ' },
          { type: 'code', text: 'x' },
        ],
      },
      { type: 'text', text: ' 以及 ' },
      { type: 'em', children: [{ type: 'text', text: '斜体' }] },
      { type: 'text', text: ' 和 ' },
      { type: 'em', children: [{ type: 'text', text: '也是' }] },
    ]);
    expect(parseInline('[MDN](https://developer.mozilla.org/)')).toEqual([
      { type: 'link', children: [{ type: 'text', text: 'MDN' }], url: 'https://developer.mozilla.org/' },
    ]);
    expect(inlineText(parseInline('\\*不是斜体\\* a*b c 2 * 3 snake_case_name'))).toBe(
      '*不是斜体* a*b c 2 * 3 snake_case_name',
    );
    expect(parseInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
    expect(parseInline('`未闭合')).toEqual([{ type: 'text', text: '`未闭合' }]);
  });
});

describe('Markdown rendering is safe (S33.1, decision 0025)', () => {
  it('never turns model output into HTML', () => {
    const out = html(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n**<b>粗</b>**\n\n```html\n<iframe src="javascript:alert(3)"></iframe>\n```',
    );
    expect(out).not.toMatch(/<script|<img|<iframe|<b>/);
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;');
    expect(out).toContain('&lt;iframe src=&quot;javascript:alert(3)&quot;&gt;&lt;/iframe&gt;');
  });

  it('shows links as text with their address, never as live links', () => {
    const out = html('看 [这里](javascript:alert(1)) 和 <https://example.com/a>');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('href');
    expect(out).toContain('这里');
    expect(out).toContain('(javascript:alert(1))');
    expect(out).toContain('https://example.com/a');
  });

  it('renders code blocks with their language and a copy button', () => {
    const out = html('```css\nh1 { color: red; }\n```');
    expect(out).toContain('代码（css）');
    expect(out).toContain('data-testid="md-copy"');
    expect(out).toContain('复制代码');
    expect(out).toContain('<pre tabindex="0"><code>h1 { color: red; }</code></pre>');
  });

  it('renders lists, headings below the panel heading, and emphasis', () => {
    const out = html('## 步骤\n\n1. **先**保存\n2. 再*刷新*');
    expect(out).toContain('<h4 class="md-heading">步骤</h4>');
    expect(out).toContain('<ol start="1"><li><strong>先</strong>保存</li><li>再<em>刷新</em></li></ol>');
  });
});
