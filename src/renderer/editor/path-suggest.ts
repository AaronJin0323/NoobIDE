/**
 * Project file path suggestions (S43.4 / S43.5, decision 0032 "Context-aware completion"). Given the project's files
 * (portable relative paths with `/`) and the text typed so far inside `src="…"`, `url(…)` or an `import '…'`, it lists
 * the files and folders of the folder that text points at, relative to the current file. Never absolute, never the
 * current file, never dotfiles or dot folders (`.noobide`, `.git`). Chinese names and spaces are inserted as written on
 * disk; when the user's text is already percent-encoded, the suggestion is encoded too.
 *
 * Pure and Monaco-free. Nothing is logged.
 */
import type { PathAccept } from './completion-context';

export interface PathSuggestion {
  /** Replaces the whole typed prefix (folder part included). */
  readonly insertText: string;
  /** The remaining path piece shown in the list (`name.png`, `folder/`). */
  readonly label: string;
  readonly isDirectory: boolean;
}

export const MAX_PATH_SUGGESTIONS = 200;

const EXTENSIONS: Record<Exclude<PathAccept, 'any'>, ReadonlySet<string>> = {
  media: new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'avif',
    'ico',
    'bmp',
    'mp3',
    'wav',
    'ogg',
    'm4a',
    'mp4',
    'webm',
    'mov',
    'woff',
    'woff2',
    'ttf',
    'otf',
  ]),
  css: new Set(['css']),
  js: new Set(['js', 'mjs']),
  html: new Set(['html', 'htm']),
};

/** Whether a file is a sensible target for the given kind of reference. */
export function acceptsPath(relPath: string, accept: PathAccept): boolean {
  if (accept === 'any') return true;
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return EXTENSIONS[accept].has(name.slice(dot + 1).toLowerCase());
}

const ENCODED = /%[0-9A-Fa-f]{2}/;

function safeDecode(s: string): string | null {
  try {
    return decodeURI(s);
  } catch {
    return null;
  }
}

const collator = new Intl.Collator('zh-CN');

/**
 * All project files → suggestions relative to `fromRelPath`'s folder, filtered by `accept`, matching `prefix` (the text
 * typed so far inside the quotes; may contain `../` or `images/`). Files first, then folders (`name/`), each sorted
 * with the zh-CN collation; at most MAX_PATH_SUGGESTIONS. For `js` the insert text starts with `./` or `../`.
 */
export function suggestPaths(input: {
  files: readonly string[];
  fromRelPath: string;
  prefix: string;
  accept: PathAccept;
  js: boolean;
}): PathSuggestion[] {
  const { files, fromRelPath, accept, js } = input;
  if (input.prefix.startsWith('/') || input.prefix.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(input.prefix)) {
    return [];
  }
  const encoded = ENCODED.test(input.prefix);
  const prefix = encoded ? safeDecode(input.prefix) : input.prefix;
  if (prefix === null) return [];

  const slash = input.prefix.lastIndexOf('/');
  const typedDir = input.prefix.slice(0, slash + 1); // as typed, kept verbatim
  const partial = prefix.slice(prefix.lastIndexOf('/') + 1).toLowerCase();

  const dir = fromRelPath.split('/').slice(0, -1);
  for (const seg of prefix.split('/').slice(0, -1)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (dir.length === 0) return [];
      dir.pop();
    } else {
      dir.push(seg);
    }
  }
  const base = dir.length ? `${dir.join('/')}/` : '';
  const lead = js && !typedDir.startsWith('./') && !typedDir.startsWith('../') ? `./${typedDir}` : typedDir;
  const encode = (name: string): string => (encoded ? encodeURIComponent(name) : name);

  const fileNames: string[] = [];
  const dirNames = new Set<string>();
  for (const file of files) {
    if (file === fromRelPath || !file.startsWith(base)) continue;
    if (file.split('/').some((seg) => seg.startsWith('.') || seg === '')) continue;
    if (!acceptsPath(file, accept)) continue;
    const rest = file.slice(base.length);
    const cut = rest.indexOf('/');
    const name = cut < 0 ? rest : rest.slice(0, cut);
    if (!name.toLowerCase().startsWith(partial)) continue;
    if (cut < 0) fileNames.push(name);
    else dirNames.add(name);
  }

  const sorted = (xs: Iterable<string>): string[] => [...xs].sort((a, b) => collator.compare(a, b));
  const out: PathSuggestion[] = [];
  for (const name of sorted(fileNames)) {
    out.push({ insertText: lead + encode(name), label: name, isDirectory: false });
  }
  for (const name of sorted(dirNames)) {
    out.push({ insertText: `${lead}${encode(name)}/`, label: `${name}/`, isDirectory: true });
  }
  return out.slice(0, MAX_PATH_SUGGESTIONS);
}
