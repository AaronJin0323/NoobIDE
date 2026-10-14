import { describe, expect, it } from 'vitest';
import { diffLines } from './line-diff';

describe('recovery line diff (S12.2)', () => {
  it('reports identical text, ignoring line-ending style', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nb\n')).toMatchObject({ identical: true, added: 0, removed: 0, lines: [] });
  });

  it('shows added and removed lines with context and skips long unchanged runs', () => {
    const before = ['<html>', '1', '2', '3', '4', '5', '<p>旧</p>', '</html>'].join('\n');
    const after = ['<html>', '1', '2', '3', '4', '5', '<p>新的内容</p>', '<p>第二行</p>', '</html>'].join('\n');
    const diff = diffLines(before, after);
    expect(diff).toMatchObject({ identical: false, tooLarge: false, added: 2, removed: 1 });
    expect(diff.lines).toEqual([
      { kind: 'skipped', count: 4 },
      { kind: 'same', text: '4' },
      { kind: 'same', text: '5' },
      { kind: 'removed', text: '<p>旧</p>' },
      { kind: 'added', text: '<p>新的内容</p>' },
      { kind: 'added', text: '<p>第二行</p>' },
      { kind: 'same', text: '</html>' },
    ]);
  });

  it('handles a file that is empty on one side', () => {
    expect(diffLines('', 'x\ny')).toMatchObject({ added: 2, removed: 1 });
    expect(diffLines('x', '')).toMatchObject({ added: 1, removed: 1 });
  });

  it('gives up on huge changed regions instead of freezing the UI', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    expect(diffLines(before, after)).toMatchObject({ tooLarge: true, added: 3000, removed: 3000, lines: [] });
  });
});
