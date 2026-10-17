/**
 * S52.6: which project files open in the image viewer tab, and the URL the workbench shows them through. Pure, used
 * by main (the app protocol's `project` host) and the renderer.
 *
 * Images are served by the app protocol (`noobide://project/<projectId>/<path>`), never by the preview server: the
 * preview's own session cannot reach this host, and main resolves every request inside the project root.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'] as const;

const MIME: Readonly<Record<(typeof IMAGE_EXTENSIONS)[number], string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Largest image the viewer shows (bytes). */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export const PROJECT_IMAGE_HOST = 'project';

function extensionOf(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * True for png, jpg/jpeg, gif, svg, webp and ico (by the name's ending, ignoring case) outside hidden (dot) names,
 * which the tree, the preview server and the viewer never show.
 */
export function isImagePath(relPath: string): boolean {
  if (relPath.split('/').some((segment) => segment.startsWith('.'))) return false;
  return (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(relPath));
}

/** The Content-Type of an image path; null for anything that is not a viewer image. */
export function imageContentType(relPath: string): string | null {
  if (!isImagePath(relPath)) return null;
  const ext = extensionOf(relPath) as keyof typeof MIME;
  return MIME[ext] ?? null;
}

/**
 * The viewer URL of a project image. Every path segment is percent-encoded (Chinese names, spaces, `#`, `?`);
 * `version` (the file's mtime) makes the viewer load a changed file again.
 */
export function projectImageUrl(scheme: string, projectId: string, relPath: string, version?: number): string {
  const path = relPath.split('/').map(encodeURIComponent).join('/');
  return `${scheme}://${PROJECT_IMAGE_HOST}/${projectId}/${path}${version === undefined ? '' : `?v=${version}`}`;
}

/** Parses a viewer URL back into its project id and portable relative path; null for anything else. */
export function parseProjectImageUrl(
  scheme: string,
  requestUrl: string,
): { readonly projectId: string; readonly relPath: string } | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.host !== PROJECT_IMAGE_HOST) return null;
  const raw = url.pathname.split('/').slice(1);
  if (raw.length < 2) return null;
  let segments: string[];
  try {
    segments = raw.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const [projectId, ...rest] = segments;
  if (projectId === undefined) return null;
  return { projectId, relPath: rest.join('/') };
}

/**
 * The path of `target` as written in an HTML file at `from` (both portable project paths): `img/a.png` from
 * `index.html`, `../img/a.png` from `pages/about.html`. Segments are URL-encoded the way a browser needs them
 * (spaces as %20, Chinese characters kept readable).
 */
export function relativeHref(from: string, target: string): string {
  const fromDir = from.split('/').slice(0, -1);
  const to = target.split('/');
  let common = 0;
  while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common]) common += 1;
  const up = fromDir.slice(common).map(() => '..');
  return [...up, ...to.slice(common)].map(encodeHrefSegment).join('/');
}

/** Encodes what must be encoded in an href segment, keeping non-ASCII letters (e.g. Chinese) readable. */
function encodeHrefSegment(segment: string): string {
  if (segment === '..') return segment;
  return segment.replace(/[\s"#%'<>?\\^`{|}]/g, (ch) => encodeURIComponent(ch));
}

/** `<img src="…" alt="…">` for an image, relative to the HTML file at `from`. The alt text is the file's name. */
export function imgTag(from: string, target: string): string {
  const name = target.slice(target.lastIndexOf('/') + 1);
  const alt = name.slice(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length);
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<img src="${escape(relativeHref(from, target))}" alt="${escape(alt)}">`;
}
