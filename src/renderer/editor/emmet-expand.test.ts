import { describe, expect, it } from 'vitest';
import { emmetExpansionAt } from './emmet-expand';

/** `|` marks the cursor. */
function at(source: string, syntax: 'html' | 'css') {
  const offset = source.indexOf('|');
  return emmetExpansionAt(source.replace('|', ''), offset, syntax);
}

describe('emmetExpansionAt: HTML', () => {
  it('expands nested and repeated elements', () => {
    const result = at('<body>\n  ul>li*3|\n</body>', 'html');
    expect(result?.abbreviation).toBe('ul>li*3');
    expect(result?.snippet).toBe('<ul>\n\t<li>${1}</li>\n\t<li>${2}</li>\n\t<li>${3}</li>\n</ul>');
    expect(result?.start).toBe('<body>\n  '.length);
  });

  it('expands classes, ids and the page skeleton', () => {
    expect(at('.box|', 'html')?.snippet).toBe('<div class="box">${1}</div>');
    expect(at('p#intro|', 'html')?.snippet).toBe('<p id="intro">${1}</p>');
    expect(at('!|', 'html')?.snippet).toContain('<!DOCTYPE html>');
  });

  it('leaves words that are not elements alone', () => {
    expect(at('hello|', 'html')).toBeNull();
    expect(at('hello>world|', 'html')).toBeNull();
    expect(at('<p>Some text m10|</p>', 'html')).toBeNull();
  });

  it('does nothing inside a tag, a comment or a script', () => {
    expect(at('<div class="a" p|>', 'html')).toBeNull();
    expect(at('<!-- ul>li|', 'html')).toBeNull();
    expect(at('<script>\n  div|\n</script>', 'html')).toBeNull();
  });

  it('does nothing at the start of a line, on a blank line or in the middle of a word', () => {
    expect(at('|div', 'html')).toBeNull();
    expect(at('   |', 'html')).toBeNull();
    expect(at('di|v', 'html')).toBeNull();
  });

  it('uses the CSS rules inside <style>', () => {
    expect(at('<style>\n  body { m10| }\n</style>', 'html')?.snippet).toBe('margin: 10px;');
    expect(at('<style>\n  ul>li|\n</style>', 'html')).toBeNull();
  });
});

describe('emmetExpansionAt: CSS', () => {
  it('expands property abbreviations inside a rule', () => {
    expect(at('a {\n  m10|\n}', 'css')?.snippet).toBe('margin: 10px;');
    expect(at('a { color: red; d:f| }', 'css')?.snippet).toBe('display: flex;');
    expect(at('a {\n  bgc|\n}', 'css')?.snippet).toBe('background-color: ${1:#fff};');
  });

  it('does not guess a property for an unknown word', () => {
    expect(at('a {\n  foo|\n}', 'css')).toBeNull();
    expect(at('a {\n  zzz|\n}', 'css')).toBeNull();
  });

  it('does nothing in a selector, a value or a comment', () => {
    expect(at('m10|', 'css')).toBeNull();
    expect(at('a { margin: m10| }', 'css')).toBeNull();
    expect(at('a { /* m10| */ }', 'css')).toBeNull();
  });
});
