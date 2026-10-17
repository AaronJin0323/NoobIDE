import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../shared/ipc/contract';
import { listProjectFiles, type ListDir } from './project-files';

const file = (relPath: string): TreeEntry => ({
  name: relPath.split('/').at(-1) as string,
  relPath,
  kind: 'file',
  isLink: false,
});
const dir = (relPath: string): TreeEntry => ({ ...file(relPath), kind: 'directory' });

function fakeListDir(tree: Record<string, TreeEntry[]>): ListDir & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async ({ relPath }) => {
    calls.push(relPath);
    const entries = tree[relPath];
    return entries
      ? { ok: true, value: { relPath, entries, truncated: false } }
      : { ok: false, code: 'not-found', message: '' };
  }) as ListDir & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('project files for @mentions (S48.4)', () => {
  it('lists files breadth-first, with Chinese names and spaces, skipping dotfiles and node_modules', async () => {
    const listDir = fakeListDir({
      '': [file('index.html'), dir('css'), dir('图片 素材'), file('.env'), dir('.git'), dir('node_modules')],
      css: [file('css/style.css')],
      '图片 素材': [file('图片 素材/猫 咪.png')],
    });
    expect(await listProjectFiles(listDir, 'p1')).toEqual(['index.html', 'css/style.css', '图片 素材/猫 咪.png']);
    expect(listDir.calls).toEqual(['', 'css', '图片 素材']);
  });

  it('skips folders that cannot be read and links that lead outside', async () => {
    const listDir = fakeListDir({
      '': [dir('gone'), { ...file('out.txt'), kind: 'link-outside' }, file('a.js')],
    });
    expect(await listProjectFiles(listDir, 'p1')).toEqual(['a.js']);
  });

  it('stops at the file and folder limits and never offers over-long paths', async () => {
    const long = 'x'.repeat(1100);
    const listDir = fakeListDir({
      '': [file('1.js'), file('2.js'), file('3.js'), file(long), dir('a')],
      a: [dir('a/b')],
      'a/b': [file('a/b/deep.js')],
    });
    expect(await listProjectFiles(listDir, 'p1', { files: 2, folders: 10 })).toEqual(['1.js', '2.js']);
    expect(await listProjectFiles(listDir, 'p1', { files: 10, folders: 2 })).toEqual(['1.js', '2.js', '3.js']);
  });
});
