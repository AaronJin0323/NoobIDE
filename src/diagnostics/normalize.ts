/**
 * Turns a page error as the preview reports it (window `error` / `unhandledrejection` data) into a ProblemInput.
 * Pure helper for the runtime capture adapter (S16.2), which supplies the raw data and the preview's origin.
 *
 * - Script URLs on the preview origin become project-relative paths (decoded, so Chinese names and spaces survive).
 * - Scripts on other origins keep their URL in `data.scriptUrl`; they are not project files.
 * - Line/column 0 mean "unknown" and are dropped.
 * - An opaque cross-origin error ("Script error." with no location, S16.6) gets the code
 *   `cross-origin-script-error` so the explanation can say why the location is unavailable.
 */
import type { PreviewAttribution, ProblemInput } from '../shared/problem';

export const CROSS_ORIGIN_SCRIPT_ERROR = 'cross-origin-script-error';

export interface RawPageError {
  readonly kind: 'error' | 'unhandledrejection';
  readonly message: string;
  /** Script URL as reported by the browser ('' when hidden). */
  readonly filename?: string;
  readonly lineno?: number;
  readonly colno?: number;
  readonly stack?: string;
  /** error.name when the page could read it, e.g. 'ReferenceError'. */
  readonly errorName?: string;
}

export interface NormalizeOptions {
  readonly projectId: string;
  readonly preview: PreviewAttribution;
  /** e.g. 'http://127.0.0.1:51734' */
  readonly previewOrigin: string;
  readonly at: number;
}

/** True for the browser's muted cross-origin error: message "Script error." and no usable location. */
export function isOpaqueCrossOriginError(raw: RawPageError): boolean {
  return (
    raw.kind === 'error' &&
    /^(?:Uncaught )?Script error\.?$/.test(raw.message.trim()) &&
    !raw.filename &&
    !raw.lineno &&
    !raw.colno
  );
}

/** Project-relative path for a URL on the preview origin; undefined for other origins or unparsable URLs. */
export function projectPathFromUrl(url: string, previewOrigin: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(previewOrigin).origin) return undefined;
    const path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    return path || undefined;
  } catch {
    return undefined;
  }
}

const ERROR_NAME = /^(?:Uncaught (?:\(in promise\) )?)?([A-Z]\w*Error)\b/;

export function normalizePageError(raw: RawPageError, opts: NormalizeOptions): ProblemInput {
  const base = {
    source: 'runtime' as const,
    severity: 'error' as const,
    projectId: opts.projectId,
    preview: opts.preview,
    message: raw.message,
    ...(raw.stack ? { stack: raw.stack } : {}),
    at: opts.at,
  };
  if (isOpaqueCrossOriginError(raw)) return { ...base, code: CROSS_ORIGIN_SCRIPT_ERROR };

  const code =
    raw.kind === 'unhandledrejection'
      ? 'unhandledrejection'
      : (raw.errorName ?? ERROR_NAME.exec(raw.message)?.[1] ?? 'Error');
  const file = raw.filename ? projectPathFromUrl(raw.filename, opts.previewOrigin) : undefined;
  const line = file && raw.lineno && raw.lineno > 0 ? raw.lineno : undefined;
  const column = line && raw.colno && raw.colno > 0 ? raw.colno : undefined;
  return {
    ...base,
    code,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(raw.filename && !file ? { data: { scriptUrl: raw.filename } } : {}),
  };
}
