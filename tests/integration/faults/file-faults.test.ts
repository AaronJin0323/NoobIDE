import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from '../real-io';
import { RecoveryJournal } from '../../../src/recovery/journal';
import { ProjectService } from '../../../src/workspace/project-service';
import { createProjectFromTemplate } from '../../../src/workspace/create-project';
import { renameEntry, RENAME_TEMP_PREFIX, type FileOpsFs } from '../../../src/workspace/file-ops';
import { faults, under } from './fault-fs';

vi.mock('node:fs/promises', async (importOriginal) => (await import('./fault-fs')).faultyFs(await importOriginal()));

/**
 * S26.1 fault suite — file operations and the PLAN §11 project cases: files deleted or projects renamed outside
 * NoobIDE, read-only folders, failing renames, moves to the trash and project creation. The rule is always the same:
 * a refused or failed operation leaves every existing file byte-for-byte as it was, never overwrites anything, and
 * never loses the text in the editor. Paths contain Chinese characters and spaces.
 */
const PAGE = '<h1>我的 网页</h1>\n';
const STYLE = 'h1 { color: teal; }\n';
const BUF = '0a0b0c0d-0e0f-4011-8213-141516171819';

let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

const file = (rel: string) => path.join(root, ...rel.split('/'));
const text = (rel: string) => readFile(file(rel), 'utf8');

async function listing(dir = root): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

beforeEach(async () => {
  faults.reset();
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-file-faults-')));
  root = path.join(tmp, '网页 练习', '我的 第一个 网页');
  await mkdir(path.join(root, '样式 表'), { recursive: true });
  await writeFile(file('index.html'), PAGE);
  await writeFile(file('样式 表/主 样式.css'), STYLE);
  service = new ProjectService();
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.code);
  projectId = opened.value.projectId;
}, REAL_IO.timeout);

