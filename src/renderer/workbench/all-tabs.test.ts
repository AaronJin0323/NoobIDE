import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import type { OpenTab } from './document-state';
import { INITIAL_SAVE, type SaveSnapshot } from './save-machine';
import { ALL_TABS_STATE, allTabsRows, focusAfterClose } from './all-tabs';

const tab = (relPath: string, save: Partial<SaveSnapshot> = {}): OpenTab =>
  ({ relPath, uri: `file:///p/${relPath}`, content: {}, save: { ...INITIAL_SAVE, ...save } }) as unknown as OpenTab;

describe('All tabs list (S49.5)', () => {
  it('lists every open file in tab order with its folder and the shown tab marked', () => {
    const rows = allTabsRows([tab('index.html'), tab('页面/index.html'), tab('css/我的 样式.css')], '页面/index.html');
    expect(rows.map((r) => [r.name, r.folder, r.current])).toEqual([
      ['index.html', '', false],
      ['index.html', '页面', true],
      ['我的 样式.css', 'css', false],
    ]);
  });

  it('gives every row a state word, "saved" included', () => {
    const rows = allTabsRows(
      [
        tab('a.html'),
        tab('b.html', { revision: 2, savedRevision: 1 }),
        tab('c.html', { revision: 2, savedRevision: 1, savingRevision: 2 }),
        tab('d.html', { revision: 2, savedRevision: 1, error: { code: 'write-failed' } as never }),
        tab('e.html', { conflict: true }),
        tab('f.html', { deleted: true }),
        tab('g.html', { hasSaved: true }),
      ],
      null,
    );
    expect(rows.map((r) => r.stateKey)).toEqual([
      'tabs.all.saved',
      'tab.state.dirty',
      'tab.state.saving',
      'tab.state.failed',
      'tab.state.conflict',
      'tab.state.deleted',
      'tabs.all.saved',
    ]);
    for (const key of Object.values(ALL_TABS_STATE)) {
      expect(zhCN[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });

  it('after closing a row the focus goes to the row that took its place, or the one before; none when empty', () => {
    expect(focusAfterClose(0, 2)).toBe(0);
    expect(focusAfterClose(2, 2)).toBe(1);
    expect(focusAfterClose(0, 0)).toBeNull();
  });
});
