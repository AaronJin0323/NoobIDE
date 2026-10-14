import { describe, expect, it } from 'vitest';
import {
  baseName,
  dirName,
  editDistance,
  extension,
  identifierColumns,
  locateIdentifier,
  samePath,
  samePathIgnoringCase,
  similarNames,
} from './text';

describe('editDistance', () => {
  it('counts insertions, deletions, substitutions and adjacent transpositions as 1', () => {
    expect(editDistance('userNmae', 'userName')).toBe(1);
    expect(editDistance('colr', 'color')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('名字', '名子')).toBe(1);
  });
});

describe('similarNames', () => {
  it('finds plausible typos, closest first, and treats case-only differences as closest', () => {
    expect(similarNames('userNmae', ['userName', 'total', 'userAge'])).toEqual(['userName']);
    expect(similarNames('username', ['userName', 'usernames'])).toEqual(['userName', 'usernames']);
    expect(similarNames('usr', ['user', 'usr1', 'url'])).toEqual(['user', 'usr1']);
  });

  it('does not guess for very short names unless only the case differs', () => {
    expect(similarNames('a', ['b', 'c'])).toEqual([]);
    expect(similarNames('x', ['X'])).toEqual(['X']);
  });

  it('excludes the name itself and far-away names', () => {
    expect(similarNames('total', ['total', 'counter'])).toEqual([]);
  });
});

describe('identifier location', () => {
  const line = "  alert('你好，' + userNmae + obj.userNmae + userNmaes);";
  it('finds whole free-standing identifiers only', () => {
    expect(identifierColumns(line, 'userNmae')).toEqual([line.indexOf('userNmae') + 1]);
  });

  it('uses the column when it points at or into the name, else the only occurrence', () => {
    const col = line.indexOf('userNmae') + 1;
    expect(locateIdentifier(line, 'userNmae', col)).toBe(col);
    expect(locateIdentifier(line, 'userNmae', col + 3)).toBe(col);
    expect(locateIdentifier(line, 'userNmae', 1)).toBe(col);
    expect(locateIdentifier('a + a', 'a', 5)).toBe(5);
    expect(locateIdentifier('a + a', 'a')).toBeUndefined();
    expect(locateIdentifier('b', 'a')).toBeUndefined();
  });
});

describe('paths', () => {
  it('compares case-insensitively and across Unicode normalisation forms', () => {
    expect(samePathIgnoringCase('images/头像.PNG', 'images/头像.png')).toBe(true);
    expect(samePathIgnoringCase('café.png', 'café.png')).toBe(true);
    expect(samePath('café.png', 'café.png')).toBe(true);
    expect(samePathIgnoringCase('a/b.png', 'a/c.png')).toBe(false);
  });

  it('splits project-relative paths', () => {
    expect(baseName('我的 主页/images/头像.PNG')).toBe('头像.PNG');
    expect(dirName('我的 主页/images/头像.PNG')).toBe('我的 主页/images');
    expect(dirName('a.js')).toBe('');
    expect(extension('images/头像.PNG')).toBe('png');
    expect(extension('.hidden')).toBe('');
  });
});