afterEach(async () => {
  faults.reset();
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const BEFORE = ['index.html', '样式 表/主 样式.css'];
const inRoot = (p: string) => under(() => root)(p);

describe('S26.1 file operation faults: nothing existing changes', REAL_IO, () => {
  it.each([
    ['ENOSPC', 'disk full', 'op-failed'],
    ['EACCES', 'read-only folder', 'permission-denied'],
    ['EROFS', 'read-only volume', 'permission-denied'],
  ])('creating a file fails with %s (%s) → %s; the tree is unchanged', async (code, _what, expected) => {
    faults.add({ op: 'open', flags: 'wx', code, where: inRoot });
    faults.add({ op: 'mkdir', code, where: inRoot });
    expect(await service.createEntry({ projectId, relPath: 'about.html', kind: 'file' })).toMatchObject({
      ok: false,
      code: expected,
    });
    expect(await service.createEntry({ projectId, relPath: '图片', kind: 'directory' })).toMatchObject({
      ok: false,
      code: expected,
    });
    faults.restart();
    expect(await listing()).toEqual(BEFORE);
  });

  it('a rename refused by the OS (EACCES on link and rename) keeps the source and creates nothing', async () => {
    faults.add({ op: 'link', code: 'EACCES', where: inRoot });
    faults.add({ op: 'rename', code: 'EACCES', where: inRoot });
    expect(await service.renameEntry({ projectId, from: 'index.html', to: '首页.html' })).toMatchObject({
      ok: false,
      code: 'permission-denied',
    });
    faults.restart();
    expect(await listing()).toEqual(BEFORE);
    expect(await text('index.html')).toBe(PAGE);
  });

  it('removing the old name fails after the new one was linked (file in use): no duplicate, nothing lost', async () => {
    faults.add({ op: 'unlink', code: 'EBUSY', where: (p) => p === file('index.html') });
    expect(await service.renameEntry({ projectId, from: 'index.html', to: '首页.html' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    faults.restart();
    expect(await listing()).toEqual(BEFORE);
    expect(await text('index.html')).toBe(PAGE);
  });

  it('a case-only rename that cannot finish or be undone reports the temporary name; the content is intact', async () => {
    // A volume that keeps the old spelling forces the hop through a visible temporary name; then both the step to
    // the new name and the step back fail (e.g. the USB stick was pulled for a moment).
    const real = await import('node:fs/promises');
    let renames = 0;
    const stubborn: FileOpsFs = {
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) return; // "succeeds" but keeps the old spelling
        if (renames >= 3) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        await real.rename(from, to);
      },
      link: real.link,
      unlink: real.unlink,
      readdir: (dir) => real.readdir(dir),
      lstat: (p) => real.lstat(p),
    };
    const result = await renameEntry(root, 'index.html', 'Index.html', stubborn);
    expect(result).toMatchObject({ ok: false, code: 'interrupted' });
    if (result.ok) return;
    expect(result.message.startsWith(RENAME_TEMP_PREFIX)).toBe(true);
    // Nothing is lost: the page is under the reported name, with its content.
    expect(await readFile(path.join(root, result.message), 'utf8')).toBe(PAGE);
    expect((await readdir(root)).sort()).toEqual([result.message, '样式 表'].sort());
  });

  it('a failed move to the trash keeps the file; local history failing first does not delete anything', async () => {
    const failing = new ProjectService({
      history: {
        captureBeforeSave: async () => null,
        recordSave: () => undefined,
        beforeDelete: async () => {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        },
      },
    });
    const opened = await failing.open(root);
    if (!opened.ok) throw new Error(opened.code);
    const result = await failing.trashEntry({ projectId: opened.value.projectId, relPath: 'index.html' }, async () => {
      throw new Error('The file is open in another program');
    });
    expect(result).toMatchObject({ ok: false, code: 'trash-failed' });
    expect(await text('index.html')).toBe(PAGE);
  });

  it('creating a project runs out of space half-way: only what it created is removed', async () => {
    const parent = path.join(tmp, '文档 Documents');
    await mkdir(path.join(parent, '已有 项目'), { recursive: true });
    await writeFile(path.join(parent, '已有 项目', 'index.html'), PAGE);
    const template = path.join(tmp, 'template');
    await mkdir(path.join(template, 'css'), { recursive: true });
    await writeFile(path.join(template, 'index.html'), '<p>模板</p>');
    await writeFile(path.join(template, 'css', 'style.css'), 'p {}');
    let copies = 0;
    faults.add({ op: 'copyFile', code: 'ENOSPC', where: (p) => under(parent)(p) && (copies += 1) > 1 });
    const result = await createProjectFromTemplate(
      { dir: template, files: ['index.html', 'css/style.css'] },
      { parentDir: parent, name: '新 项目' },
    );
    expect(result).toMatchObject({ ok: false, code: 'disk-full' });
    faults.restart();
    expect(await listing(parent)).toEqual(['已有 项目/index.html']);
    expect(await readFile(path.join(parent, '已有 项目', 'index.html'), 'utf8')).toBe(PAGE);
  });
});

describe('S26.1 PLAN §11 project cases', REAL_IO, () => {
  it.each(['ENOSPC', 'EIO'])(
    're-creating a deleted file fails (%s) after its name was reserved: no empty placeholder is left behind',
    async (code) => {
      await rm(file('index.html'));
      const edited = '<h1>重新创建的内容</h1>\n';
      faults.add({ op: 'write', code, where: (p) => inRoot(p) && p.endsWith('.noobide-tmp'), times: 1 });
      const failed = await service.write({ projectId, relPath: 'index.html', text: edited, bom: false, create: true });
      expect(failed).toMatchObject({ ok: false });
      faults.restart();
      // An empty file would read as "the deleted file came back with other content": a false conflict on retry.
      expect(await listing()).toEqual(['样式 表/主 样式.css']);
      const retry = await service.write({ projectId, relPath: 'index.html', text: edited, bom: false, create: true });
      expect(retry.ok).toBe(true);
      expect(await text('index.html')).toBe(edited);
    },
  );

  it('a failed re-create never removes content another program wrote into the reserved file', async () => {
    await rm(file('index.html'));
    const theirs = '<p>另一个程序刚写入的内容</p>';
    faults.add({
      op: 'write',
      code: 'ENOSPC',
      times: 1,
      where: (p) => {
        if (!(inRoot(p) && p.endsWith('.noobide-tmp'))) return false;
        writeFileSync(file('index.html'), theirs); // lands between the reservation and our write
        return true;
      },
    });
    const failed = await service.write({ projectId, relPath: 'index.html', text: 'mine', bom: false, create: true });
    expect(failed.ok).toBe(false);
    faults.restart();
    expect(await text('index.html')).toBe(theirs);
  });

  it('recovery after deletion: a file deleted outside NoobIDE keeps the edits and can be written again', async () => {
    const read = await service.read({ projectId, relPath: 'index.html' });
    if (!read.ok) throw new Error(read.code);
    await rm(file('index.html'));
    const edited = '<h1>删除之后还在的修改</h1>\n';
    const plain = await service.write({ projectId, relPath: 'index.html', text: edited, bom: false });
    expect(plain).toMatchObject({ ok: false, code: 'not-found' });
    const again = await service.write({ projectId, relPath: 'index.html', text: edited, bom: false, create: true });
    expect(again.ok).toBe(true);
    expect(await text('index.html')).toBe(edited);
  });

  it('a deleted file that reappears with other content is never overwritten by re-creating it', async () => {
    await rm(file('index.html'));
    await writeFile(file('index.html'), '<p>别的程序放回来的</p>');
    const result = await service.write({ projectId, relPath: 'index.html', text: 'mine', bom: false, create: true });
    expect(result).toMatchObject({ ok: false, code: 'changed-on-disk' });
    expect(await text('index.html')).toBe('<p>别的程序放回来的</p>');
  });

  it('reopening after renaming: the old path fails cleanly, the new path opens, the recovery copy is kept', async () => {
    const journal = new RecoveryJournal({ dir: path.join(tmp, 'app data', 'recovery') });
    await journal.record(
      { rootPath: root, relPath: 'index.html' },
      { bufferId: BUF, revision: 1, text: 'unsaved', bom: false },
    );
    const renamed = path.join(tmp, '网页 练习', '改名 以后的 网页');
    await rename(root, renamed);
    // Saving into the vanished folder fails without creating anything at the old place.
    expect(await service.write({ projectId, relPath: 'index.html', text: 'x', bom: false })).toMatchObject({
      ok: false,
      code: 'not-found',
    });
    await expect(readdir(root)).rejects.toMatchObject({ code: 'ENOENT' });

    const next = new RecoveryJournal({ dir: path.join(tmp, 'app data', 'recovery') });
    const [pending] = await next.listPending();
    expect(pending?.rootPath).toBe(root);
    // The recovery dialog's "open project" fails for the old path (explained, nothing removed)…
    expect(await new ProjectService().open(pending?.rootPath ?? '')).toMatchObject({ ok: false, code: 'list-failed' });
    // …while the copy is still there to restore once the user opens the renamed folder.
    expect(await next.read({ rootPath: root, relPath: 'index.html' }, BUF)).toMatchObject({
      value: { text: 'unsaved' },
    });
    expect(await new ProjectService().open(renamed)).toMatchObject({ ok: true });
    expect(await readFile(path.join(renamed, 'index.html'), 'utf8')).toBe(PAGE);
  });

  it('external changes: a file changed outside NoobIDE is refused, not overwritten', async () => {
    const read = await service.read({ projectId, relPath: 'index.html' });
    if (!read.ok) throw new Error(read.code);
    await writeFile(file('index.html'), '<p>外部编辑器的修改</p>');
    const result = await service.write({
      projectId,
      relPath: 'index.html',
      text: 'mine',
      bom: false,
      expectedHash: read.value.version.hash,
    });
    expect(result).toMatchObject({ ok: false, code: 'changed-on-disk' });
    expect(await text('index.html')).toBe('<p>外部编辑器的修改</p>');
  });
});
