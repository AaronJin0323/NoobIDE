/**
 * What the preview page may request and where it may navigate (S04.3, S05.5, PLAN §8). Pure functions, applied in
 * main through the preview session's webRequest and the view's navigation events.
 *
 * - Requests: the project's own server is allowed. `file:` and every other loopback address (other ports,
 *   `localhost`, `[::1]`, `0.0.0.0`) are blocked, so a page cannot read local files or talk to other local services.
 *   Public web resources stay allowed — the user's page may use a CDN like any webpage, and normal browser
 *   same-origin and CORS checks still apply (PLAN §8 does not let us disable them).
 * - Top-level navigation: only within the project's server origin. Leaving it is blocked; the workbench may later
 *   offer to open the address in the external browser.
 */

export function urlOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/** Hostnames that reach this machine without DNS. The WHATWG URL parser already normalises 0x7f.1, 2130706433 etc. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0') return true;
  if (host === '::1' || host === '::' || /^0*:(0*:)*0*:?0*1$/.test(host)) return true;
  // IPv4-mapped IPv6 loopback, e.g. ::ffff:127.0.0.1 (normalised by URL to ::ffff:7f00:1).
  return /^::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|127\.\d+\.\d+\.\d+|0:0)$/.test(host);
}

export type RequestDecision = 'allow' | 'block';

export function decidePreviewRequest(url: string, serverOrigin: string): RequestDecision {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'block';
  }
  if (u.origin === serverOrigin) return 'allow';
  switch (u.protocol) {
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:':
      return isLoopbackHost(u.hostname) ? 'block' : 'allow';
    case 'data:':
    case 'blob:':
      return 'allow';
    case 'devtools:':
      return 'allow'; // DevTools front-end resources, requested by the browser, not by the page.
    default:
      // file:, ftp:, custom app schemes (noobide://) and anything unknown.
      return 'block';
  }
}

export function isAllowedNavigation(url: string, serverOrigin: string): boolean {
  return urlOrigin(url) === serverOrigin;
}
