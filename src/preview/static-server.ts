import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mimeTypeFor } from './mime';
import { parseRequestTarget, resolveInRoot } from './request-path';

/**
 * Loopback static server for one project's preview (S04.1, PLAN §8, AGENTS.md "Static server").
 *
 * - Listens on 127.0.0.1 only, on a random port. The port is not access control; these checks are:
 * - Host header must be exactly `127.0.0.1:<port>` (defeats DNS rebinding: a page on evil.example resolved to
 *   127.0.0.1 sends `Host: evil.example`).
 * - Ownership: every request must carry the per-server secret in `X-NoobIDE-Preview`. Only the preview's own
 *   Electron session adds it (webRequest, see preview-session.ts); other local programs and browsers do not have it.
 * - Requests a browser marks as cross-site or same-site (another loopback port) are refused (`Sec-Fetch-Site`).
 * - GET and HEAD only; paths are confined to the real project root and dotfiles are denied (request-path.ts).
 * - S15.4 "Open in external browser": the browser cannot add the header, so main hands it a one-time grant URL
 *   (`/.noobide-grant/<token>`, 256-bit, single use, valid GRANT_TTL_MS). Visiting it sets an HttpOnly,
 *   SameSite=Strict cookie holding a second per-server secret, which then stands in for the header. Only a
 *   top-level visit the user started can redeem a grant (`Sec-Fetch-Site` none or absent); the cookie is never sent
 *   on cross-site requests, and Host and `Sec-Fetch-Site` are still checked on every request. A new server (Stop,
 *   project switch) has new secrets, so an old cookie or link is worthless. See docs/decisions/0018.
 *
 * Never logs: the server has no logging at all, so neither paths nor contents can leak into logs.
 */

export const TOKEN_HEADER = 'x-noobide-preview';
export const LOOPBACK_HOST = '127.0.0.1';
/** S15.4: path prefix of one-time external-browser grants. A dot segment: no project file can ever be shadowed. */
export const GRANT_PREFIX = '/.noobide-grant/';
export const GRANT_TTL_MS = 60_000;
/** The external-browser cookie expires after this long even if the server keeps running (it is port-agnostic). */
export const GRANT_COOKIE_MAX_AGE_S = 8 * 60 * 60;
const GRANT_PATTERN = /^\/\.noobide-grant\/([0-9a-f]{64})$/;

export interface PreviewServerOptions {
  /** Test-only: start without the ownership header check. Production always requires it. */
  readonly requireToken?: boolean;
  /** Port to try first (the project's previous one); falls back to a random free port. */
  readonly preferredPort?: number | undefined;
}

export class PreviewServer {
  private constructor(
    private readonly server: Server,
    /** Real path of the project root. */
    readonly root: string,
    readonly port: number,
    readonly token: string,
    private readonly grants: GrantStore,
  ) {}

  /**
   * S15.4: a one-time URL that lets the user's default browser open `targetPath` (an absolute URL path on this
   * server, e.g. `/` or `/pages/a.html?x=1`). Redeeming it sets the external-browser cookie and redirects there.
   */
  grantExternal(targetPath: string, now: number = Date.now()): string {
    const target = targetPath.startsWith('/') && !targetPath.startsWith('//') ? targetPath : '/';
    return `${this.origin}${GRANT_PREFIX}${this.grants.issue(target, now)}`;
  }

  get origin(): string {
    return `http://${LOOPBACK_HOST}:${this.port}`;
  }

