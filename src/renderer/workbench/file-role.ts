import type { MessageKey } from '../i18n/index';

/**
 * File roles (S20.3): a beginner sees what each file is for — index.html is the page structure, style.css the visual
 * styling, script.js the interactive behavior (PLAN §2, wireframe editor-preview #4/#5). Real file names are always
 * shown; the role is an extra, short hint. Pure: decided by the extension only, never by the file's contents.
 */
export type FileRole = 'structure' | 'style' | 'behavior' | 'image' | 'font' | 'data';

const BY_EXTENSION: Readonly<Record<string, FileRole>> = {
  html: 'structure',
  htm: 'structure',
  css: 'style',
  js: 'behavior',
  mjs: 'behavior',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  avif: 'image',
  ico: 'image',
  bmp: 'image',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  json: 'data',
};

/** The role of a project file from its `/`- or `\`-separated relative path, or null when it has no beginner role. */
export function fileRoleFor(relPath: string): FileRole | null {
  const name = relPath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  // ".css" alone is a dot-file, not a stylesheet.
  if (dot <= 0 || dot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function fileRoleLabelKey(role: FileRole): MessageKey {
  return `fileRole.${role}`;
}

export function fileRoleDetailKey(role: FileRole): MessageKey {
  return `fileRole.${role}.detail`;
}
