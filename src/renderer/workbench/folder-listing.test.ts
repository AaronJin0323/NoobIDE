import { describe, expect, it } from 'vitest';
import type { DirListing, DirRequest, IpcResult, ListDirError, TreeEntry } from '../../shared/ipc/contract';
import { INITIAL_TREE, treeReducer, visibleRows, type TreeAction, type TreeState } from './file-tree-model';
import { createListingTracker, listFolder } from './folder-listing';

/**
 * Out-of-order listing replies (bug under S07.2/S07.3): an older reply for a folder that arrives after a newer one
 * must not overwrite it. The fake listDir resolves requests only when the test says so, in any order.
 */
type Reply = IpcResult<DirListing, ListDirError>;
const PROJECT = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const file = (name: string): TreeEntry => ({ name, relPath: name, kind: 'file', isLink: false });
const listing = (...names: string[]): Reply => ({
  ok: true,
  value: { relPath: '', entries: names.map(file), truncated: false },
});

function fakeListDir() {
  const pending: { request: DirRequest; resolve(reply: Reply): void }[] = [];
  const listDir = (request: DirRequest) =>
    new Promise<Reply>((resolve) => {
      pending.push({ request, resolve });
    });
  return { listDir, pending };
}

function harness() {
  let state: TreeState = INITIAL_TREE;
  const dispatch = (action: TreeAction) => {
    state = treeReducer(state, action);
  };
  const names = () => visibleRows(state).map((r) => r.entry.name);
  return { dispatch, names, state: () => state };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('file tree listings resolving out of order', () => {
  it('a late reply of an older listing does not overwrite the newer one', async () => {
    const tracker = createListingTracker();
    const { listDir, pending } = fakeListDir();
    const tree = harness();
    tree.dispatch({ type: 'loading', relPath: '' });
    const first = listFolder(tracker, listDir, PROJECT, '', tree.dispatch);
    pending[0]!.resolve(listing('a.html'));
    await first;
    expect(tree.names()).toEqual(['a.html']);

    // b.html is created: the folder is listed again (A) …
    tree.dispatch({ type: 'invalidate', relPath: '' });
    tree.dispatch({ type: 'loading', relPath: '' });
    const older = listFolder(tracker, listDir, PROJECT, '', tree.dispatch);
    // … and a.html is deleted before A answers: listed again (B).
    tree.dispatch({ type: 'invalidate', relPath: '' });
    tree.dispatch({ type: 'loading', relPath: '' });
    const newer = listFolder(tracker, listDir, PROJECT, '', tree.dispatch);

    pending[2]!.resolve(listing('b.html')); // B (the truth now) arrives first
    await newer;
    pending[1]!.resolve(listing('a.html', 'b.html')); // A arrives late with a ghost a.html
    await older;
    await settle();
    expect(tree.names()).toEqual(['b.html']);
    expect(tree.state().folders['']).toMatchObject({ status: 'loaded' });
  });

  it('a late failure of an older listing does not replace the newer rows with an error', async () => {
    const tracker = createListingTracker();
    const { listDir, pending } = fakeListDir();
    const tree = harness();
    tree.dispatch({ type: 'loading', relPath: '' });
    const older = listFolder(tracker, listDir, PROJECT, '', tree.dispatch);
    tree.dispatch({ type: 'invalidate', relPath: '' });
    tree.dispatch({ type: 'loading', relPath: '' });
    const newer = listFolder(tracker, listDir, PROJECT, '', tree.dispatch);
    pending[1]!.resolve(listing('index.html'));
    await newer;
    pending[0]!.resolve({ ok: false, code: 'list-failed', message: 'EIO' });
    await older;
    expect(tree.names()).toEqual(['index.html']);
  });

  it('listings of different folders do not cancel each other; a reset drops everything in flight', async () => {
    const tracker = createListingTracker();
    const { listDir, pending } = fakeListDir();
    const seen: TreeAction[] = [];
    const root = listFolder(tracker, listDir, PROJECT, '', (a) => seen.push(a));
    const sub = listFolder(tracker, listDir, PROJECT, 'css', (a) => seen.push(a));
    pending[1]!.resolve(listing('site.css'));
    pending[0]!.resolve(listing('css'));
    await Promise.all([root, sub]);
    expect(seen.map((a) => a.type === 'loaded' && a.relPath)).toEqual(['css', '']);

    const before = listFolder(tracker, listDir, PROJECT, '', (a) => seen.push(a));
    tracker.reset(); // another project was opened
    const after = listFolder(tracker, listDir, PROJECT, '', (a) => seen.push(a));
    pending[3]!.resolve(listing('new.html'));
    pending[2]!.resolve(listing('old.html'));
    await Promise.all([before, after]);
    expect(seen.slice(2)).toEqual([{ type: 'loaded', relPath: '', entries: [file('new.html')], truncated: false }]);
  });
});
