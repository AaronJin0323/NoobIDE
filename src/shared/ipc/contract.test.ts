import { describe, expect, it } from 'vitest';
import { err, ok } from '../result';
import {
  CHANNELS,
  isPortableRelPath,
  parseFileRequest,
  parseNoPayload,
  parseProjectRequest,
  parseWriteFileRequest,
  toIpcResult,
} from './contract';

const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';

describe('portable relative paths (S03.1)', () => {
  it.each(['index.html', 'css/style.css', '中文 路径/图 片.png', 'a b/c.d/e.js', '..hidden-name.txt'])(
    'accepts %s',
    (p) => expect(isPortableRelPath(p)).toBe(true),
  );

  it.each([
    ['empty', ''],
    ['parent segment', '../secret.txt'],
    ['nested parent', 'css/../../x'],
    ['dot segment', './index.html'],
    ['absolute POSIX', '/etc/passwd'],
    ['Windows drive', 'C:/Windows/win.ini'],
    ['drive-relative', 'C:secret'],
    ['backslash', 'css\\style.css'],
    ['UNC-ish', '//server/share'],
    ['NUL byte', 'a\0b'],
    ['empty segment', 'css//style.css'],
    ['trailing slash', 'css/'],
    ['URL', 'file:/etc/passwd'],
    ['too long', 'a/'.repeat(600) + 'b'],
  ])('rejects %s', (_name, p) => expect(isPortableRelPath(p)).toBe(false));

  it('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, ['a']]) expect(isPortableRelPath(v)).toBe(false);
  });
});

describe('payload parsers reject malformed requests (S03.1)', () => {
  it('file request needs exactly a project id and a portable path', () => {
    expect(parseFileRequest({ projectId: ID, relPath: 'index.html' })).toEqual({
      projectId: ID,
      relPath: 'index.html',
    });
    expect(parseFileRequest({ projectId: 'not-an-id', relPath: 'index.html' })).toBeNull();
    expect(parseFileRequest({ projectId: ID, relPath: '../x' })).toBeNull();
    expect(parseFileRequest({ projectId: ID })).toBeNull();
    expect(parseFileRequest({ projectId: ID, relPath: 'a', extra: 1 })).toBeNull();
    expect(parseFileRequest(null)).toBeNull();
    expect(parseFileRequest('index.html')).toBeNull();
    expect(parseFileRequest([ID, 'index.html'])).toBeNull();
  });

  it('write request also needs text and the BOM flag', () => {
    const good = { projectId: ID, relPath: 'index.html', text: '<p>你好</p>', bom: false };
    expect(parseWriteFileRequest(good)).toEqual(good);
    expect(parseWriteFileRequest({ ...good, text: 42 })).toBeNull();
    expect(parseWriteFileRequest({ ...good, bom: 'no' })).toBeNull();
    expect(parseWriteFileRequest({ ...good, path: 'C:/x' })).toBeNull();
    expect(parseWriteFileRequest({ ...good, relPath: '/abs' })).toBeNull();
    expect(parseWriteFileRequest({ ...good, text: 'x'.repeat(5 * 1024 * 1024 + 1) })).toBeNull();
  });

  it('project request and no-payload channels', () => {
    expect(parseProjectRequest({ projectId: ID })).toEqual({ projectId: ID });
    expect(parseProjectRequest({ projectId: ID, x: 1 })).toBeNull();
    expect(parseNoPayload(undefined)).toBeUndefined();
    expect(parseNoPayload({})).toBeNull();
  });

  it('a prototype-polluting payload is just an extra key', () => {
    const polluted = JSON.parse(`{"projectId":"${ID}","relPath":"a","__proto__":{"x":1}}`) as unknown;
    expect(parseFileRequest(polluted)).toBeNull();
  });
});

describe('IPC results', () => {
  it('drop the cause before crossing the process boundary', () => {
    expect(toIpcResult(err('read-failed', 'EACCES', new Error('secret detail')))).toEqual({
      ok: false,
      code: 'read-failed',
      message: 'EACCES',
    });
    expect(toIpcResult(ok(1))).toEqual({ ok: true, value: 1 });
  });

  it('channel names are unique and namespaced', () => {
    const names = Object.values(CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^(workspace|recovery):[a-z-]+$/);
  });
});
