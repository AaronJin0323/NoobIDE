/**
 * S41.2: an annotation target (what the page reported) → where it is in the project's files now (decision 0030).
 * Main process only. Files are read through the static server's own resolution (`resolveInRoot`: inside the real
 * root, no dotfiles, links checked), so an annotation can never make main read outside the project. Nothing logs.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AnnotationCssLocation,
  AnnotationLocation,
  AnnotationSource,
  AnnotationTarget,
} from '../shared/ipc/annotations-contract';
import { decodeText } from '../workspace/text-codec';
import { resolveInRoot } from './request-path';
import { locateCssRule, locateElement, MAX_LOCATE_CHARS, styleBlock } from './source-locate';

/** Segments of a project-relative URL path (`a/b.html`, '' = the index page), or null when it is not a plain path. */
function segmentsOf(pagePath: string): { segments: string[]; directory: boolean } | null {
  const directory = pagePath === '' || pagePath.endsWith('/');
  const segments = pagePath.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..' || s.startsWith('.') || /[\\\0:]/.test(s))) return null;
  return { segments, directory };
}

export interface ReadProjectText {
  /** Text of a project file named by its URL path, with its project-relative path; null when it cannot be read. */
  (pagePath: string): Promise<{ readonly relPath: string; readonly text: string } | null>;
}

/** Reads project files for the locator: inside `realRoot` only, UTF-8 text only, at most MAX_LOCATE_CHARS. */
export function projectTextReader(realRoot: string): ReadProjectText {
  const cache = new Map<string, Promise<{ relPath: string; text: string } | null>>();
  const read = async (pagePath: string) => {
    const target = segmentsOf(pagePath);
    if (!target) return null;
    const resolved = await resolveInRoot(realRoot, target);
    if (!resolved.ok) return null;
    try {
      if ((await stat(resolved.value)).size > MAX_LOCATE_CHARS * 3) return null;
      const decoded = decodeText(await readFile(resolved.value));
      if (!decoded.ok || decoded.text.length > MAX_LOCATE_CHARS) return null;
      const relPath = path.relative(realRoot, resolved.value).split(path.sep).join('/');
      return { relPath, text: decoded.text };
    } catch {
      return null;
    }
  };
  return (pagePath) => {
    let pending = cache.get(pagePath);
    if (!pending) {
      pending = read(pagePath);
      cache.set(pagePath, pending);
    }
    return pending;
  };
}

/** Where `target` is in the project now: the page's element and the CSS rules that style it. */
export async function locateTarget(target: AnnotationTarget, read: ReadProjectText): Promise<AnnotationSource> {
  const page = await read(target.pagePath);
  const css: AnnotationCssLocation[] = [];
  for (const rule of target.rules) {
    if (rule.sheet.kind === 'file') {
      const file = await read(rule.sheet.path);
      const range = file ? locateCssRule(file.text, rule.selector, rule.occurrence) : null;
      if (file && range) {
        css.push({ relPath: file.relPath, startLine: range.startLine, endLine: range.endLine, match: 'exact', selector: rule.selector }); // prettier-ignore
      }
    } else if (page) {
      const block = styleBlock(page.text, rule.sheet.index);
      const range = block ? locateCssRule(page.text, rule.selector, rule.occurrence, block.start, block.end) : null;
      if (range) {
        css.push({ relPath: page.relPath, startLine: range.startLine, endLine: range.endLine, match: 'exact', selector: rule.selector }); // prettier-ignore
      }
    }
  }
  if (!page) return { state: 'no-file', html: null, css };
  const found = locateElement(page.text, {
    ancestry: target.ancestry,
    tag: target.tag,
    id: target.id,
    classes: target.classes,
    text: target.text,
  });
  const html: AnnotationLocation | null = found
    ? { relPath: page.relPath, startLine: found.startLine, endLine: found.endLine, match: found.match }
    : null;
  return { state: !html ? 'not-found' : html.match === 'exact' ? 'found' : 'approximate', html, css };
}
