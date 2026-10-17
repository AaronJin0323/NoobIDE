import { describe, expect, it } from 'vitest';
import { otherLocale, translate } from '../i18n/index';
import {
  PALETTE_KEYWORDS,
  keywordList,
  moveSelection,
  normalize,
  recentLead,
  recordRecent,
  searchPalette,
  type PaletteEntry,
} from './palette-model';

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

describe('keywords: other words for a command', () => {
  // Built like the palette does: label in the interface language, keywords from both locales.
  const withKeywords = (locale: 'zh-CN' | 'en'): PaletteEntry[] =>
    (['new-project', 'save', 'preview-refresh'] as const).map((id) => {
      const label =
        id === 'new-project' ? 'command.newProject' : id === 'save' ? 'command.save' : 'command.preview.refresh';
      const keywords = PALETTE_KEYWORDS[id];
      return {
        id,
        label: translate(locale, label),
        otherLabel: translate(otherLocale(locale), label),
        shortcut: null,
        ...(keywords
          ? {
              keywords: [
                ...keywordList(translate(locale, keywords)),
                ...keywordList(translate(otherLocale(locale), keywords)),
              ],
            }
          : {}),
      };
    });

  it('“create” (and 创建) finds New project in both interface languages, like the welcome button says', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const query of ['create', 'Create', '创建', 'webpage', '网页']) {
        const found = searchPalette(withKeywords(locale), query);
        expect(found[0]?.entry.id, `${locale} ${query}`).toBe('new-project');
        expect(found[0]?.viaOther).toBe(false);
      }
    }
  });

  it('a label match still ranks above a keyword match', () => {
    const entries: PaletteEntry[] = [
      { id: 'new-project', label: 'New project…', otherLabel: '新建项目…', shortcut: null, keywords: ['save'] },
      { id: 'save', label: 'Save', otherLabel: '保存', shortcut: null },
    ];
    expect(searchPalette(entries, 'save').map((m) => m.entry.id)).toEqual(['save', 'new-project']);
    expect(keywordList('a b，c、d, e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('palette recents (S49.5)', () => {
  const list: PaletteEntry[] = [
    { id: 'open-folder', label: 'Open folder', otherLabel: '打开文件夹', shortcut: null },
    { id: 'save', label: 'Save', otherLabel: '保存', shortcut: null },
    { id: 'close-tab', label: 'Save and close tab', otherLabel: '保存并关闭', shortcut: null },
    { id: 'toggle-problems', label: 'Show problems', otherLabel: '显示问题', shortcut: null },
  ];
  const ids = (found: { entry: PaletteEntry }[]) => found.map((m) => m.entry.id);

  it('an empty query lists the recently run commands first, newest first, then the rest in registry order', () => {
    const recents = ['toggle-problems', 'save'];
    const found = searchPalette(list, '', recents);
    expect(ids(found)).toEqual(['toggle-problems', 'save', 'open-folder', 'close-tab']);
    expect(recentLead(found, recents, '')).toBe(2);
    expect(recentLead(found, recents, '  ')).toBe(2);
  });

  it('skips remembered ids that cannot run now (or that this version does not know)', () => {
    const recents = ['zoom-in', 'gone-command', 'close-tab'];
    const found = searchPalette(list, '', recents);
    expect(ids(found)).toEqual(['close-tab', 'open-folder', 'save', 'toggle-problems']);
    expect(recentLead(found, recents, '')).toBe(1);
  });

  it('with a query the match quality decides first; recency only breaks ties', () => {
    // "save" starts both labels: equally good, the more recent wins.
    expect(ids(searchPalette(list, 'save', ['close-tab']))).toEqual(['close-tab', 'save']);
    expect(ids(searchPalette(list, 'save', []))).toEqual(['save', 'close-tab']);
    // A recent command that matches worse stays behind.
    expect(ids(searchPalette(list, 'problems', ['save']))[0]).toBe('toggle-problems');
    expect(recentLead(searchPalette(list, 'save', ['save']), ['save'], 'save')).toBe(0);
  });

  it('recording moves the command to the front and keeps the newest eight', () => {
    expect(recordRecent([], 'save')).toEqual(['save']);
    expect(recordRecent(['a', 'save', 'b'], 'save')).toEqual(['save', 'a', 'b']);
    const full = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(recordRecent(full, 'i')).toEqual(['i', 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(recordRecent(full, 'i')).toHaveLength(8);
  });
});
