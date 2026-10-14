import { describe, expect, it } from 'vitest';
import { languageForPath } from './language';

describe('languageForPath', () => {
  it.each([
    ['index.html', 'html'],
    ['子 文件夹/页面 二.HTM', 'html'],
    ['css/style.css', 'css'],
    ['script.js', 'javascript'],
    ['app.mjs', 'javascript'],
    ['data.json', 'json'],
    ['README.md', 'plaintext'],
    ['.gitignore', 'plaintext'],
    ['Makefile', 'plaintext'],
    ['dir.v2/file', 'plaintext'],
  ])('%s → %s', (p, lang) => expect(languageForPath(p)).toBe(lang));
});
