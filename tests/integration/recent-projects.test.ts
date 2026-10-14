import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecentProjects } from '../../src/main/recent-projects';

/**
 * S13.3 on a real file system: the recent-projects list lives in app data, project paths with Chinese characters and
 * spaces; missing folders are reported unavailable (never dropped silently); removing an entry never touches disk.
 */
let tmp: string;
let file: string;
let projectA: string;
let projectB: string;
let clock = 1000;
const now = () => (clock += 1);

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-recent-'));
  file = path.join(tmp, '应用 数据', 'recent-projects.json');
  projectA = path.join(tmp, '网页 练习', '项目 甲');
  projectB = path.join(tmp, '网页 练习', '项目 乙');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  await writeFile(path.join(projectA, 'index.html'), '<p>甲</p>');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('recent projects (S13.3)', () => {
  it('lists opened projects newest first with name and full path, and persists across runs', async () => {
    const recent = new RecentProjects({ file, now });
    await recent.touch(projectA);
    await recent.touch(projectB);
    await recent.touch(projectA); // reopened: moves to the top, keeps its id
    const list = await recent.list();
    expect(list.map((p) => [p.name, p.path, p.available])).toEqual([
      ['项目 甲', projectA, true],
      ['项目 乙', projectB, true],
    ]);
    const again = await new RecentProjects({ file }).list();
    expect(again.map((p) => p.id)).toEqual(list.map((p) => p.id));
    expect(await new RecentProjects({ file }).rootOf(list[0]?.id ?? '')).toBe(projectA);
  });

  it('a folder that no longer exists is shown as unavailable, not removed', async () => {
    const recent = new RecentProjects({ file, now });
    await recent.touch(projectA);
    await recent.touch(projectB);
    await rm(projectB, { recursive: true });
    const list = await recent.list();
    expect(list.map((p) => [p.name, p.available])).toEqual([
      ['项目 乙', false],
      ['项目 甲', true],
    ]);
  });

  it('removing an entry changes only the list, never the folder', async () => {
    const recent = new RecentProjects({ file, now });
    await recent.touch(projectA);
    const [entry] = await recent.list();
    expect(await recent.remove(entry?.id ?? '')).toBe(true);
    expect(await recent.list()).toEqual([]);
    expect(await readdir(projectA)).toEqual(['index.html']);
    expect(await readFile(path.join(projectA, 'index.html'), 'utf8')).toBe('<p>甲</p>');
    expect(await recent.remove('3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f')).toBe(false);
  });

  it('keeps at most `max` entries', async () => {
    const recent = new RecentProjects({ file, now, max: 3 });
    for (let i = 0; i < 5; i += 1) await recent.touch(path.join(tmp, `p${i}`));
    expect((await recent.list()).map((p) => p.name)).toEqual(['p4', 'p3', 'p2']);
  });

  it('a corrupt list is backed up and replaced, malformed entries are skipped one by one', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    const recent = new RecentProjects({ file, now });
    expect(await recent.list()).toEqual([]);
    const names = await readdir(path.dirname(file));
    expect(names.some((n) => n.startsWith('recent-projects.corrupt-'))).toBe(true);

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        projects: [
          { id: 'not-an-id', rootPath: projectA, lastOpened: 1 },
          { id: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f', rootPath: 'relative/path', lastOpened: 1 },
          { id: '9b2f6c1e-4d3a-4b8c-8e7f-0a1b2c3d4e5f', rootPath: projectB, lastOpened: 2 },
        ],
      }),
    );
    expect((await new RecentProjects({ file }).list()).map((p) => p.path)).toEqual([projectB]);
  });
});
