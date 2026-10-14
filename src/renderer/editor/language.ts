/** Monaco language id for a file, from its extension (case-insensitive: `INDEX.HTML` is HTML too). */
const BY_EXTENSION: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
};

export function languageForPath(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}
