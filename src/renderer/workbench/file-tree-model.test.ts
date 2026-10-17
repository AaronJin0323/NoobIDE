import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../shared/ipc/contract';
import {
  INITIAL_TREE,
  foldersToLoad,
  isListing,
  keyAction,
  keyActionWith,
  selectionOf,
  visibleSelection,
  treeReducer,
  typeAheadChar,
  typeAheadTarget,
  visibleRows,
  type TreeAction,
  type TreeState,
} from './file-tree-model';

const dir = (relPath: string): TreeEntry => ({
  name: relPath.split('/').pop() ?? '',
  relPath,
  kind: 'directory',
  isLink: false,
});
const file = (relPath: string): TreeEntry => ({
  name: relPath.split('/').pop() ?? '',
  relPath,
  kind: 'file',
  isLink: false,
});

const apply = (state: TreeState, ...actions: TreeAction[]) => actions.reduce(treeReducer, state);

const loadedRoot = apply(INITIAL_TREE, {
  type: 'loaded',
  relPath: '',
  entries: [dir('css'), dir('子 文件夹'), file('index.html')],
  truncated: false,
});

const names = (state: TreeState) => visibleRows(state).map((r) => `${'  '.repeat(r.level - 1)}${r.entry.name}`);

describe('lazy tree model (S07.2)', () => {
  it('requests only the root at first, and a folder only once it is expanded', () => {
    expect(foldersToLoad(INITIAL_TREE)).toEqual(['']);
    expect(foldersToLoad(loadedRoot)).toEqual([]);
    const expanded = apply(loadedRoot, { type: 'expand', relPath: 'css' });
    expect(foldersToLoad(expanded)).toEqual(['css']);
    expect(foldersToLoad(apply(expanded, { type: 'loading', relPath: 'css' }))).toEqual([]);
  });

  it('flattens expanded, loaded folders depth-first with ARIA level, position and set size', () => {
    const state = apply(
      loadedRoot,
      { type: 'expand', relPath: 'css' },
      { type: 'loaded', relPath: 'css', entries: [file('css/a.css'), file('css/b.css')], truncated: false },
    );
    expect(names(state)).toEqual(['css', '  a.css', '  b.css', '子 文件夹', 'index.html']);
    const rows = visibleRows(state);
    expect(rows[0]).toMatchObject({ level: 1, posInSet: 1, setSize: 3, expandable: true, expanded: true });
    expect(rows[2]).toMatchObject({ level: 2, posInSet: 2, setSize: 2, expandable: false });
    expect(rows[4]).toMatchObject({ posInSet: 3, expandable: false });
  });

  it('collapsing hides children but keeps them cached; invalidate forgets them', () => {
    let state = apply(
      loadedRoot,
      { type: 'expand', relPath: 'css' },
      { type: 'loaded', relPath: 'css', entries: [file('css/a.css')], truncated: false },
      { type: 'collapse', relPath: 'css' },
    );
    expect(names(state)).toEqual(['css', '子 文件夹', 'index.html']);
    state = treeReducer(state, { type: 'expand', relPath: 'css' });
    expect(foldersToLoad(state)).toEqual([]);
    state = treeReducer(state, { type: 'invalidate', relPath: 'css' });
    expect(foldersToLoad(state)).toEqual(['css']);
  });

  it('links that leave the project are never expandable', () => {
    const state = apply(INITIAL_TREE, {
      type: 'loaded',
      relPath: '',
      entries: [{ name: 'jump', relPath: 'jump', kind: 'link-outside', isLink: true }],
      truncated: false,
    });
    expect(visibleRows(state)[0]?.expandable).toBe(false);
    expect(keyAction(apply(state, { type: 'select', relPath: 'jump' }), 'ArrowRight')).toEqual([]);
  });

  it('a rename keeps the moved subtree expanded and selected under its new path', () => {
    const state = apply(
      loadedRoot,
      { type: 'expand', relPath: 'css' },
      { type: 'loaded', relPath: 'css', entries: [file('css/a.css')], truncated: false },
      { type: 'select', relPath: 'css/a.css' },
      { type: 'renamed', from: 'css', to: 'styles' },
    );
    expect(state.expanded).toEqual(['styles']);
    expect(state.selected).toBe('styles/a.css');
    expect(state.folders.css).toBeUndefined();
    expect(state.folders['']).toMatchObject({ status: 'loaded', stale: true }); // the parent is listed again
    expect(foldersToLoad(state)).toContain('');
  });
});

describe('reloading keeps rows on screen (focus survives changes on disk)', () => {
  it('an invalidated folder keeps its rows until the new listing arrives', () => {
    let state = treeReducer(loadedRoot, { type: 'invalidate', relPath: '' });
    expect(names(state)).toEqual(['css', '子 文件夹', 'index.html']);
    expect(foldersToLoad(state)).toEqual(['']);
    expect(isListing(state)).toBe(false);
    state = treeReducer(state, { type: 'loading', relPath: '' });
    expect(names(state)).toEqual(['css', '子 文件夹', 'index.html']);
    expect(foldersToLoad(state)).toEqual([]);
    expect(isListing(state)).toBe(true);
    state = treeReducer(state, { type: 'loaded', relPath: '', entries: [file('index.html')], truncated: false });
    expect(names(state)).toEqual(['index.html']);
    expect(isListing(state)).toBe(false);
  });

  it('a change during a refresh asks for another listing', () => {
    const state = apply(loadedRoot, { type: 'loading', relPath: '' }, { type: 'invalidate', relPath: '' });
    expect(foldersToLoad(state)).toEqual(['']);
  });
});

