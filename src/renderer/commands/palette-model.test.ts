import { describe, expect, it } from 'vitest';
import { moveSelection, normalize, searchPalette, type PaletteEntry } from './palette-model';

const entries: PaletteEntry[] = [
  { id: 'save', label: '保存', otherLabel: 'Save', shortcut: 'Ctrl+S' },
  { id: 'toggle-problems', label: '显示或隐藏问题面板', otherLabel: 'Show or Hide Problems', shortcut: null },
  { id: 'theme-light', label: '浅色主题', otherLabel: 'Light Theme', shortcut: null },
  { id: 'theme-dark', label: '深色主题', otherLabel: 'Dark Theme', shortcut: null },
  { id: 'open-folder', label: '打开文件夹…', otherLabel: 'Open Folder…', shortcut: 'Ctrl+O' },
  { id: 'preview-refresh', label: '刷新预览', otherLabel: 'Refresh Preview', shortcut: 'Ctrl+R' },
];
const ids = (query: string) => searchPalette(entries, query).map((m) => m.entry.id);

describe('command palette search (S40.5)', () => {
  it('lists every command, in registry order, for an empty query', () => {
    expect(ids('')).toEqual(entries.map((e) => e.id));
    expect(ids('   ')).toEqual(entries.map((e) => e.id));
  });

  it('finds commands by part of their label in the interface language', () => {
    expect(ids('主题')).toEqual(['theme-light', 'theme-dark']);
    expect(ids('预览')).toEqual(['preview-refresh']);
    expect(ids('文件夹')).toEqual(['open-folder']);
  });

  it('finds commands through the other language and says so', () => {
    const [match] = searchPalette(entries, 'save');
    expect(match?.entry.id).toBe('save');
    expect(match?.viaOther).toBe(true);
    expect(ids('refresh')).toEqual(['preview-refresh']);
    expect(searchPalette(entries, '保存')[0]?.viaOther).toBe(false);
  });

  it('ranks a prefix above a later substring, and ignores case, spaces and ellipses', () => {
    expect(ids('OPEN folder...')).toEqual(['open-folder']);
    expect(ids('theme')).toEqual(['theme-dark', 'theme-light']); // the earlier occurrence ranks first
    expect(ids('dark')).toEqual(['theme-dark']);
  });

  it('matches word initials and letters in order, but not single stray letters', () => {
    expect(ids('rp')[0]).toBe('preview-refresh'); // initials before letters-in-order
    expect(ids('shp')).toContain('toggle-problems');
    expect(ids('zzz')).toEqual([]);
  });

  it('normalizes full-width punctuation and spacing', () => {
    expect(normalize(' 打开 文件夹… ')).toBe('打开文件夹');
    expect(normalize('Ｏｐｅｎ')).toBe('open');
  });

  it('moves the selection with the arrow keys, wrapping around', () => {
    expect(moveSelection(0, 3, 'ArrowDown')).toBe(1);
    expect(moveSelection(2, 3, 'ArrowDown')).toBe(0);
    expect(moveSelection(0, 3, 'ArrowUp')).toBe(2);
    expect(moveSelection(1, 3, 'End')).toBe(2);
    expect(moveSelection(2, 3, 'Home')).toBe(0);
    expect(moveSelection(0, 0, 'ArrowDown')).toBe(-1);
  });
});
