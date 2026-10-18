import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { NotOwnerError, ServerRegistry } from '../../src/preview/server-registry';
import { PreviewServer, TOKEN_HEADER } from '../../src/preview/static-server';

/**
 * S14.6 integration: the server registry with real loopback servers on project paths with Chinese characters and
 * spaces. One server per open project, shut down on switch and close (the port stops answering), and an ownership
 * check: another window can neither take over nor shut down a project's server, and each server only serves its
 * own project root to its own token.
 */
const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', '中文 路径 项目');

let tmp: string;
let rootA: string;
let rootB: string;
let registry: ServerRegistry<PreviewServer>;

function get(server: PreviewServer, target: string, token: string | null = server.token): Promise<number> {
  const headers: Record<string, string> = { Host: `127.0.0.1:${server.port}` };
  if (token !== null) headers[TOKEN_HEADER] = token;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path: target, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const reachable = (server: PreviewServer) =>
  get(server, '/').then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-life-'));
  rootA = path.join(tmp, '网页 练习', '项目 A');
  rootB = path.join(tmp, '网页 练习', '项目 B');
  await mkdir(path.dirname(rootA), { recursive: true });
  await cp(FIXTURE, rootA, { recursive: true });
  await mkdir(rootB);
  await writeFile(path.join(rootB, 'only-in-b.html'), '<p>B</p>');
  registry = new ServerRegistry((root, options) => PreviewServer.start(root, options));
}, REAL_IO.timeout);

afterEach(async () => {
  await registry.releaseAllExcept(null);
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const A = { projectId: 'a', windowId: 1 };
const B = { projectId: 'b', windowId: 1 };

describe('server lifecycle per project (S14.6)', REAL_IO, () => {
  it('one server per project: repeated starts get the same listening server', async () => {
    const first = await registry.acquire(A, rootA);
    const again = await registry.acquire(A, rootA);
    expect(again).toBe(first);
    expect(first.root).toBe(await realpath(rootA));
    expect(await get(first, '/index.html')).toBe(200);
    expect(registry.projects).toEqual(['a']);
  });

  it('a switch shuts the other project’s server down: its port stops answering', async () => {
    const a = await registry.acquire(A, rootA);
    const b = await registry.acquire(B, rootB);
    // Each server is confined to its own project and its own token.
    expect(await get(b, '/only-in-b.html')).toBe(200);
    expect(await get(a, '/only-in-b.html')).toBe(404);
    expect(await get(a, '/index.html', b.token)).toBe(403);
    await registry.releaseAllExcept('b');
    expect(await reachable(a)).toBe(false);
    expect(await reachable(b)).toBe(true);
  });

  it('closing a project shuts its server down', async () => {
    const a = await registry.acquire(A, rootA);
    expect(await registry.release('a')).toBe(true);
    expect(await reachable(a)).toBe(false);
    expect(registry.projects).toEqual([]);
  });

  it('ownership: another window can neither take over nor shut down the server', async () => {
    const a = await registry.acquire(A, rootA);
    const intruder = { projectId: 'a', windowId: 2 };
    await expect(registry.acquire(intruder, rootA)).rejects.toBeInstanceOf(NotOwnerError);
    expect(await registry.release('a', intruder)).toBe(false);
    expect(await reachable(a)).toBe(true);
    expect(await get(a, '/index.html')).toBe(200);
  });

  it('a restart after release reuses the port, so the page keeps its origin', async () => {
    const a = await registry.acquire(A, rootA);
    const port = a.port;
    await registry.release('a', A);
    const again = await registry.acquire(A, rootA);
    expect(again).not.toBe(a);
    expect(again.port).toBe(port);
    expect(again.token).not.toBe(a.token);
  });
});
