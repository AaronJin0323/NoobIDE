import { describe, expect, it } from 'vitest';
import { MAX_SHOWN_PATH, escapeHtml, notFoundPageHtml, shownRequestPath } from './not-found-page';

describe('the missing-page page of the preview server', () => {
  it('escapes everything HTML could interpret', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('shows the requested path decoded, without query, fragment or control characters, and bounded', () => {
    expect(shownRequestPath('/about.html?x=1#top')).toBe('about.html');
    expect(shownRequestPath('/%E9%A1%B5%E9%9D%A2/%E5%85%B3%E4%BA%8E%20%E6%88%91.html')).toBe('页面/关于 我.html');
    expect(shownRequestPath('/bad%E0%A4%A.html')).toBe('bad%E0%A4%A.html'); // invalid encoding: as sent
    expect(shownRequestPath('/a%0Ab%00c.html')).toBe('abc.html');
    const long = shownRequestPath(`/${'x'.repeat(500)}.html`);
    expect(long).toHaveLength(MAX_SHOWN_PATH + 1);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is written in the interface language (zh-CN and en)', () => {
    const zh = notFoundPageHtml('about.html', 'zh-CN');
    expect(zh).toContain('<html lang="zh-CN">');
    expect(zh).toContain('<title>找不到这个页面</title>');
    expect(zh).toContain('项目里没有 <code>about.html</code> 这个文件');
    expect(zh).toContain('回到入口页面');
    const en = notFoundPageHtml('about.html', 'en');
    expect(en).toContain('<html lang="en">');
    expect(en).toContain('<title>Page not found</title>');
    expect(en).toContain('The project has no file named <code>about.html</code>');
    expect(en).toContain('Back to entry page');
  });

  it('never lets the path (or the messages) add markup or scripts', () => {
    const html = notFoundPageHtml('<script>alert(1)</script>$&$1.html', 'en');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;$&amp;$1.html');
    // The message's own example markup is text too.
    expect(html).toContain('&lt;a href=&quot;…&quot;&gt;');
  });
});
