import { describe, expect, it } from 'vitest';
import { renderExplanation } from './engine';
import { fixture } from './fixtures';
import { explain } from './index';

const run = (name: string) => {
  const f = fixture(name);
  return explain(f.record, f.ctx);
};
const render = (name: string, locale: 'zh-CN' | 'en' = 'zh-CN') => {
  const f = fixture(name);
  return renderExplanation(locale, f.record, explain(f.record, f.ctx));
};

describe('rule 9: unhandled promise rejection', () => {
  it('explains the missing catch, worded as possible, and keeps the reason in the original', () => {
    const exp = run('unhandled-rejection-error');
    expect(exp.certainty).toBe('possible');
    expect(render('unhandled-rejection-error').original).toBe('Uncaught (in promise) Error: 用户不存在');
    expect(render('unhandled-rejection-error', 'en').checks[0]).toContain('.catch(');
  });
});

describe('rule 10: fetch failures', () => {
  it('"Failed to fetch" (even inside an unhandled rejection) lists possible causes, CORS among them', () => {
    const exp = run('fetch-failed-to-fetch');
    expect(exp.ruleId).toBe('fetch-failed');
    expect(exp.causes.map((c) => c.key)).toEqual(['fetch.cause.cors', 'fetch.cause.offline', 'fetch.cause.serverDown']);
  });

  it('a 404 fetch names the path and status', () => {
    expect(render('fetch-404-resource').title).toBe('请求 data/题目.json 失败了，服务器返回 404。');
    expect(run('fetch-404-resource').causes.map((c) => c.key)).toEqual(['fetch.cause.notFound']);
  });

  it('connection refused on localhost suggests the other server is not running', () => {
    expect(render('fetch-connection-refused', 'en').title).toBe(
      'The request for http://localhost:3000/api/list failed (net::ERR_CONNECTION_REFUSED).',
    );
    expect(run('fetch-connection-refused').causes.map((c) => c.key)).toEqual(['fetch.cause.serverDown']);
  });
});

describe('rule 11: CORS', () => {
  it('is certain, names the URL, and never suggests disabling browser security', () => {
    const exp = run('cors-blocked-fetch');
    expect(exp.certainty).toBe('certain');
    const zh = render('cors-blocked-fetch');
    expect(zh.title).toBe('浏览器阻止了页面读取 https://api.example.com/weather 的数据（CORS）。');
    expect(zh.explanation).toContain('NoobIDE 不会关闭这项安全检查');
    const en = render('cors-blocked-fetch', 'en');
    for (const text of [en.explanation, ...en.checks]) expect(text).not.toMatch(/disable|--disable-web-security/i);
  });
});

describe('rule 12: JSON parse errors', () => {
  it('distinguishes HTML instead of JSON, quotes/commas, undefined, and empty input', () => {
    expect(run('json-got-html').explanation.key).toBe('json.html.explanation');
    expect(run('json-got-html').certainty).toBe('likely');
    expect(run('json-single-quotes').explanation.key).toBe('json.quotes.explanation');
    expect(run('json-undefined').explanation.key).toBe('json.undefined.explanation');
    expect(run('json-empty').explanation.key).toBe('json.empty.explanation');
    expect(render('json-got-html', 'en').title).toBe('This text could not be parsed as JSON.');
  });

  it('JSON errors are not mistaken for bracket syntax errors', () => {
    expect(run('json-empty').ruleId).toBe('json-parse');
  });
});

describe('rule 13: "x is not a function"', () => {
  it('suggests the correctly capitalised DOM method', () => {
    const exp = run('not-a-function-case');
    expect(exp.candidates).toEqual(['getElementById']);
    expect(render('not-a-function-case').explanation).toBe('可能是拼写错误：你想用的可能是 getElementById。');
    expect(run('not-a-function-typo').candidates).toEqual(['addEventListener']);
  });

  it('a correct array method name means the value may not be an array', () => {
    const en = render('not-a-function-not-array', 'en');
    expect(en.explanation).toBe('items may not be an array, so it has no map method.');
    expect(run('not-a-function-not-array').candidates).toEqual([]);
  });

  it('a declared non-function gets the generic explanation and a console.log check', () => {
    const zh = render('not-a-function-plain');
    expect(zh.title).toBe('greet 不是函数，不能用 () 调用。');
    expect(zh.checks.at(-1)).toBe('在这一行前面加上 console.log(greet)，看看它到底是什么。');
  });
});

describe('rule 14: unclosed HTML tag', () => {
  it('names the tag and the line to search from', () => {
    const zh = render('html-unclosed-div');
    expect(zh.title).toBe('<div> 标签没有找到对应的 </div>。');
    expect(zh.checks[0]).toBe('从第 18 行往下找，在这个元素的内容结束的地方加上 </div>。');
  });

  it('ignores void elements, which have no closing tag', () => {
    const f = fixture('html-unclosed-div');
    expect(explain({ ...f.record, data: { tagName: 'img' } }).ruleId).toBe('fallback');
  });
});

describe('rule 15: selector does not match (guided checks)', () => {
  it('is always uncertain and gives the guided checklist', () => {
    const exp = run('style-not-applied-guided');
    expect(exp.certainty).toBe('unknown');
    expect(exp.checks).toHaveLength(5);
    expect(render('style-not-applied-guided', 'en').title).toBe('A style is not being applied.');
  });

  it('spots a class selector for something that is an id', () => {
    expect(render('selector-unmatched-wrong-prefix').causes).toEqual([
      'HTML 里的“hero”是 id，选择器可能要写成 #hero。',
    ]);
  });

  it('spots a similar id', () => {
    expect(render('selector-unmatched-similar', 'en').causes).toEqual([
      'The HTML has a similar id, “main-title”; the spelling or capitalisation may not match.',
    ]);
  });
});