describe('keyboard (S08.1, WAI-ARIA tree pattern)', () => {
  const tree = apply(
    loadedRoot,
    { type: 'expand', relPath: 'css' },
    { type: 'loaded', relPath: 'css', entries: [file('css/a.css')], truncated: false },
  );
  const at = (relPath: string) => treeReducer(tree, { type: 'select', relPath });

  it('Up/Down/Home/End move through visible rows', () => {
    expect(keyAction(tree, 'ArrowDown')).toEqual([{ type: 'select', relPath: 'css' }]);
    expect(keyAction(at('css'), 'ArrowDown')).toEqual([{ type: 'select', relPath: 'css/a.css' }]);
    expect(keyAction(at('css/a.css'), 'ArrowUp')).toEqual([{ type: 'select', relPath: 'css' }]);
    expect(keyAction(at('css'), 'ArrowUp')).toEqual([]);
    expect(keyAction(at('css'), 'End')).toEqual([{ type: 'select', relPath: 'index.html' }]);
    expect(keyAction(at('index.html'), 'Home')).toEqual([{ type: 'select', relPath: 'css' }]);
    expect(keyAction(at('index.html'), 'ArrowDown')).toEqual([]);
  });

  it('Right expands a closed folder, then moves to its first child', () => {
    expect(keyAction(at('子 文件夹'), 'ArrowRight')).toEqual([{ type: 'expand', relPath: '子 文件夹' }]);
    expect(keyAction(at('css'), 'ArrowRight')).toEqual([{ type: 'select', relPath: 'css/a.css' }]);
    expect(keyAction(at('index.html'), 'ArrowRight')).toEqual([]);
  });

  it('Left collapses an open folder, or moves to the parent', () => {
    expect(keyAction(at('css'), 'ArrowLeft')).toEqual([{ type: 'collapse', relPath: 'css' }]);
    expect(keyAction(at('css/a.css'), 'ArrowLeft')).toEqual([{ type: 'select', relPath: 'css' }]);
    expect(keyAction(at('index.html'), 'ArrowLeft')).toEqual([]);
  });
});

describe('multi-select (S52.3)', () => {
  const tree = apply(
    loadedRoot,
    { type: 'expand', relPath: 'css' },
    {
      type: 'loaded',
      relPath: 'css',
      entries: [file('css/a.css'), file('css/b.css')],
      truncated: false,
    },
  );
  // Rows: css, css/a.css, css/b.css, 子 文件夹, index.html

  it('a plain selection is one row; Ctrl/Cmd toggles rows in and out', () => {
    let state = apply(tree, { type: 'select', relPath: 'css/a.css' });
    expect(selectionOf(state)).toEqual(['css/a.css']);
    state = apply(
      state,
      { type: 'toggleSelect', relPath: 'index.html' },
      { type: 'toggleSelect', relPath: '子 文件夹' },
    );
    expect(selectionOf(state)).toEqual(['css/a.css', 'index.html', '子 文件夹']);
    state = apply(state, { type: 'toggleSelect', relPath: 'index.html' });
    expect(selectionOf(state)).toEqual(['css/a.css', '子 文件夹']);
    expect(visibleSelection(state).map((r) => r.entry.relPath)).toEqual(['css/a.css', '子 文件夹']);
    state = apply(state, { type: 'select', relPath: 'css' });
    expect(selectionOf(state)).toEqual(['css']);
  });

  it('Shift selects the range from the anchor, in both directions', () => {
    let state = apply(tree, { type: 'select', relPath: 'css/b.css' }, { type: 'rangeSelect', relPath: 'index.html' });
    expect(selectionOf(state)).toEqual(['css/b.css', '子 文件夹', 'index.html']);
    state = apply(state, { type: 'rangeSelect', relPath: 'css' });
    expect(selectionOf(state)).toEqual(['css', 'css/a.css', 'css/b.css']);
    expect(state.selected).toBe('css');
  });

  it('Shift+arrows extend; Ctrl/Cmd+arrows move the focus only; Ctrl/Cmd+A selects every visible row', () => {
    let state = apply(tree, { type: 'select', relPath: 'css/a.css' });
    for (const a of keyActionWith(state, 'ArrowDown', { shift: true, primary: false })) state = apply(state, a);
    for (const a of keyActionWith(state, 'ArrowDown', { shift: true, primary: false })) state = apply(state, a);
    expect(selectionOf(state)).toEqual(['css/a.css', 'css/b.css', '子 文件夹']);
    for (const a of keyActionWith(state, 'ArrowDown', { shift: false, primary: true })) state = apply(state, a);
    expect(state.selected).toBe('index.html');
    expect(selectionOf(state)).toEqual(['css/a.css', 'css/b.css', '子 文件夹']);
    state = apply(state, { type: 'toggleSelect', relPath: 'index.html' });
    expect(selectionOf(state)).toHaveLength(4);
    expect(keyActionWith(state, 'ArrowRight', { shift: true, primary: false })).toEqual([]);
    state = apply(state, { type: 'selectAll' });
    expect(selectionOf(state)).toEqual(['css', 'css/a.css', 'css/b.css', '子 文件夹', 'index.html']);
  });

  it('a row getting the focus keeps the selection; the selection follows a move', () => {
    let state = apply(tree, { type: 'select', relPath: 'css/a.css' }, { type: 'toggleSelect', relPath: 'css/b.css' });
    state = apply(state, { type: 'focus', relPath: 'index.html' });
    expect(selectionOf(state)).toEqual(['css/a.css', 'css/b.css']);
    state = apply(state, { type: 'renamed', from: 'css', to: '子 文件夹/css' });
    expect(selectionOf(state)).toEqual(['子 文件夹/css/a.css', '子 文件夹/css/b.css']);
  });

  it('rows of a collapsed folder drop out of what an operation acts on', () => {
    let state = apply(tree, { type: 'select', relPath: 'css/a.css' }, { type: 'toggleSelect', relPath: 'index.html' });
    state = apply(state, { type: 'collapse', relPath: 'css' });
    expect(visibleSelection(state).map((r) => r.entry.relPath)).toEqual(['index.html']);
  });
});

