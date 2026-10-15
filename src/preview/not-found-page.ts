import { translate, type Locale } from '../renderer/i18n/index';

/**
 * The page the preview server answers with (status 404) when a page itself is missing, e.g. after clicking a link to
 * `about.html` that does not exist. Replaces Chromium's bare "404 Not Found" text with a short explanation in the
 * interface language. Only served to top-level page loads (`Sec-Fetch-Dest: document`); scripts, images and other
 * resources keep the plain 404 (static-server.ts).
 *
 * Safety: the requested path is the only request-controlled part and is HTML-escaped (and shortened); the page has no
 * script and its own Content-Security-Policy (static-server.ts) allows inline styles only.
 */

/** The longest requested path shown on the page (longer ones are cut with an ellipsis). */
export const MAX_SHOWN_PATH = 200;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * The project-relative path a request asked for, as shown to the user: the URL path without the leading slash,
 * query or fragment, percent-decoded when that is valid (else as sent), cut to MAX_SHOWN_PATH characters.
 */
export function shownRequestPath(rawTarget: string): string {
  const pathPart = (rawTarget.split(/[?#]/, 1)[0] ?? '').replace(/^\/+/, '');
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // keep the raw form
  }
  // Control characters and bidirectional overrides are never shown (they could make the path read misleadingly).
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this removes
  decoded = decoded.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  return decoded.length > MAX_SHOWN_PATH ? `${decoded.slice(0, MAX_SHOWN_PATH)}…` : decoded;
}

/** The whole HTML document for a missing page (`requestedPath` as from shownRequestPath; escaped here). */
export function notFoundPageHtml(requestedPath: string, locale: Locale): string {
  const t = (key: Parameters<typeof translate>[1]) => escapeHtml(translate(locale, key));
  const path = `<code>${escapeHtml(requestedPath || '/')}</code>`;
  // A function replacer: `$&` and friends in a file name must stay literal.
  const body = t('previewNotFound.body').replace('{path}', () => path);
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('previewNotFound.title')}</title>
<style>
  body { margin: 0; padding: 32px 24px; font: 15px/1.6 system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
    color: #1f2330; background: #ffffff; }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  code { padding: 1px 6px; border-radius: 6px; background: #eef0f5; font-family: Consolas, Menlo, monospace;
    overflow-wrap: anywhere; }
  p { margin: 0 0 10px; }
  .hint { color: #4a5063; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8eaf2; background: #16181f; }
    code { background: #262a35; }
    .hint { color: #b4b9c8; }
  }
</style>
</head>
<body>
<main>
<h1>${t('previewNotFound.title')}</h1>
<p>${body}</p>
<p class="hint">${t('previewNotFound.cause')}</p>
<p class="hint">${t('previewNotFound.next')}</p>
</main>
</body>
</html>
`;
}
