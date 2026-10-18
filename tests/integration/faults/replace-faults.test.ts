import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_IO, removeTempDir } from '../real-io';
import { toIpcResult } from '../../../src/shared/ipc/contract';
import { ProjectService } from '../../../src/workspace/project-service';
import { searchProject } from '../../../src/workspace/project-search';
import { DocumentSaver } from '../../../src/renderer/workbench/save-controller';
import { saveStatus } from '../../../src/renderer/workbench/save-machine';
import { applyReplace, buildPlan, type ReplaceHost } from '../../../src/renderer/search/replace-apply';
import type { SearchQuery } from '../../../src/shared/search';
import { faults, isTempFile } from './fault-fs';

vi.mock('node:fs/promises', async (importOriginal) => (await import('./fault-fs')).faultyFs(await importOriginal()));

/**
 * S51.4 fault suite — replace in files when one file cannot be saved (disk full while writing its temp file). The
 * other files still apply; the failed file keeps the replaced text in its editor buffer with the save-failure state
 * (nothing is lost, a retry saves it), its file on disk is exactly the old version, no temp file is left, and the
 * summary lists the applied and the failed files. Paths contain Chinese characters and spaces.
 */
const query: SearchQuery = { text: 'card', regex: false, caseSensitive: true, wholeWord: false };
const FILES: Record<string, string> = {
  'a 页面.html': '<div class="card"></div>\n',
  'b 样式.css': '.card { color: red; }\n',
  'c 脚本.js': "document.querySelector('.card');\n",
};

let tmp: string;
let root: string;

beforeEach(async () => {
  faults.reset();
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-replace-faults-')));
  root = path.join(tmp, '网页 练习', '我的 第一个 网页');
  await mkdir(root, { recursive: true });
  for (const [name, text] of Object.entries(FILES)) await writeFile(path.join(root, name), text);
}, REAL_IO.timeout);

afterEach(async () => {
  faults.reset();
  await removeTempDir(tmp);
}, REAL_IO.timeout);

describe('replace in files faults (S51.4)', REAL_IO, () => {
  it('one file fails to save (disk full): the others apply, the failed one keeps its edit in memory', async () => {
    const service = new ProjectService({ atomic: { renameBackoffMs: [1, 1, 1], sleep: async () => undefined } });
    const opened = await service.open(root);
    if (!opened.ok) throw new Error(opened.code);
    const { projectId } = opened.value;
    const searched = await searchProject(root, 1, query, []);
    if (!searched.ok) throw new Error(searched.code);

    const tabs = new Map<string, DocumentSaver>();
    const host: ReplaceHost = {
      async prepare(relPath) {
        const read = await service.read({ projectId, relPath });
        if (!read.ok) return { error: 'open-failed' };
        let known = read.value.version.hash;
        const saver = new DocumentSaver({
          initialText: read.value.text,
          autosave: false,
          write: async (text) => {
            const result = toIpcResult(
              await service.write({ projectId, relPath, text, bom: false, expectedHash: known }),
            );
            if (!result.ok) return { ok: false, code: result.code, message: result.message };
            known = result.value.version.hash;
            return { ok: true };
          },
        });
        tabs.set(relPath, saver);
        return { text: saver.text };
      },
      async commit(relPath, before, after) {
        const saver = tabs.get(relPath);
        if (!saver || saver.text !== before) return { ok: false, code: 'changed-since' };
        saver.edit(after);
        return (await saver.save()) ? { ok: true } : { ok: false, code: saver.state.error?.code ?? 'unknown' };
      },
    };

    // The disk is full while the stylesheet's temp file is written.
    faults.add({ op: 'write', code: 'ENOSPC', where: (p) => isTempFile(p) && p.includes('b 样式.css') });
    faults.add({ op: 'writeFile', code: 'ENOSPC', where: (p) => isTempFile(p) && p.includes('b 样式.css') });
    const summary = await applyReplace(
      buildPlan(projectId, searched.value, query, 'panel', new Set(), new Set()),
      host,
    );

    expect(faults.fired.length).toBeGreaterThan(0);
    expect(summary.applied.map((a) => a.relPath)).toEqual(['a 页面.html', 'c 脚本.js']);
    expect(summary.failed).toEqual([{ relPath: 'b 样式.css', reason: 'save-failed', detail: 'disk-full' }]);
    expect(await readFile(path.join(root, 'a 页面.html'), 'utf8')).toBe('<div class="panel"></div>\n');
    expect(await readFile(path.join(root, 'c 脚本.js'), 'utf8')).toBe("document.querySelector('.panel');\n");
    // The failed file: old version on disk, new text kept in the editor with the save-failure state.
    expect(await readFile(path.join(root, 'b 样式.css'), 'utf8')).toBe(FILES['b 样式.css']);
    const failed = tabs.get('b 样式.css') as DocumentSaver;
    expect(failed.text).toBe('.panel { color: red; }\n');
    expect(saveStatus(failed.state)).toBe('failed');
    expect(failed.state.error?.code).toBe('disk-full');
    expect((await readdir(root)).filter(isTempFile)).toEqual([]);

    // Once space is free again, the kept text saves (the user's retry on the tab).
    faults.restart();
    expect(await failed.save()).toBe(true);
    expect(await readFile(path.join(root, 'b 样式.css'), 'utf8')).toBe('.panel { color: red; }\n');
  });
});
