import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENTRY_URL, contentTypeFor, resolveAppAsset } from './app-asset';

const root = path.resolve('构建 输出', 'renderer', 'main_window');

describe('noobide:// asset resolution', () => {
  it('maps the entry URL and assets inside the build directory (Chinese + space path)', () => {
    expect(resolveAppAsset(root, APP_ENTRY_URL)).toEqual({ ok: true, value: path.join(root, 'index.html') });
    expect(resolveAppAsset(root, 'noobide://app/')).toEqual({ ok: true, value: path.join(root, 'index.html') });
    expect(resolveAppAsset(root, 'noobide://app/assets/css.worker-x.js?worker_file')).toEqual({
      ok: true,
      value: path.join(root, 'assets', 'css.worker-x.js'),
    });
  });

  it('refuses traversal, encoded traversal and other hosts or schemes', () => {
    for (const url of [
      'noobide://app/../../secret.txt',
      'noobide://app/%2e%2e/%2e%2e/secret.txt',
      'noobide://app/assets/..%2f..%2f..%2fsecret.txt',
    ]) {
      const r = resolveAppAsset(root, url);
      if (r.ok) expect(path.relative(root, r.value).startsWith('..')).toBe(false);
      else expect(r.code).toBe('outside-root');
    }
    expect(resolveAppAsset(root, 'noobide://evil/index.html')).toMatchObject({ ok: false, code: 'wrong-host' });
    expect(resolveAppAsset(root, 'file:///etc/passwd')).toMatchObject({ ok: false, code: 'bad-url' });
    expect(resolveAppAsset(root, 'noobide://app/%E0%A4%A')).toMatchObject({ ok: false, code: 'bad-url' });
    expect(resolveAppAsset(root, 'noobide://app/a%00b')).toMatchObject({ ok: false, code: 'bad-url' });
  });

  it('serves scripts and workers with a JavaScript MIME type (module workers require it)', () => {
    expect(contentTypeFor('a/index.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a/codicon.TTF')).toBe('font/ttf');
    expect(contentTypeFor('a/unknown.bin')).toBe('application/octet-stream');
  });
});
