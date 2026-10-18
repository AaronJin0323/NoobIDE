import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { CHANNELS } from '../../src/shared/ipc/contract';
import { ok } from '../../src/shared/result';
import { registerCreateProjectHandlers, DEFAULT_LOCATION_NAMES } from '../../src/main/create-project-ipc';
import type { HandleFn } from '../../src/main/ipc';
import {
  checkNewProject,
  createProjectFromTemplate,
  projectFolderPath,
  type CreateFs,
} from '../../src/workspace/create-project';
import { listTemplates, type TemplateInfo } from '../../src/workspace/templates';
import { mkdir as fsMkdir, copyFile, readdir as fsReaddir, rmdir, unlink } from 'node:fs/promises';

/**
 * S20.2: creating a project from a built-in template. Real file system in a temp folder whose path has Chinese
 * characters and spaces. Existing folders and files are never reused or overwritten; failures half-way remove only
 * what the call created.
 */
const TEMPLATES_DIR = path.resolve(import.meta.dirname, '..', '..', 'resources', 'templates');
const listing = await listTemplates(TEMPLATES_DIR);
if (!listing.ok) throw new Error(listing.message);
const templates = listing.value.templates;
const intro = templates.find((t) => t.id === 'personal-intro') as TemplateInfo;

let tmp: string;
let parentDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-create-'));
  parentDir = path.join(tmp, '网页 练习');
  await mkdir(parentDir);
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await tree(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe('createProjectFromTemplate (S20.2)', REAL_IO, () => {
  it.each(templates.map((t) => [t.id, t] as const))(
    '%s: creates "<location>/<name>" with exactly the manifest files, byte for byte',
    async (_id, template) => {
      const result = await createProjectFromTemplate(template, { parentDir, name: '我的 主页' });
      expect(result.ok).toBe(true);
      const root = path.join(parentDir, '我的 主页');
      expect(await tree(root)).toEqual([...template.files].sort());
      for (const rel of template.files) {
        const copied = await readFile(path.join(root, ...rel.split('/')));
        expect(copied.equals(await readFile(path.join(template.dir, ...rel.split('/')))), rel).toBe(true);
      }
      // Project folders stay ordinary: no template.json, no thumbnail, no .noobide/.
      const names = await tree(root);
      expect(names).not.toContain('template.json');
      expect(names).not.toContain(template.thumbnail);
      expect(names.some((n) => n.startsWith('.'))).toBe(false);
    },
  );

  it('refuses an existing empty folder with that name and leaves it alone', async () => {
    await mkdir(path.join(parentDir, '我的 主页'));
    const result = await createProjectFromTemplate(intro, { parentDir, name: '我的 主页' });
    expect(result).toMatchObject({ ok: false, code: 'exists', message: '我的 主页' });
    expect(await readdir(path.join(parentDir, '我的 主页'))).toEqual([]);
  });

  it('never writes into an existing non-empty folder', async () => {
    const existing = path.join(parentDir, '我的 主页');
    await mkdir(existing);
    await writeFile(path.join(existing, 'index.html'), '<p>my own page</p>');
    const result = await createProjectFromTemplate(intro, { parentDir, name: '我的 主页' });
    expect(result).toMatchObject({ ok: false, code: 'exists' });
    expect(await tree(existing)).toEqual(['index.html']);
    expect(await readFile(path.join(existing, 'index.html'), 'utf8')).toBe('<p>my own page</p>');
  });

  it('refuses a file with that name', async () => {
    await writeFile(path.join(parentDir, 'site'), 'notes');
    expect(await createProjectFromTemplate(intro, { parentDir, name: 'site' })).toMatchObject({ code: 'exists' });
    expect(await readFile(path.join(parentDir, 'site'), 'utf8')).toBe('notes');
  });

  it('refuses a name that differs from an existing folder only in letter case', async () => {
    await mkdir(path.join(parentDir, 'My Site'));
    const result = await createProjectFromTemplate(intro, { parentDir, name: 'my site' });
    expect(result).toMatchObject({ ok: false, code: 'case-conflict', message: 'My Site' });
    expect(await readdir(parentDir)).toEqual(['My Site']);
  });

  it.each([
    ['CON', 'reserved-windows'],
    ['a:b', 'invalid-char'],
    ['页面.', 'trailing-dot-or-space'],
    ['.hidden', 'starts-with-dot'],
    ['', 'empty'],
  ])('explains the illegal name %j instead of changing it', async (name, problem) => {
    const result = await createProjectFromTemplate(intro, { parentDir, name });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('invalid-name');
      expect(result.message.split(',')).toContain(problem);
    }
    expect(await readdir(parentDir)).toEqual([]);
  });

  it('reports a location that does not exist, unless it is the default location (created on demand)', async () => {
    const missing = path.join(tmp, 'Documents', 'NoobIDE 项目');
    expect(await createProjectFromTemplate(intro, { parentDir: missing, name: 'a' })).toMatchObject({
      code: 'location-missing',
    });
    const created = await createProjectFromTemplate(intro, { parentDir: missing, name: 'a' }, { createParent: true });
    expect(created.ok).toBe(true);
    expect(await tree(path.join(missing, 'a'))).toEqual([...intro.files].sort());
  });

  it('removes only what it created when a copy fails half-way, and reports the cause', async () => {
    let copies = 0;
    const failing: CreateFs = {
      mkdir: (p, o) => fsMkdir(p, o),
      readdir: (d) => fsReaddir(d),
      unlink,
      rmdir,
      copyFile: async (from, to, mode) => {
        copies += 1;
        if (copies === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
        await copyFile(from, to, mode);
      },
    };
    const result = await createProjectFromTemplate(intro, { parentDir, name: '我的 主页' }, { fs: failing });
    expect(result).toMatchObject({ ok: false, code: 'disk-full', message: 'ENOSPC' });
    expect(await readdir(parentDir)).toEqual([]);
  });

  it('a rollback never removes a file someone else put into the new folder meanwhile', async () => {
    const root = path.join(parentDir, 'p');
    const failing: CreateFs = {
      mkdir: (p, o) => fsMkdir(p, o),
      readdir: (d) => fsReaddir(d),
      unlink,
      rmdir,
      copyFile: async () => {
        await writeFile(path.join(root, 'theirs.txt'), 'keep me');
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };
    const result = await createProjectFromTemplate(intro, { parentDir, name: 'p' }, { fs: failing });
    expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
    expect(await readFile(path.join(root, 'theirs.txt'), 'utf8')).toBe('keep me');
  });

  it('reports a template whose files are missing as broken and leaves nothing behind', async () => {
    const broken = { dir: path.join(tmp, 'no-such-template'), files: ['index.html'] };
    expect(await createProjectFromTemplate(broken, { parentDir, name: 'x' })).toMatchObject({
      code: 'template-broken',
    });
    expect(await readdir(parentDir)).toEqual([]);
  });
});

describe('checkNewProject (live wizard feedback)', REAL_IO, () => {
  it('returns the exact folder that will be created', async () => {
    const result = await checkNewProject({ parentDir, name: '我的 主页' });
    expect(result).toEqual({ ok: true, value: { folderPath: path.join(parentDir, '我的 主页') } });
    expect(projectFolderPath({ parentDir, name: '我的 主页' })).toBe(path.join(parentDir, '我的 主页'));
    expect(await readdir(parentDir)).toEqual([]); // checking changes nothing
  });

  it('flags collisions and illegal names', async () => {
    await mkdir(path.join(parentDir, '我的 主页'));
    expect(await checkNewProject({ parentDir, name: '我的 主页' })).toMatchObject({ code: 'exists' });
    expect(await checkNewProject({ parentDir, name: 'nul.txt' })).toMatchObject({ code: 'invalid-name' });
    const missing = path.join(tmp, 'nope');
    expect(await checkNewProject({ parentDir: missing, name: 'a' })).toMatchObject({ code: 'location-missing' });
    expect(await checkNewProject({ parentDir: missing, name: 'a' }, { createParent: true })).toMatchObject({
      ok: true,
    });
  });
});

describe('create-project IPC (S20.2)', REAL_IO, () => {
  type Run = (payload: unknown, event: IpcMainInvokeEvent) => Promise<unknown>;
  const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
  let handlers: Map<string, { parse: (p: unknown) => unknown; run: Run }>;
  let open: ReturnType<typeof vi.fn>;
  let projectOpened: ReturnType<typeof vi.fn>;
  let chooseFolder: ReturnType<typeof vi.fn>;
  let documents: string;

  const call = async (channel: string, payload?: unknown) => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    const parsed = h.parse(payload);
    if (parsed === null) return { ok: false, code: 'invalid-request' };
    return h.run(parsed, event);
  };

  beforeEach(() => {
    handlers = new Map();
    documents = path.join(tmp, '文档 Documents');
    open = vi.fn(async (root: string) =>
      ok({
        projectId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
        name: path.basename(root),
        rootPath: root,
        files: [],
        truncated: false,
      }),
    );
    projectOpened = vi.fn();
    chooseFolder = vi.fn(async () => parentDir);
    const handle: HandleFn = (channel, parse, run) => void handlers.set(channel, { parse, run: run as unknown as Run });
    registerCreateProjectHandlers(
      handle,
      { open: open as never },
      { templatesDir: TEMPLATES_DIR, documentsDir: () => documents, chooseFolder: chooseFolder as never },
      projectOpened as never,
    );
  });

  it('offers the three templates with thumbnails and a default location in Documents named per language', async () => {
    const zh = (await call(CHANNELS.createProjectOptions, { locale: 'zh-CN' })) as {
      ok: true;
      value: { templates: { id: string; thumbnail: string; files: string[] }[]; location: { path: string } };
    };
    expect(zh.value.templates.map((t) => t.id)).toEqual(['personal-intro', 'product-showcase', 'button-counter']);
    for (const t of zh.value.templates) expect(t.thumbnail).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(zh.value.location.path).toBe(path.join(documents, DEFAULT_LOCATION_NAMES['zh-CN']));
    const en = (await call(CHANNELS.createProjectOptions, { locale: 'en' })) as {
      value: { location: { path: string } };
    };
    expect(en.value.location.path).toBe(path.join(documents, 'NoobIDE Projects'));
  });

  it('creates in a folder chosen in the native dialog, opens the project and watches it', async () => {
    const chosen = (await call(CHANNELS.chooseProjectLocation)) as { value: { locationId: string; path: string } };
    expect(chosen.value.path).toBe(parentDir);
    expect(chooseFolder).toHaveBeenCalledWith(event, documents);
    const request = { locationId: chosen.value.locationId, name: '我的 主页', templateId: 'button-counter' };
    expect(await call(CHANNELS.checkProjectName, { locationId: request.locationId, name: request.name })).toEqual({
      ok: true,
      value: { folderPath: path.join(parentDir, '我的 主页') },
    });
    const created = (await call(CHANNELS.createProject, request)) as { ok: boolean; value: { entry: string } };
    expect(created.ok).toBe(true);
    expect(created.value.entry).toBe('index.html');
    const root = path.join(parentDir, '我的 主页');
    expect(open).toHaveBeenCalledWith(await import('node:fs/promises').then((fs) => fs.realpath(root)));
    expect(projectOpened).toHaveBeenCalledTimes(1);
    // A second create with the same name is refused and the first project stays intact.
    expect(await call(CHANNELS.createProject, request)).toMatchObject({ ok: false, code: 'exists' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a cancelled folder dialog returns null; unknown location ids and templates are refused', async () => {
    chooseFolder.mockResolvedValueOnce(null);
    expect(await call(CHANNELS.chooseProjectLocation)).toEqual({ ok: true, value: null });
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      await call(CHANNELS.createProject, { locationId: unknown, name: 'a', templateId: 'personal-intro' }),
    ).toMatchObject({
      code: 'unknown-location',
    });
    const options = (await call(CHANNELS.createProjectOptions, { locale: 'zh-CN' })) as {
      value: { location: { locationId: string } };
    };
    expect(
      await call(CHANNELS.createProject, {
        locationId: options.value.location.locationId,
        name: 'a',
        templateId: 'nope',
      }),
    ).toMatchObject({ code: 'unknown-template' });
  });

  it.each([
    ['an absolute path instead of a location id', { locationId: 'C:\\Users', name: 'a', templateId: 'personal-intro' }],
    [
      'an extra path field',
      { locationId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f', name: 'a', templateId: 'personal-intro', parent: '/' },
    ],
    [
      'a template id that is a path',
      { locationId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f', name: 'a', templateId: '../x' },
    ],
    [
      'a non-string name',
      { locationId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f', name: 1, templateId: 'personal-intro' },
    ],
  ])('rejects %s before touching the disk', async (_name, payload) => {
    expect(await call(CHANNELS.createProject, payload)).toEqual({ ok: false, code: 'invalid-request' });
    expect(open).not.toHaveBeenCalled();
  });

  it('the default location is created with the first project in it', async () => {
    const options = (await call(CHANNELS.createProjectOptions, { locale: 'zh-CN' })) as {
      value: { location: { locationId: string; path: string } };
    };
    const created = await call(CHANNELS.createProject, {
      locationId: options.value.location.locationId,
      name: '第一个 网页',
      templateId: 'personal-intro',
    });
    expect(created).toMatchObject({ ok: true });
    expect(await tree(path.join(options.value.location.path, '第一个 网页'))).toEqual([...intro.files].sort());
  });
});
