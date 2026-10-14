import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../shared/ipc/contract';
import {
  INITIAL_TREE,
  foldersToLoad,
  keyAction,
  treeReducer,
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
    expect(state.folders['']).toBeUndefined(); // the parent is listed again
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
