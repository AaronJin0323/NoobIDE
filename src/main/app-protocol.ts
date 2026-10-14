import { readFile } from 'node:fs/promises';
import type { Protocol } from 'electron';
import { APP_SCHEME, contentTypeFor, resolveAppAsset } from './app-asset';
import { buildCsp } from './csp';

/** Must run before `app.ready`. Makes noobide:// a standard, secure origin so 'self', workers and fetch work. */
export function registerAppSchemePrivileges(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

/** Serves the renderer build (read-only, GET/HEAD only) with the production CSP on every response. */
export function handleAppProtocol(protocol: Protocol, rendererDir: string): void {
  const csp = buildCsp('production');
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    const resolved = resolveAppAsset(rendererDir, request.url);
    if (!resolved.ok) return new Response(null, { status: resolved.code === 'outside-root' ? 403 : 400 });
    try {
      const body = await readFile(resolved.value);
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'Content-Type': contentTypeFor(resolved.value),
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
