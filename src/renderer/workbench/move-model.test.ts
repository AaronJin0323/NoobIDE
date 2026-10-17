import { describe, expect, it } from 'vitest';
import { dropFolder, filterFolders, moveRefusal, movedPath, outermostSources } from './move-model';

/** S52.1/S52.3: which moves the tree and the "Move to…" dialog offer (paths with Chinese characters and spaces). */
const dir = (relPath: string) => ({ relPath, kind: 'directory' });
const file = (relPath: string) => ({ relPath, kind: 'file' });

describe('move rules (S52.1)', () => {
  it('a folder cannot be moved into itself or any folder below it', () => {
    expect(moveRefusal([dir('子 文件夹')], '子 文件夹')).toBe('into-itself');
    expect(moveRefusal([dir('子 文件夹')], '子 文件夹/深 一层')).toBe('into-itself');
    expect(moveRefusal([dir('子 文件夹')], '子 文件夹/深 一层/更深')).toBe('into-itself');
  });

  it('a folder whose name only starts like the moved folder is a fine target', () => {
    expect(moveRefusal([dir('子 文件夹')], '子 文件夹 二')).toBeNull();
  });

  it('moving into the folder the entries are already in is not offered', () => {
    expect(moveRefusal([file('index.html')], '')).toBe('same-folder');
    expect(moveRefusal([file('子 文件夹/页面.html')], '子 文件夹')).toBe('same-folder');
    expect(moveRefusal([file('子 文件夹/页面.html')], '')).toBeNull();
  });

  it('a selection is refused if any folder in it would go into itself; mixed folders are fine', () => {
    expect(moveRefusal([file('a.html'), dir('图片 素材')], '图片 素材/小图')).toBe('into-itself');
    expect(moveRefusal([file('a.html'), file('x/b.html')], 'x')).toBeNull();
  });

  it('entries inside a selected folder move with it', () => {
    expect(outermostSources([dir('素材'), file('素材/a.png'), file('b.html')]).map((s) => s.relPath)).toEqual([
      '素材',
      'b.html',
    ]);
    expect(moveRefusal([dir('素材'), file('素材/a.png')], '素材')).toBe('into-itself');
  });

  it('a drop on a folder row moves into it; on a file row into that file’s folder; elsewhere into the root', () => {
    expect(dropFolder(dir('子 文件夹'))).toBe('子 文件夹');
    expect(dropFolder(file('子 文件夹/页面 二.html'))).toBe('子 文件夹');
    expect(dropFolder(file('index.html'))).toBe('');
    expect(dropFolder(null)).toBe('');
  });

  it('the moved path keeps the name', () => {
    expect(movedPath('子 文件夹/页面 二.html', '')).toBe('页面 二.html');
    expect(movedPath('index.html', '图片 素材/小图')).toBe('图片 素材/小图/index.html');
  });

  it('the dialog filters folders by any part of their path, ignoring case', () => {
    const folders = ['', 'CSS', '图片 素材', '图片 素材/小图', 'js'];
    expect(filterFolders(folders, '')).toEqual(folders);
    expect(filterFolders(folders, 'css')).toEqual(['CSS']);
    expect(filterFolders(folders, '小图')).toEqual(['图片 素材/小图']);
  });
});
