import { describe, expect, it } from 'vitest';
import { linkedTagRanges, tagPairs, wrapSnippet } from './tag-match';

/** The linked names at `|`, as text. */
function linkedAt(source: string): string[] | null {
  const offset = source.indexOf('|');
  const text = source.replace('|', '');
  const pair = linkedTagRanges(text, offset);
  return pair ? pair.map((tag) => `${tag.closing ? '/' : ''}${text.slice(tag.start, tag.end)}@${tag.start}`) : null;
}

describe('linkedTagRanges (S53.2)', () => {
  it('links an opening tag name with its closing tag name, from either side', () => {
    expect(linkedAt('<di|v class="a">x</div>')).toEqual(['div@1', '/div@18']);
    expect(linkedAt('<div class="a">x</d|iv>')).toEqual(['div@1', '/div@18']);
    // Right after the name still counts (the cursor after typing a letter).
    expect(linkedAt('<div|>x</div>')).toEqual(['div@1', '/div@8']);
  });

  it('pairs nested elements of the same name correctly', () => {
    const text = '<div><div>in|</div></div>';
    expect(linkedAt(text)).toBeNull(); // the cursor is in text
    expect(linkedAt('<div><di|v>in</div></div>')).toEqual(['div@6', '/div@14']);
    expect(linkedAt('<d|iv><div>in</div></div>')).toEqual(['div@1', '/div@20']);
  });

  it('does not link void elements, self-closing tags or tags closed implicitly', () => {
    expect(linkedAt('<im|g src="a.png"><p>x</p>')).toBeNull();
    expect(linkedAt('<b|r/>')).toBeNull();
    expect(linkedAt('<ul><l|i>One<li>Two</ul>')).toBeNull();
    expect(linkedAt('<p>x</sp|an></p>')).toBeNull();
  });

  it('treats comments, attribute values and script content as text', () => {
    expect(linkedAt('<!-- <d|iv> --></div>')).toBeNull();
    expect(linkedAt('<a title="1 > 0">x</|a>')).toEqual(['a@1', '/a@20']);
    expect(tagPairs('<script>if (a < b) { x = "</div>"; }</script><p></p>').map(([o]) => o.name)).toEqual([
      'script',
      'p',
    ]);
  });
});

describe('wrapSnippet (S53.2)', () => {
  it('puts the selection between linked tag names and keeps $ and } literal', () => {
    expect(wrapSnippet('Hello')).toBe('<${1:div}>Hello</${1:div}>');
    expect(wrapSnippet('cost: $5 }')).toBe('<${1:div}>cost: \\$5 \\}</${1:div}>');
  });
});