  static async start(rootPath: string, options: PreviewServerOptions = {}): Promise<PreviewServer> {
    const root = await realpath(rootPath);
    if (!(await stat(root)).isDirectory()) throw new Error('preview root is not a directory');
    const token = randomBytes(32).toString('hex');
    const grants = new GrantStore();
    const requireToken = options.requireToken ?? true;
    let port = 0;
    const server = createServer((req, res) => {
      void handle(req, res, { root, token, grants, requireToken, port }).catch(() => {
        if (!res.headersSent) send(res, 500);
        else res.destroy();
      });
    });
    // No keep-alive surprises after close(): idle sockets are closed with the server.
    server.keepAliveTimeout = 2_000;
    const listen = (wanted: number) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: LOOPBACK_HOST, port: wanted, exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    const preferred = options.preferredPort;
    if (preferred !== undefined && Number.isInteger(preferred) && preferred > 1024 && preferred < 65536) {
      await listen(preferred).catch(() => listen(0));
    } else {
      await listen(0);
    }
    port = (server.address() as AddressInfo).port;
    return new PreviewServer(server, root, port, token, grants);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

interface HandleContext {
  readonly root: string;
  readonly token: string;
  readonly grants: GrantStore;
  readonly requireToken: boolean;
  readonly port: number;
}

/**
 * S15.4 external-browser grants of one server: one-time tokens (stored as SHA-256 hashes, so a lookup by attacker
 * input never compares secrets directly) and the cookie secret they unlock.
 */
class GrantStore {
  /** Value of the external-browser cookie. */
  readonly cookieSecret = randomBytes(32).toString('hex');
  private readonly pending = new Map<string, { readonly target: string; readonly expires: number }>();

  issue(target: string, now: number): string {
    for (const [key, grant] of this.pending) if (grant.expires <= now) this.pending.delete(key);
    if (this.pending.size >= 16) this.pending.delete(this.pending.keys().next().value as string);
    const token = randomBytes(32).toString('hex');
    this.pending.set(hashToken(token), { target, expires: now + GRANT_TTL_MS });
    return token;
  }

  /** The target path of a valid, unexpired grant; the grant is used up either way. */
  redeem(token: string, now: number = Date.now()): string | null {
    const key = hashToken(token);
    const grant = this.pending.get(key);
    if (!grant) return null;
    this.pending.delete(key);
    return grant.expires > now ? grant.target : null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cookie name per port: browsers share cookies across the ports of 127.0.0.1. */
export function grantCookieName(port: number): string {
  return `noobide-preview-${port}`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { Allow: 'GET, HEAD' });
    return;
  }
  if (req.headers.host !== `${LOOPBACK_HOST}:${ctx.port}`) {
    send(res, 421);
    return;
  }
  const site = req.headers['sec-fetch-site'];
  // S15.4: redeem a one-time external-browser grant. Only a visit the user started (typed, or opened by the OS).
  const grant = GRANT_PATTERN.exec(req.url ?? '');
  if (grant) {
    const target = site === undefined || site === 'none' ? ctx.grants.redeem(grant[1] ?? '') : null;
    if (target === null) {
      send(res, 403);
      return;
    }
    send(res, 302, {
      Location: target,
      'Set-Cookie': `${grantCookieName(ctx.port)}=${ctx.grants.cookieSecret}; Path=/; Max-Age=${GRANT_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict`,
    });
    return;
  }
  if (
    ctx.requireToken &&
    !tokenMatches(req.headers[TOKEN_HEADER], ctx.token) &&
    !tokenMatches(cookieValue(req.headers.cookie, grantCookieName(ctx.port)), ctx.grants.cookieSecret)
  ) {
    send(res, 403);
    return;
  }
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    send(res, 403);
    return;
  }
  const target = parseRequestTarget(req.url ?? '');
  if (!target.ok) {
    send(res, target.code === 'forbidden' ? 403 : 400);
    return;
  }
  const resolved = await resolveInRoot(ctx.root, target.value);
  if (!resolved.ok) {
    if (resolved.code === 'redirect-to-directory') {
      const [pathPart = '', ...rest] = (req.url ?? '').split('?');
      send(res, 301, { Location: `${pathPart}/${rest.length > 0 ? `?${rest.join('?')}` : ''}` });
    } else send(res, resolved.code === 'forbidden' ? 403 : 404);
    return;
  }
  const file = resolved.value;
  // Open once and serve from the handle: the length matches the bytes sent even if an atomic save replaces the
  // file meanwhile, and the checked real path cannot be swapped for a link between check and read.
  // Windows refuses to rename over a file that is open, so the IDE's own atomic save could fail while we read:
  // ordinary files are read whole and closed at once (milliseconds); only large media files are streamed.
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    send(res, 404);
    return;
  }
  let streaming = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      send(res, 404);
      return;
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': mimeTypeFor(file),
      'Content-Length': String(info.size),
    });
    if (req.method === 'HEAD' || info.size === 0) {
      res.end();
      return;
    }
    if (info.size <= MAX_BUFFERED_BYTES) {
      const body = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(body, 0, info.size, 0);
      await handle.close();
      streaming = true; // closed already
      // A file that shrank between fstat and read is padded rather than sending fewer bytes than announced.
      res.end(
        bytesRead === info.size
          ? body
          : Buffer.concat([body.subarray(0, bytesRead), Buffer.alloc(info.size - bytesRead)]),
      );
      return;
    }
    const stream = handle.createReadStream({ start: 0, end: info.size - 1, autoClose: true });
    streaming = true;
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } finally {
    if (!streaming) await handle.close().catch(() => undefined);
  }
}

/** Files up to this size are read into memory and closed before sending (see handle()). */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

const STATUS_TEXT: Record<number, string> = {
  301: 'Moved Permanently',
  302: 'Found',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  421: 'Misdirected Request',
  500: 'Internal Server Error',
};

function send(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  const body = `${status} ${STATUS_TEXT[status] ?? ''}\n`;
  res.writeHead(status, {
    ...BASE_HEADERS,
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string' || header.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(token));
}
