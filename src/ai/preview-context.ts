/**
 * S38.2: what the AI assistant learns about the running preview (decision 0026). Main process only, no Electron
 * imports (structural types; main passes the PreviewManager).
 *
 * One capture combines the S38.1 page snapshot (path, title, outline, optional screenshot) with the preview's recent
 * errors (uncaught exceptions, console errors, failed requests) named by project file and line. The same text is shown
 * in the chat's Preview chip and sent as context, so the user sees exactly what is sent. Page content is untrusted
 * data: callers frame it (chat `<preview>` tag + neutralizeData, agent nonce frame + neutralizeData) and never log it.
 */
import { projectFileFromUrl } from '../diagnostics/normalize';
import type { PreviewLogEntry, PreviewStatus } from '../shared/ipc/preview-contract';
import type { Result } from '../shared/result';
import { formatOutline, type PageSnapshot } from '../preview/page-snapshot';

export type PreviewLocale = 'zh-CN' | 'en';

/** The parts of the PreviewManager the AI layer uses. */
export interface PreviewSource {
  getStatus(): PreviewStatus;
  recentRecords(): readonly PreviewLogEntry[];
  pageSnapshot(
    projectId: string,
    options: { readonly screenshot: boolean },
  ): Promise<Result<PageSnapshot, 'not-running' | 'not-available'>>;
}

export const PREVIEW_CONTEXT_LIMITS = {
  errors: 20,
  uncaught: 10,
  messageChars: 300,
} as const;

export interface PreviewCapture {
  readonly path: string;
  readonly title: string;
  readonly outline: string | null;
  readonly outlineTruncated: boolean;
  /** Recent errors, newest last, one line each (`script.js:3 Uncaught ReferenceError: …`). */
  readonly errors: readonly string[];
  /** Base64 PNG, when a screenshot was asked for and could be taken. */
  readonly png: string | null;
  readonly width: number;
  readonly height: number;
}

/** The preview's origin, from the URL main started it with (`<origin>/<entry page>`). */
export function previewOrigin(status: PreviewStatus): string | null {
  if (!status.url) return null;
  try {
    return new URL(status.url).origin;
  } catch {
    return null;
  }
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Where a record happened: a project file with its line, another URL's origin and path, or nothing. */
export function recordLocation(entry: PreviewLogEntry, origin: string | null): string {
  if (!entry.url) return '';
  const file = origin ? projectFileFromUrl(entry.url, origin) : undefined;
  if (file) return `${file}${entry.line ? `:${entry.line}` : ''}`;
  try {
    const u = new URL(entry.url);
    return clip(`${u.origin}${u.pathname}`, 200);
  } catch {
    return '';
  }
}

/** One line for a console record (no `[level]` prefix): `exception script.js:3: Uncaught ReferenceError: …`. */
export function recordLine(entry: PreviewLogEntry, origin: string | null, maxChars: number): string {
  const where = recordLocation(entry, origin);
  return `${entry.source}${where ? ` ${where}` : ''}: ${clip(entry.message, maxChars)}`;
}

/** The preview's recent errors (exceptions, console errors, failed requests), oldest first, bounded. */
export function recentErrors(records: readonly PreviewLogEntry[], origin: string | null): string[] {
  const errors = records.filter((r) => r.level === 'error');
  return errors
    .slice(Math.max(0, errors.length - PREVIEW_CONTEXT_LIMITS.errors))
    .map((r) => recordLine(r, origin, PREVIEW_CONTEXT_LIMITS.messageChars));
}

/** Takes a snapshot of `projectId`'s preview plus its recent errors. */
export async function capturePreview(
  source: PreviewSource,
  projectId: string,
  options: { readonly screenshot: boolean },
): Promise<Result<PreviewCapture, 'not-running' | 'not-available'>> {
  const status = source.getStatus();
  if (status.projectId !== projectId || status.state === 'stopped') {
    return { ok: false, code: 'not-running', message: 'the preview of this project is not running' };
  }
  const snapshot = await source.pageSnapshot(projectId, options);
  if (!snapshot.ok) return snapshot;
  const value = snapshot.value;
  const outline = value.outline ? formatOutline(value.outline) : null;
  return {
    ok: true,
    value: {
      path: value.path ?? '',
      title: value.title,
      outline: outline?.text ?? null,
      outlineTruncated: outline?.truncated ?? false,
      errors: recentErrors(source.recentRecords(), previewOrigin(status)),
      png: value.screenshot ? value.screenshot.png.toString('base64') : null,
      width: value.screenshot?.width ?? 0,
      height: value.screenshot?.height ?? 0,
    },
  };
}

const LABELS = {
  'zh-CN': {
    page: '页面',
    startPage: '（项目的首页）',
    title: '标题',
    outline: '页面结构（标题、链接、按钮、表单、图片，按页面顺序）',
    noOutline: '页面结构：现在读不到（网页没有及时回应）',
    shortened: '（页面结构太长，后面的省略了）',
    errors: '预览里最近的错误',
    noErrors: '预览里最近的错误：没有',
  },
  en: {
    page: 'Page',
    startPage: "(the project's start page)",
    title: 'Title',
    outline: 'Page outline (headings, links, buttons, form fields, images; in page order)',
    noOutline: 'Page outline: not available (the page did not answer in time)',
    shortened: '(outline shortened)',
    errors: 'Recent errors in the preview',
    noErrors: 'Recent errors in the preview: none',
  },
} as const;

/** The text of the Preview context item (shown in the chip, sent as context): page, title, outline, errors. */
export function previewContextText(capture: PreviewCapture, locale: PreviewLocale): string {
  const l = LABELS[locale];
  const colon = locale === 'zh-CN' ? '：' : ': ';
  const lines = [`${l.page}${colon}${capture.path || l.startPage}`, `${l.title}${colon}${capture.title}`];
  if (capture.outline === null) lines.push(l.noOutline);
  else {
    lines.push(`${l.outline}${colon.trim()}`, capture.outline || '-');
    if (capture.outlineTruncated) lines.push(l.shortened);
  }
  if (capture.errors.length === 0) lines.push(l.noErrors);
  else lines.push(`${l.errors}${colon.trim()}`, ...capture.errors);
  return lines.join('\n');
}
