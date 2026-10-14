import path from 'node:path';
import { err, ok, type Result } from '../shared/result';

/**
 * The workbench UI is served from `noobide://app/…` instead of file:// (Electron security checklist: prefer a custom
 * protocol; lets the GrantFileProtocolExtraPrivileges fuse stay off). This module is the pure part: map a request
 * URL to a file inside the renderer build directory, or refuse it.
 */
export const APP_SCHEME = 'noobide';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

export type AssetError = 'bad-url' | 'wrong-host' | 'outside-root';

export function resolveAppAsset(rootDir: string, requestUrl: string): Result<string, AssetError> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch (e) {
    return err('bad-url', 'request URL could not be parsed', e);
  }
  if (url.protocol !== `${APP_SCHEME}:`) return err('bad-url', `unexpected scheme ${url.protocol}`);
  if (url.host !== APP_HOST) return err('wrong-host', `unexpected host ${url.host}`);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (e) {
    return err('bad-url', 'request path is not valid percent-encoding', e);
  }
  if (pathname.includes('\0')) return err('bad-url', 'request path contains NUL');
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return err('outside-root', 'request resolves outside the renderer build directory');
  }
  return ok(target);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
