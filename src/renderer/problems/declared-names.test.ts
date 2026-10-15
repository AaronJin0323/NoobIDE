import { describe, expect, it } from 'vitest';
import { declaredFromCompletions, soleDeclarationOffset, toDeclaredNames } from './declared-names';

describe('declared names from the language service (S22.4/S22.5)', () => {
  it("keeps the program's own declarations; drops library globals and JavaScript's plain-word suggestions", () => {
    expect(
      declaredFromCompletions([
        { name: 'userName', kind: 'const', kindModifiers: '' },
        { name: 'greet', kind: 'function', kindModifiers: '' },
        { name: 'count', kind: 'local var' },
        { name: 'event', kind: 'parameter' },
        { name: 'name', kind: 'var', kindModifiers: 'declare' }, // window.name from lib.dom
        { name: 'document', kind: 'var', kindModifiers: 'declare,deprecated' },
        { name: 'userNmae', kind: 'warning' }, // the misspelling itself, offered as a plain word
        { name: 'if', kind: 'keyword' },
        { name: 'userName', kind: 'const' }, // duplicate
      ]),
    ).toEqual(['userName', 'greet', 'count', 'event']);
  });

  it('finds the line of a name declared exactly once in the file, and nothing when ambiguous', () => {
    const tree = {
      text: '<global>',
      kind: 'script',
      spans: [{ start: 0, length: 100 }],
      childItems: [
        { text: 'userName', kind: 'const', spans: [{ start: 14, length: 20 }] },
        {
          text: 'greet',
          kind: 'function',
          spans: [{ start: 40, length: 30 }],
          childItems: [{ text: 'x', kind: 'let', spans: [{ start: 50, length: 3 }] }],
        },
        { text: 'x', kind: 'var', spans: [{ start: 80, length: 3 }] },
      ],
    };
    expect(soleDeclarationOffset(tree, 'userName')).toBe(14);
    expect(soleDeclarationOffset(tree, 'x')).toBeUndefined();
    expect(soleDeclarationOffset(tree, 'missing')).toBeUndefined();
    expect(soleDeclarationOffset(undefined, 'userName')).toBeUndefined();
  });

  it('builds DeclaredName entries with the file and line only when the line is known', () => {
    expect(toDeclaredNames(['userName', 'greet'], 'script.js', (n) => (n === 'userName' ? 9 : undefined))).toEqual([
      { name: 'userName', file: 'script.js', line: 9 },
      { name: 'greet' },
    ]);
  });
});
