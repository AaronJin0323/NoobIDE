import path from 'node:path';

/**
 * Content types for files a beginner's static site uses (S04.2). Served with `X-Content-Type-Options: nosniff`, so
 * these must be right: a module script with a wrong type is refused by the browser. Unknown types fall back to
 * `application/octet-stream`, which the browser downloads or ignores but never executes.
 */
const TEXT = '; charset=utf-8';

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': `text/html${TEXT}`,
  '.htm': `text/html${TEXT}`,
  '.css': `text/css${TEXT}`,
  '.js': `text/javascript${TEXT}`,
  '.mjs': `text/javascript${TEXT}`,
  '.cjs': `text/javascript${TEXT}`,
  '.json': `application/json${TEXT}`,
  '.map': `application/json${TEXT}`,
  '.webmanifest': `application/manifest+json${TEXT}`,
  '.txt': `text/plain${TEXT}`,
  '.md': `text/markdown${TEXT}`,
  '.csv': `text/csv${TEXT}`,
  '.xml': `application/xml${TEXT}`,
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