describe('type-ahead (S49.3)', () => {
  const tree = apply(
    INITIAL_TREE,
    {
      type: 'loaded',
      relPath: '',
      entries: [
        dir('css'),
        dir('图片'),
        file('About.html'),
        file('index.html'),
        file('我的 页面.html'),
        file('我的笔记.txt'),
      ],
      truncated: false,
    },
    { type: 'loaded', relPath: 'css', entries: [file('css/common.css')], truncated: false },
    { type: 'expand', relPath: 'css' },
  );
  const at = (selected: string | null) => apply(tree, { type: 'select', relPath: selected });

  it('selects the first matching row when nothing is selected, case-insensitively', () => {
    expect(typeAheadTarget(at(null), 'a')).toBe('About.html');
    expect(typeAheadTarget(at(null), 'IND')).toBe('index.html');
  });

  it('a single character moves to the next match after the selection and wraps around', () => {
    expect(typeAheadTarget(at('css'), 'c')).toBe('css/common.css');
    expect(typeAheadTarget(at('css/common.css'), 'c')).toBe('css');
    expect(typeAheadTarget(at('index.html'), 'a')).toBe('About.html');
  });

  it('a longer buffer keeps the selected row while it still matches', () => {
    expect(typeAheadTarget(at('css'), 'cs')).toBe('css');
    expect(typeAheadTarget(at('css'), 'co')).toBe('css/common.css');
  });

  it('repeating one character cycles through rows starting with it', () => {
    expect(typeAheadTarget(at('css'), 'cc')).toBe('css/common.css');
  });

  it('matches Chinese names and names with spaces', () => {
    expect(typeAheadTarget(at(null), '图')).toBe('图片');
    expect(typeAheadTarget(at('图片'), '我的 ')).toBe('我的 页面.html');
    expect(typeAheadTarget(at('我的 页面.html'), '我的笔')).toBe('我的笔记.txt');
  });

  it('matches regardless of Unicode normalization (macOS NFD names)', () => {
    const nfd = apply(INITIAL_TREE, {
      type: 'loaded',
      relPath: '',
      entries: [file('a.css'), file('café.html')],
      truncated: false,
    });
    expect(typeAheadTarget(nfd, 'café')).toBe('café.html');
  });

  it('returns null when nothing matches or the tree is empty', () => {
    expect(typeAheadTarget(at('css'), 'zz')).toBeNull();
    expect(typeAheadTarget(INITIAL_TREE, 'a')).toBeNull();
    expect(typeAheadTarget(at(null), '')).toBeNull();
  });

  it('accepts printable keys only, without modifiers; space only continues a buffer', () => {
    const key = (k: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
      key: k,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      ...mods,
    });
    expect(typeAheadChar(key('a'), '')).toBe('a');
    expect(typeAheadChar(key('我'), '')).toBe('我');
    expect(typeAheadChar(key('😀'), '')).toBe('😀');
    expect(typeAheadChar(key('a', { ctrlKey: true }), '')).toBeNull();
    expect(typeAheadChar(key('a', { altKey: true }), '')).toBeNull();
    expect(typeAheadChar(key('a', { metaKey: true }), '')).toBeNull();
    for (const k of ['Enter', 'F2', 'ArrowDown', 'Delete', 'Tab', 'Escape', 'Process']) {
      expect(typeAheadChar(key(k), 'a')).toBeNull();
    }
    expect(typeAheadChar(key(' '), '')).toBeNull();
    expect(typeAheadChar(key(' '), 'my')).toBe(' ');
  });
});
