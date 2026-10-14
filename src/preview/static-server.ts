import { randomBytes, timingSafeEqual } from 'node:crypto';
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
 *
 * Never logs: the server has no logging at all, so neither paths nor contents can leak into logs.
 */

export const TOKEN_HEADER = 'x-noobide-preview';
export const LOOPBACK_HOST = '127.0.0.1';

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
  ) {}

  get origin(): string {
    return `http://${LOOPBACK_HOST}:${this.port}`;
  }

  static async start(rootPath: string, options: PreviewServerOptions = {}): Promise<PreviewServer> {
    const root = await realpath(rootPath);
    if (!(await stat(root)).isDirectory()) throw new Error('preview root is not a directory');
    const token = randomBytes(32).toString('hex');
    const requireToken = options.requireToken ?? true;
    let port = 0;
    const server = createServer((req, res) => {
      void handle(req, res, { root, token, requireToken, host: `${LOOPBACK_HOST}:${port}` }).catch(() => {
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
    return new PreviewServer(server, root, port, token);
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
  readonly requireToken: boolean;
  readonly host: string;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleContext): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { Allow: 'GET, HEAD' });
    return;
  }
  if (req.headers.host !== ctx.host) {
    send(res, 421);
    return;
  }
  if (ctx.requireToken && !tokenMatches(req.headers[TOKEN_HEADER], ctx.token)) {
    send(res, 403);
    return;
  }
  const site = req.headers['sec-fetch-site'];
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
