import { readFile, stat } from 'node:fs/promises';
import { isPortableRelPath, isProjectId } from '../shared/ipc/contract';
import { MAX_IMAGE_BYTES, imageContentType, parseProjectImageUrl } from '../shared/image-files';
import { resolveExisting } from '../workspace/paths';
import type { FileOpError } from '../shared/ipc/contract';
import { err, ok, type Result } from '../shared/result';

/**
 * S52.6: serves project images to the workbench's image viewer tab on the app protocol's `project` host
 * (`noobide://project/<projectId>/<path>`). Never the preview server, and never a path outside the project:
 *
 * - GET/HEAD only; the project must be open; the path must be portable and name a viewer image (by its ending);
 * - it is resolved and realpath-checked inside the project root (links and junctions cannot lead out) and must be a
 *   regular file within the size cap;
 * - every response carries `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
 *   `nosniff`, so an SVG opened on its own runs no scripts (in an `<img>` it never does).
 *
 * Registered on the default session only, so the preview's own session partition has no `noobide://project` host.
 */
// Known limits (decision-free, documented here): a hard link inside the project to a file elsewhere passes the
// realpath check, and a folder swapped for a junction between the check and the read is not caught. Only the trusted
// workbench can ask (the preview's session has no handler for this host), so this does not reach user pages.
export const IMAGE_RESPONSE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * S52.6: the size of a project image for the viewer tab, with the same checks as {@link serveProjectImage} (an
 * image by its ending, realpath-checked inside the root, a regular file within the cap).
 */
export async function projectImageInfo(
  root: string,
  relPath: string,
): Promise<Result<{ bytes: number; mtimeMs: number }, FileOpError>> {
  if (imageContentType(relPath) === null) return err('op-failed', 'not an image');
  const resolved = await resolveExisting(root, relPath);
  if (!resolved.ok) return err(resolved.code, resolved.message);
  try {
    const info = await stat(resolved.path);
    if (!info.isFile()) return err('not-found', 'not a file');
    if (info.size > MAX_IMAGE_BYTES) return err('too-large', `${info.size} bytes`);
    return ok({ bytes: info.size, mtimeMs: info.mtimeMs });
  } catch (e) {
    return err('not-found', e instanceof Error ? e.message : 'stat failed');
  }
}

export interface ProjectImageDeps {
  readonly scheme: string;
  rootOf(projectId: string): string | undefined;
}

export async function serveProjectImage(request: Request, deps: ProjectImageDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  const parsed = parseProjectImageUrl(deps.scheme, request.url);
  if (!parsed || !isProjectId(parsed.projectId) || !isPortableRelPath(parsed.relPath)) {
    return new Response(null, { status: 400 });
  }
  const type = imageContentType(parsed.relPath);
  if (type === null) return new Response(null, { status: 415 });
  const root = deps.rootOf(parsed.projectId);
  if (root === undefined) return new Response(null, { status: 404 });
  const resolved = await resolveExisting(root, parsed.relPath);
  if (!resolved.ok) return new Response(null, { status: resolved.code === 'outside-project' ? 403 : 404 });
  try {
    const info = await stat(resolved.path);
    if (!info.isFile()) return new Response(null, { status: 404 });
    if (info.size > MAX_IMAGE_BYTES) return new Response(null, { status: 413 });
    const body = request.method === 'HEAD' ? null : await readFile(resolved.path);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(info.size),
        'Content-Security-Policy': IMAGE_RESPONSE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
