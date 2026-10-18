import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { IMAGE_RESPONSE_CSP, projectImageInfo, serveProjectImage } from '../../src/main/project-images';
import { parseImageInfoRequest } from '../../src/shared/ipc/file-ops-contract';
import { projectImageUrl } from '../../src/shared/image-files';

/**
 * S52.6: the app protocol's `project` host serves images of the open project only, realpath-checked inside its
 * root, with a CSP that keeps an SVG from running scripts. Real files under a path with Chinese characters and spaces.
 */
const ID = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><script>alert(1)</script></svg>';
let tmp: string;
let root: string;
const deps = () => ({ scheme: 'noobide', rootOf: (id: string) => (id === ID ? root : undefined) });
const get = (relPath: string, method = 'GET') =>
  serveProjectImage(new Request(projectImageUrl('noobide', ID, relPath), { method }), deps());

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-img-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(path.join(root, '图片 素材'), { recursive: true });
  await writeFile(path.join(root, '图片 素材', '标志 图.png'), PNG);
  await writeFile(path.join(root, '图标.svg'), SVG);
  await writeFile(path.join(root, 'font.woff2'), 'x');
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

describe('project images on the app protocol (S52.6)', REAL_IO, () => {
  it('serves an image of the open project with its type, size and a no-script CSP', async () => {
    const response = await get('图片 素材/标志 图.png');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe(String(PNG.length));
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
  });

  it('an SVG is served as an image with scripts disabled by its CSP (sandbox, no script-src)', async () => {
    const response = await get('图标.svg');
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('Content-Security-Policy')).toBe(IMAGE_RESPONSE_CSP);
    expect(IMAGE_RESPONSE_CSP).toContain('sandbox');
    expect(IMAGE_RESPONSE_CSP).not.toContain('script-src');
    expect(IMAGE_RESPONSE_CSP).toContain("default-src 'none'");
  });

  it('HEAD gives the size without the bytes', async () => {
    const response = await get('图片 素材/标志 图.png', 'HEAD');
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('refuses anything that is not a viewer image, other methods, unknown projects and missing files', async () => {
    expect((await get('font.woff2')).status).toBe(415);
    expect((await get('图标.svg', 'POST')).status).toBe(405);
    expect((await get('missing.png')).status).toBe(404);
    const other = '00000000-0000-4000-8000-000000000000';
    expect((await serveProjectImage(new Request(projectImageUrl('noobide', other, '图标.svg')), deps())).status).toBe(
      404,
    );
  });

  it('a link or junction leading out of the project is refused (realpath check)', async () => {
    const outside = path.join(tmp, '外面');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.png'), PNG);
    await symlink(outside, path.join(root, '外链'), 'junction');
    expect((await get('外链/secret.png')).status).toBe(403);
  });

  it('paths the IPC contract refuses never reach the disk (`..`, NTFS streams, device names)', async () => {
    const raw = (p: string) => serveProjectImage(new Request(`noobide://project/${ID}/${p}`), deps());
    expect((await raw('图标.svg:stream.png')).status).toBe(400);
    expect((await raw('CON.png')).status).toBe(400);
    expect((await raw('%2E%2E/%2E%2E/x.png')).status).toBe(400);
    expect((await raw('a%5Cb.png')).status).toBe(400);
    expect((await serveProjectImage(new Request(`noobide://project/not-an-id/a.png`), deps())).status).toBe(400);
  });
});

describe('image size for the viewer tab (S52.6)', REAL_IO, () => {
  it('reports the byte size of a project image', async () => {
    expect(await projectImageInfo(root, '图片 素材/标志 图.png')).toMatchObject({
      ok: true,
      value: { bytes: PNG.length },
    });
  });

  it('refuses non-images, missing files and links out of the project', async () => {
    expect(await projectImageInfo(root, 'font.woff2')).toMatchObject({ ok: false });
    expect(await projectImageInfo(root, 'missing.png')).toMatchObject({ ok: false, code: 'not-found' });
    const outside = path.join(tmp, '外面');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.png'), PNG);
    await symlink(outside, path.join(root, '外链'), 'junction');
    expect(await projectImageInfo(root, '外链/secret.png')).toMatchObject({ ok: false, code: 'outside-project' });
  });

  it('the IPC request names a portable image path only', () => {
    expect(parseImageInfoRequest({ projectId: ID, relPath: '图片 素材/标志 图.png' })).not.toBeNull();
    expect(parseImageInfoRequest({ projectId: ID, relPath: 'index.html' })).toBeNull();
    expect(parseImageInfoRequest({ projectId: ID, relPath: '../a.png' })).toBeNull();
    expect(parseImageInfoRequest({ projectId: ID, relPath: 'a.png', x: 1 })).toBeNull();
  });
});
