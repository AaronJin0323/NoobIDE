import { describe, expect, it } from 'vitest';
import { mimeTypeFor } from './mime';

describe('mimeTypeFor (S04.2)', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['页面 二.HTM', 'text/html; charset=utf-8'],
    ['style.css', 'text/css; charset=utf-8'],
    ['main.js', 'text/javascript; charset=utf-8'],
    ['util.mjs', 'text/javascript; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['photo.PNG', 'image/png'],
    ['photo.jpeg', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
    ['font.woff', 'font/woff'],
    ['clip.mp4', 'video/mp4'],
    ['module.wasm', 'application/wasm'],
  ])('%s → %s', (file, type) => {
    expect(mimeTypeFor(file)).toBe(type);
  });

  it('falls back to a type the browser never executes', () => {
    expect(mimeTypeFor('archive.zip')).toBe('application/octet-stream');
    expect(mimeTypeFor('Makefile')).toBe('application/octet-stream');
  });
});
