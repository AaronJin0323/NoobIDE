import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewServer, TOKEN_HEADER } from '../../src/preview/static-server';

/**
 * S04.1 integration: the real loopback server on a project path with Chinese characters and spaces, probed with raw
 * HTTP requests (Node sends the request target exactly as given, so traversal attempts reach the server unaltered).
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');

let tmp: string;
let root: string;
let server: PreviewServer;

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  target: string,
  options: { method?: string; host?: string; token?: string | null; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = {
    Host: options.host ?? `127.0.0.1:${server.port}`,
    ...options.headers,
  };
  const token = options.token === undefined ? server.token : options.token;
  if (token !== null) headers[TOKEN_HEADER] = token;
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, path: target, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-srv-'));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.dirname(root), { recursive: true });
  await cp(FIXTURE, root, { recursive: true });
  await writeFile(path.join(tmp, 'secret.txt'), 'TOP SECRET');
  await writeFile(path.join(root, '.env'), 'API_KEY=1');
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), '[core]');
  await mkdir(path.join(root, '.noobide'));
  await writeFile(path.join(root, '.noobide', 'project.json'), '{}');
  server = await PreviewServer.start(root);
});

afterEach(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('binding and ownership (S04.1)', () => {
  it('listens on 127.0.0.1 only', () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
  });

  it('reuses a preferred port when it is free and falls back to a random one when it is taken', async () => {
    const port = server.port;
    await server.close();
    server = await PreviewServer.start(root, { preferredPort: port });
    expect(server.port).toBe(port);
    const second = await PreviewServer.start(root, { preferredPort: port });
    try {
      expect(second.port).not.toBe(port);
      expect(second.port).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });

  it('serves the bytes it announced while the file is replaced by atomic saves', async () => {
    const file = path.join(root, 'big.txt');
    await writeFile(file, 'a'.repeat(200_000));
    const replacing = (async () => {
      for (let i = 0; i < 20; i += 1) {
        const tmpFile = path.join(root, `big.tmp${i}`);
        await writeFile(tmpFile, 'b'.repeat(100_000 + i));
        // Windows refuses to rename over a file another handle has open; the server keeps that window tiny.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await rename(tmpFile, file);
            break;
          } catch (e) {
            if (attempt > 50) throw e;
            await new Promise((r) => setTimeout(r, 2));
          }
        }
      }
    })();
    for (let i = 0; i < 20; i += 1) {
      const res = await raw('/big.txt');
      expect(res.status).toBe(200);
      expect(Buffer.byteLength(res.body)).toBe(Number(res.headers['content-length']));
    }
    await replacing;
  });

  it('is not reachable on another local interface address', async () => {
    const other = Object.values(os.networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    const targets = ['::1', ...(other ? [other] : [])];
    for (const host of targets) {
      const result = await new Promise<string>((resolve) => {
        const req = request({ host, port: server.port, path: '/', timeout: 2000 }, () => resolve('connected'));
        req.on('error', () => resolve('refused'));
        req.on('timeout', () => {
          req.destroy();
          resolve('refused');
        });
        req.end();
      });
      expect(result, host).toBe('refused');
    }
  });

  it('serves the project to a request that carries the session token', async () => {
    const res = await raw('/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('你好，我是林小雨');
  });

  it('refuses requests without the token or with a wrong one', async () => {
    expect((await raw('/index.html', { token: null })).status).toBe(403);
    expect((await raw('/index.html', { token: 'x'.repeat(64) })).status).toBe(403);
    expect((await raw('/index.html', { token: 'short' })).status).toBe(403);
    // Same length in characters but not in bytes (header values are latin1): still a plain refusal, not a 500.
    expect((await raw('/index.html', { token: '\u00e9'.repeat(64) })).status).toBe(403);
    const cookie = { Cookie: `noobide-preview-${server.port}=${'\u00e9'.repeat(64)}` };
    expect((await raw('/index.html', { token: null, headers: cookie })).status).toBe(403);
  });

  it.each(['localhost', `localhost:0`, 'evil.example', '127.0.0.1', '127.0.0.1:1', '[::1]'])(
    'refuses Host header %s (DNS rebinding)',
    async (host) => {
      const res = await raw('/index.html', { host: host === 'localhost:0' ? `localhost:${server.port}` : host });
      expect(res.status).toBe(421);
    },
  );

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('refuses %s', async (method) => {
    const res = await raw('/index.html', { method });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  it('answers HEAD without a body', async () => {
    const res = await raw('/index.html', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
  });

  it('refuses cross-site and same-site (other loopback port) browser requests', async () => {
    for (const site of ['cross-site', 'same-site']) {
      expect((await raw('/index.html', { headers: { 'Sec-Fetch-Site': site } })).status).toBe(403);
    }
    for (const site of ['same-origin', 'none']) {
      expect((await raw('/index.html', { headers: { 'Sec-Fetch-Site': site } })).status).toBe(200);
    }
  });

  it('stops serving after close', async () => {
    const port = server.port;
    await server.close();
    const result = await new Promise<string>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, () => resolve('connected'));
      req.on('error', () => resolve('refused'));
      req.end();
    });
    expect(result).toBe('refused');
    server = await PreviewServer.start(root); // for afterEach
  });
});

describe('path guard (S04.1)', () => {
  it.each([
    '/../secret.txt',
    '/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e/%2e%2e/secret.txt',
    '/%2E%2E%2Fsecret.txt',
    '/..%2fsecret.txt',
    '/..\\secret.txt',
    '/..%5csecret.txt',
    '/%5c..%5csecret.txt',
    '/%E5%AD%90%20%E6%96%87%E4%BB%B6%E5%A4%B9/../../secret.txt',
  ])('blocks traversal %s', async (target) => {
    const res = await raw(target);
    expect([400, 403]).toContain(res.status);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('blocks absolute paths and drive letters', async () => {
    const absolute = path.join(tmp, 'secret.txt');
    for (const target of [
      `/${encodeURIComponent(absolute)}`,
      `/${absolute.split(path.sep).map(encodeURIComponent).join('/')}`,
      '/C:/Windows/win.ini',
      '/C%3A%5CWindows%5Cwin.ini',
      '//etc/passwd',
      `http://127.0.0.1:${server.port}/../secret.txt`,
    ]) {
      const res = await raw(target);
      expect(res.status, target).not.toBe(200);
      expect(res.body).not.toContain('TOP SECRET');
    }
  });

  it.each(['/.env', '/.git/config', '/.git/', '/.noobide/project.json', '/%2eenv', '/%2Egit/config'])(
    'denies the dotfile %s',
    async (target) => {
      expect((await raw(target)).status).toBe(403);
    },
  );

  it('denies a dotfolder through its Windows 8.3 short name or any other alias', async () => {
    // GIT~1 is the usual short name of .git on NTFS volumes with 8.3 names enabled; elsewhere it simply 404s.
    const shortNamesExist = await realpath(path.join(root, 'GIT~1')).then(
      () => true,
      () => false,
    );
    for (const target of ['/GIT~1/config', '/NOOBID~1/project.json', '/ENV~1']) {
      const res = await raw(target);
      expect(res.status, target).toBe(shortNamesExist ? 403 : 404);
      expect(res.body).not.toContain('[core]');
    }
  });

  it('blocks a directory junction / symlink that leads outside the project', async (ctx) => {
    const outsideDir = path.join(tmp, 'outside');
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, 'a.txt'), 'TOP SECRET');
    try {
      await symlink(outsideDir, path.join(root, 'jump'), 'junction');
    } catch {
      ctx.skip();
    }
    const res = await raw('/jump/a.txt');
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('blocks a file symlink that leads outside the project', async (ctx) => {
    try {
      await symlink(path.join(tmp, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    } catch {
      ctx.skip(); // Creating file symlinks on Windows needs Developer Mode or admin rights.
    }
    const res = await raw('/link.txt');
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('blocks a link inside the project that points at a dotfile', async (ctx) => {
    try {
      await symlink(path.join(root, '.git'), path.join(root, 'notgit'), 'junction');
    } catch {
      ctx.skip();
    }
    expect((await raw('/notgit/config')).status).toBe(403);
  });

  it('serves nested files with Chinese names and spaces', async () => {
    const res = await raw(`/${encodeURIComponent('子 文件夹')}/${encodeURIComponent('页面 二.html')}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('第二页');
  });

  it('redirects a directory without a trailing slash and serves its index.html', async () => {
    await writeFile(path.join(root, '子 文件夹', 'index.html'), '<h1>sub index</h1>');
    const dir = `/${encodeURIComponent('子 文件夹')}`;
    const redirect = await raw(`${dir}?a=1`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe(`${dir}/?a=1`);
    const res = await raw(`${dir}/`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('sub index');
  });

  it('answers 404 for missing files and directories without index.html', async () => {
    expect((await raw('/missing.html')).status).toBe(404);
    await mkdir(path.join(root, 'empty'));
    expect((await raw('/empty/')).status).toBe(404);
    expect((await raw('/index.html/')).status).toBe(404);
  });

  it('explains a missing page to a document load, escaped and script-free; other requests keep the plain 404', async () => {
    const doc = { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin' };
    const page = await raw('/%E5%85%B3%E4%BA%8E%20%E6%88%91.html?x=1', { headers: doc });
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.body).toContain('<html lang="zh-CN">');
    expect(page.body).toContain('找不到这个页面');
    expect(page.body).toContain('<code>关于 我.html</code>');
    expect(page.body).not.toContain('<script');
    // Names with < > " are refused before (400); the characters that do pass are escaped.
    expect((await raw(`/${encodeURIComponent('<img src=x>.html')}`, { headers: doc })).status).toBe(400);
    const hostile = await raw(`/${encodeURIComponent("Tom & Jerry's $&.html")}`, { headers: doc });
    expect(hostile.status).toBe(404);
    expect(hostile.body).toContain('<code>Tom &amp; Jerry&#39;s $&amp;.html</code>');
    // Images, scripts, fetches: the plain text answer.
    const image = await raw('/missing.png', { headers: { 'Sec-Fetch-Dest': 'image' } });
    expect(image).toMatchObject({ status: 404, body: '404 Not Found\n' });
    expect((await raw('/missing.html')).body).toBe('404 Not Found\n');
    // The checks before it still apply: no token, no page.
    expect((await raw('/missing.html', { token: null, headers: doc })).status).toBe(403);
    // HEAD: the status and headers only.
    const head = await raw('/missing.html', { method: 'HEAD', headers: doc });
    expect(head).toMatchObject({ status: 404, body: '' });
  });

  it('the missing-page explanation follows the interface language', async () => {
    let locale: 'zh-CN' | 'en' = 'en';
    const english = await PreviewServer.start(root, { locale: () => locale });
    const previous = server;
    server = english;
    try {
      const doc = { 'Sec-Fetch-Dest': 'document' };
      const page = await raw('/about.html', { headers: doc });
      expect(page.body).toContain('<html lang="en">');
      expect(page.body).toContain('Page not found');
      expect(page.body).toContain('<code>about.html</code>');
      locale = 'zh-CN';
      expect((await raw('/about.html', { headers: doc })).body).toContain('找不到这个页面');
    } finally {
      server = previous;
      await english.close();
    }
  });

  it('never caches, never sniffs', async () => {
    const res = await raw('/index.html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('content types of the multi-file fixture (S04.2)', () => {
  const MULTI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '预览 多文件');
  let multi: PreviewServer;

  const get = (target: string) => {
    const previous = server;
    server = multi;
    return raw(target).finally(() => {
      server = previous;
    });
  };

  beforeEach(async () => {
    const copy = path.join(tmp, '预览 多文件');
    await cp(MULTI, copy, { recursive: true });
    await writeFile(path.join(copy, 'font.woff2'), Buffer.from('wOF2'));
    multi = await PreviewServer.start(copy);
  });

  afterEach(async () => {
    await multi.close();
  });

  it.each([
    ['/', 'text/html; charset=utf-8'],
    ['/index.html', 'text/html; charset=utf-8'],
    ['/css/style.css', 'text/css; charset=utf-8'],
    ['/js/main.js', 'text/javascript; charset=utf-8'],
    ['/js/classic.js', 'text/javascript; charset=utf-8'],
    ['/js/util.mjs', 'text/javascript; charset=utf-8'],
    ['/data/data.json', 'application/json; charset=utf-8'],
    [`/${encodeURIComponent('图片')}/${encodeURIComponent('标志.svg')}`, 'image/svg+xml'],
    [`/${encodeURIComponent('图片')}/photo.png`, 'image/png'],
    ['/font.woff2', 'font/woff2'],
  ])('%s is served as %s', async (target, type) => {
    const res = await get(target);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(type);
  });

  it('every resource the fixture page references exists and is served', async () => {
    const html = (await get('/index.html')).body;
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    const main = (await get('/js/main.js')).body;
    const imports = [...main.matchAll(/from '\.\/([^']+)'|fetch\('([^']+)'\)/g)].map((m) =>
      m[1] ? `js/${m[1]}` : (m[2] ?? ''),
    );
    expect(refs.length).toBe(5);
    expect(imports).toEqual(['js/util.mjs', 'data/data.json']);
    for (const ref of [...refs, ...imports]) {
      const target = `/${ref.split('/').map(encodeURIComponent).join('/')}`;
      expect((await get(target)).status, ref).toBe(200);
    }
  });
});
