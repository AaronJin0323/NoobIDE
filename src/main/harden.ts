import type { Session, WebContents } from 'electron';

/**
 * Runtime hardening of the workbench (S02.2). The workbench is trusted code, but it still must not navigate away,
 * open windows, get permissions or reach the network (offline-first: no CDN, AGENTS.md invariant).
 */

export interface BlockedRequest {
  readonly origin: string;
  readonly resourceType: string;
}

/** Requests the network guard refused. Metadata only (origin + type), never URLs with paths or payloads. */
export const blockedRequests: BlockedRequest[] = [];

/** Block every http(s)/ws(s) request from the workbench session except the Vite dev server in development. */
export function installNetworkGuard(session: Session, allowedDevOrigin?: string): void {
  session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, cb) => {
      const origin = safeOrigin(details.url);
      const allowed =
        allowedDevOrigin !== undefined &&
        (origin === allowedDevOrigin || origin === allowedDevOrigin.replace(/^http/, 'ws'));
      if (!allowed) {
        if (blockedRequests.length < 200) blockedRequests.push({ origin, resourceType: details.resourceType });
        cb({ cancel: true });
        return;
      }
      cb({});
    },
  );
}

/** In development the dev server sends no CSP; add the development policy to its responses. */
export function installDevCsp(session: Session, devOrigin: string, csp: string): void {
  session.webRequest.onHeadersReceived({ urls: [`${devOrigin}/*`] }, (details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
}

export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

export function hardenWorkbenchContents(contents: WebContents, allowedOrigin: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (safeOrigin(url) !== allowedOrigin) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (safeOrigin(url) !== allowedOrigin) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

export function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    // Custom standard schemes report origin "null" in Node's URL; build it from protocol + host instead.
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'invalid';
  }
}
