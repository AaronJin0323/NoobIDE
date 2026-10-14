import { describe, expect, it } from 'vitest';
import { parseRequestTarget } from './request-path';

describe('parseRequestTarget (S04.1)', () => {
  it.each([
    ['/', [], true],
    ['/index.html', ['index.html'], false],
    ['/css/style.css?v=2#top', ['css', 'style.css'], false],
    ['/%E5%AD%90%20%E6%96%87%E4%BB%B6%E5%A4%B9/', ['子 文件夹'], true],
    ['/a%20b/%E9%A1%B5%E9%9D%A2.html', ['a b', '页面.html'], false],
  ])('accepts %s', (target, segments, directory) => {
    expect(parseRequestTarget(target)).toEqual({ ok: true, value: { segments, directory } });
  });

  it.each([
    ['', 'empty'],
    ['index.html', 'relative'],
    ['//evil.example/x', 'protocol-relative'],
    ['http://127.0.0.1:1/index.html', 'absolute-form'],
    ['*', 'asterisk-form'],
    ['/../secret.txt', 'dot-dot'],
    ['/a/../../secret.txt', 'nested dot-dot'],
    ['/%2e%2e/secret.txt', 'encoded dot-dot'],
    ['/%2E%2E%2Fsecret.txt', 'encoded dot-dot and slash'],
    ['/a/./b', 'dot segment'],
    ['/..\\secret.txt', 'backslash'],
    ['/..%5csecret.txt', 'encoded backslash'],
    ['/a%2fb', 'encoded slash'],
    ['/a//b', 'empty segment'],
    ['/C:/Windows/win.ini', 'drive letter'],
    ['/C%3A/Windows/win.ini', 'encoded drive letter'],
    ['/index.html::$DATA', 'alternate data stream'],
    ['/a%00.html', 'NUL'],
    ['/%E0%A4%A', 'broken percent-encoding'],
    ['/CON', 'device name'],
    ['/nul.txt', 'device name with extension'],
    ['/com1.html', 'COM device'],
    ['/con%20.txt', 'device name with trailing space'],
    ['/nul.', 'device name with trailing dot'],
    ['/a%3Fb.html', 'question mark'],
    ['/a%2Ab', 'wildcard'],
    ['/a%22b', 'double quote'],
    ['/a%3Cb%3E', 'angle brackets'],
    ['/a%7Cb', 'pipe'],
    ['/a%0Ab', 'control character'],
  ])('rejects %s (%s) as a bad request', (target) => {
    expect(parseRequestTarget(target)).toMatchObject({ ok: false, code: 'bad-request' });
  });

  it.each([
    '/.git/config',
    '/.noobide/project.json',
    '/.env',
    '/sub/.env.local',
    '/%2egit/HEAD',
    '/%2Eenv',
    '/.well-known/x',
    '/..foo/x.js',
  ])('denies the dotfile path %s', (target) => {
    expect(parseRequestTarget(target)).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
