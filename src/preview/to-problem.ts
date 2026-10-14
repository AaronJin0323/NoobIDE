import { normalizePageError, projectPathFromUrl } from '../diagnostics/normalize';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import type { PreviewAttribution, ProblemInput, ResourceType } from '../shared/problem';

/**
 * Bridges the S05.4 raw preview records into the shared diagnostics model (src/shared/problem.ts) so the runtime
 * capture adapter (S16.2) and the ProblemStore consume one shape. Pure: no Electron.
 *
 * - `exception` (Chromium's "Uncaught …" console record) → normalizePageError → source 'runtime'.
 * - `console` error / warning → source 'console' (info and debug output are not problems).
 * - `network` → source 'resource', code 'resource-failed', with the requested path and HTTP status / net error.
 * - `page-load` records (blocked navigation, window.open) are preview notices, not problems → null.
 */
export interface ToProblemOptions {
  readonly projectId: string;
  readonly preview: PreviewAttribution;
  /** e.g. 'http://127.0.0.1:51734' */
  readonly previewOrigin: string;
}

export function previewEntryToProblem(entry: PreviewLogEntry, opts: ToProblemOptions): ProblemInput | null {
  switch (entry.source) {
    case 'exception':
      return normalizePageError(
        {
          kind: /^Uncaught \(in promise\)/.test(entry.message) ? 'unhandledrejection' : 'error',
          message: entry.message,
          ...(entry.url ? { filename: entry.url } : {}),
          ...(entry.line ? { lineno: entry.line } : {}),
        },
        { projectId: opts.projectId, preview: opts.preview, previewOrigin: opts.previewOrigin, at: entry.at },
      );
    case 'console': {
      if (entry.level !== 'error' && entry.level !== 'warning') return null;
      const file = entry.url ? projectPathFromUrl(entry.url, opts.previewOrigin) : undefined;
      return {
        source: 'console',
        severity: entry.level === 'error' ? 'error' : 'warning',
        projectId: opts.projectId,
        preview: opts.preview,
        code: entry.level === 'error' ? 'console-error' : 'console-warning',
        message: entry.message,
        ...(file ? { file } : {}),
        ...(file && entry.line ? { line: entry.line } : {}),
        at: entry.at,
      };
    }
    case 'network': {
      if (!entry.url) return null;
      const requestedPath = projectPathFromUrl(entry.url, opts.previewOrigin);
      const resourceType = mapResourceType(entry.resourceType);
      const netError = /^net::[A-Z_]+/.exec(entry.message)?.[0];
      return {
        source: 'resource',
        severity: 'error',
        projectId: opts.projectId,
        preview: opts.preview,
        code: 'resource-failed',
        message: entry.message,
        resource: {
          requestedUrl: entry.url,
          ...(requestedPath ? { requestedPath } : {}),
          ...(entry.status !== undefined ? { status: entry.status } : {}),
          ...(resourceType ? { resourceType } : {}),
          ...(netError ? { netError } : {}),
        },
        at: entry.at,
      };
    }
    case 'page-load':
      return null;
  }
}

/** Electron webRequest resource types → the diagnostics model's coarser categories. */
export function mapResourceType(type: string | undefined): ResourceType | undefined {
  switch (type) {
    case undefined:
      return undefined;
    case 'script':
      return 'script';
    case 'stylesheet':
      return 'stylesheet';
    case 'image':
      return 'image';
    case 'font':
      return 'font';
    case 'media':
      return 'media';
    case 'xhr':
      return 'fetch';
    case 'mainFrame':
    case 'subFrame':
      return 'document';
    default:
      return 'other';
  }
}
