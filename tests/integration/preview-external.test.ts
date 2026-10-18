import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { GRANT_TTL_MS, PreviewServer, grantCookieName } from '../../src/preview/static-server';

/**
 * S15.4 "Open in external browser": the browser has no ownership header, so it gets a one-time grant that sets an
 * HttpOnly SameSite=Strict cookie. Probed with raw HTTP like a browser would send it (no header).
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');

let tmp: string;
let server: PreviewServer;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

function browserGet(target: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: target,
        headers: { Host: `127.0.0.1:${server.port}`, 'Sec-Fetch-Site': 'none', ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const pathOf = (url: string) => new URL(url).pathname;

function cookieFrom(res: Res): string {
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  if (!first) throw new Error('no cookie');
  return first.split(';')[0] ?? '';
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-ext-'));
  const root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(FIXTURE, root, { recursive: true });
  server = await PreviewServer.start(root);
}, REAL_IO.timeout);

afterEach(async () => {
  await server.close();
  await removeTempDir(tmp);
}, REAL_IO.timeout);

describe('external-browser grant (S15.4)', REAL_IO, () => {
  it('without a grant the browser gets 403 (the port alone is not access)', async () => {
    expect((await browserGet('/index.html')).status).toBe(403);
  });

  it('a grant sets an HttpOnly SameSite=Strict cookie and redirects to the page; the cookie then works', async () => {
    const url = server.grantExternal('/index.html?from=ide');
    expect(url.startsWith(`${server.origin}/.noobide-grant/`)).toBe(true);
    const redeemed = await browserGet(pathOf(url));
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.location).toBe('/index.html?from=ide');
    const set = String(redeemed.headers['set-cookie']);
    expect(set).toContain(`${grantCookieName(server.port)}=`);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Max-Age=28800/);
    const cookie = cookieFrom(redeemed);
    expect((await browserGet('/index.html', { Cookie: cookie })).status).toBe(200);
    expect((await browserGet('/index.html', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });

  it('a grant works once', async () => {
    const target = pathOf(server.grantExternal('/'));
    expect((await browserGet(target)).status).toBe(302);
    expect((await browserGet(target)).status).toBe(403);
  });

  it('an expired grant or a made-up one is refused', async () => {
    const old = pathOf(server.grantExternal('/', Date.now() - GRANT_TTL_MS - 1));
    expect((await browserGet(old)).status).toBe(403);
    expect((await browserGet(`/.noobide-grant/${'0'.repeat(64)}`)).status).toBe(403);
    expect((await browserGet('/.noobide-grant/short')).status).toBe(403); // a dot path: never a project file
  });

  it('a grant cannot be redeemed by another site (cross-site / same-site requests)', async () => {
    for (const site of ['cross-site', 'same-site', 'same-origin']) {
      const target = pathOf(server.grantExternal('/'));
      expect((await browserGet(target, { 'Sec-Fetch-Site': site })).status).toBe(403);
    }
  });

  it('the cookie is useless cross-site, with a wrong Host, for dotfiles and outside the project', async () => {
    const cookie = cookieFrom(await browserGet(pathOf(server.grantExternal('/'))));
    expect((await browserGet('/index.html', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await browserGet('/index.html', { Cookie: cookie, Host: 'evil.example' })).status).toBe(421);
    expect((await browserGet('/.env', { Cookie: cookie })).status).toBe(403);
    expect([400, 403]).toContain((await browserGet('/../secret.txt', { Cookie: cookie })).status);
    expect((await browserGet('/index.html', { Cookie: `${grantCookieName(server.port)}=wrong` })).status).toBe(403);
  });

  it('a restarted server (same port) does not accept the old cookie', async () => {
    const cookie = cookieFrom(await browserGet(pathOf(server.grantExternal('/'))));
    const port = server.port;
    const root = server.root;
    await server.close();
    server = await PreviewServer.start(root, { preferredPort: port });
    expect(server.port).toBe(port);
    expect((await browserGet('/index.html', { Cookie: cookie })).status).toBe(403);
  });

  it('only same-server paths can be targets', () => {
    expect(server.grantExternal('//evil.example/')).toMatch(/\/\.noobide-grant\//);
  });
});
