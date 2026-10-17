import { describe, expect, it } from 'vitest';
import { toggleBlockComment, toggleLineComments } from './embedded-comment';

describe('comments inside <script> and <style> (S53.4)', () => {
  it('scripts: `// ` at the common indentation, and back', () => {
    const lines = ['  let a = 1;', '', '    a += 1;'];
    const commented = toggleLineComments(lines, 'script');
    expect(commented).toEqual(['  // let a = 1;', '', '  //   a += 1;']);
    expect(toggleLineComments(commented, 'script')).toEqual(lines);
  });

  it('scripts: a mix of commented and plain lines is commented, not uncommented', () => {
    expect(toggleLineComments(['// a();', 'b();'], 'script')).toEqual(['// // a();', '// b();']);
  });

  it('styles: each line is wrapped in /* */, and unwrapped again', () => {
    const lines = ['  a { color: red; }', '  b { margin: 0; }'];
    const commented = toggleLineComments(lines, 'style');
    expect(commented).toEqual(['  /* a { color: red; } */', '  /* b { margin: 0; } */']);
    expect(toggleLineComments(commented, 'style')).toEqual(lines);
  });

  it('block comments wrap and unwrap the selection', () => {
    expect(toggleBlockComment('a + b')).toBe('/* a + b */');
    expect(toggleBlockComment('/* a + b */')).toBe('a + b');
  });
});
