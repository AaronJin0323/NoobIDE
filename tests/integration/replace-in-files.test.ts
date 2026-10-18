import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_IO, removeTempDir } from './real-io';
import { toIpcResult } from '../../src/shared/ipc/contract';
import { ProjectService } from '../../src/workspace/project-service';
import { searchProject } from '../../src/workspace/project-search';
import { DocumentSaver } from '../../src/renderer/workbench/save-controller';
import { saveStatus } from '../../src/renderer/workbench/save-machine';
import { applyReplace, buildPlan, hitId, type ReplaceHost } from '../../src/renderer/search/replace-apply';
import { matchKey, type SearchQuery } from '../../src/shared/search';
import type { OpenBuffer, SearchResults } from '../../src/shared/ipc/search-contract';

/**
 * S51.4 replace in files on the real file system, wired like the app: the search runs in "main" (searchProject), the
 * apply goes file by file through an editor-like host whose DocumentSaver writes with ProjectService (atomic temp +
 * rename, S11.1 version check). Paths contain Chinese characters and spaces.
 */
let tmp: string;
let root: string;
let service: ProjectService;
let projectId: string;

const CARD = 'card';
const query: SearchQuery = { text: CARD, regex: false, caseSensitive: true, wholeWord: false };
const FILES: Record<string, string> = {
  'index.html': '<div class="card">\n  <p class="card-title">你好</p>\n</div>\n',
  'css/样式 表.css': '.card {\n  color: red;\n}\n.card-title {\n  font-weight: 600;\n}\n',
  '子 文件夹/页面 二.html': '<section class="card"></section>\n',
};

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-replace-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  for (const [relPath, text] of Object.entries(FILES)) {
    const full = path.join(root, ...relPath.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  service = new ProjectService({ atomic: { renameBackoffMs: [1, 1, 1], sleep: async () => undefined } });
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.code);
  projectId = opened.value.projectId;
}, REAL_IO.timeout);

afterEach(async () => {
  await removeTempDir(tmp);
}, REAL_IO.timeout);

const disk = (relPath: string) => readFile(path.join(root, ...relPath.split('/')), 'utf8');

async function search(buffers: OpenBuffer[] = []): Promise<SearchResults> {
  const result = await searchProject(root, 1, query, buffers);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

/** The workbench's part: one DocumentSaver per opened file, writing through ProjectService with the known hash. */
function editorHost() {
  const tabs = new Map<string, DocumentSaver>();
  const host: ReplaceHost = {
    async prepare(relPath, planProject) {
      // The workbench refuses a plan of another project (it may hold files with the same names).
      if (planProject !== projectId) return { error: 'project-changed' };
      const open = tabs.get(relPath);
      if (open) return { text: open.text };
      const read = await service.read({ projectId, relPath });
      if (!read.ok) return { error: 'open-failed' };
      let known = read.value.version.hash;
      const saver = new DocumentSaver({
        initialText: read.value.text,
        autosave: false,
        write: async (text) => {
          const result = toIpcResult(
            await service.write({ projectId, relPath, text, bom: read.value.bom, expectedHash: known }),
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
      saver.edit(after); // the editor model's change, as one edit
      if (await saver.save()) return { ok: true };
      return { ok: false, code: saver.state.error?.code ?? 'unknown' };
    },
  };
  return { host, tabs };
}

describe('replace in files (S51.4)', REAL_IO, () => {
  it('writes every changed file through its saver and the atomic write, only the kept matches', async () => {
    const results = await search();
    expect(results.totalMatches).toBe(5);
    const { host, tabs } = editorHost();
    // The user excluded one match (the .card-title rule) in the stylesheet.
    const excluded = new Set([hitId('css/样式 表.css', matchKey(4, 2))]);
    const summary = await applyReplace(buildPlan(projectId, results, query, 'panel', new Set(), excluded), host);
    expect(summary.failed).toEqual([]);
    expect(summary.applied).toEqual([
      { relPath: 'css/样式 表.css', replaced: 1 },
      { relPath: 'index.html', replaced: 2 },
      { relPath: '子 文件夹/页面 二.html', replaced: 1 },
    ]);
    expect(await disk('index.html')).toBe(FILES['index.html']?.replaceAll('card', 'panel'));
    expect(await disk('css/样式 表.css')).toBe('.panel {\n  color: red;\n}\n.card-title {\n  font-weight: 600;\n}\n');
    expect(await disk('子 文件夹/页面 二.html')).toBe('<section class="panel"></section>\n');
    for (const saver of tabs.values()) expect(saveStatus(saver.state)).not.toBe('failed');
    // Atomic writes leave no temp files behind.
    const leftovers = (await readdir(root, { recursive: true })).filter((name) => name.endsWith('.noobide-tmp'));
    expect(leftovers).toEqual([]);
  });

  it('an excluded file is left alone', async () => {
    const results = await search();
    const { host } = editorHost();
    const summary = await applyReplace(
      buildPlan(projectId, results, query, 'panel', new Set(['index.html']), new Set()),
      host,
    );
    expect(summary.applied.map((a) => a.relPath)).not.toContain('index.html');
    expect(await disk('index.html')).toBe(FILES['index.html']);
  });

  it('refuses a file changed on disk since the search, with an explanation, and never overwrites it', async () => {
    const results = await search();
    const external = '<div class="card">changed outside NoobIDE</div>\n';
    await writeFile(path.join(root, 'index.html'), external);
    const { host } = editorHost();
    const summary = await applyReplace(buildPlan(projectId, results, query, 'panel', new Set(), new Set()), host);
    expect(summary.failed).toEqual([{ relPath: 'index.html', reason: 'changed-since-search' }]);
    expect(await disk('index.html')).toBe(external);
    expect(summary.applied.map((a) => a.relPath)).toEqual(['css/样式 表.css', '子 文件夹/页面 二.html']);
  });

  it('an open file whose disk version changed after it was opened is refused by the save’s version check', async () => {
    const { host, tabs } = editorHost();
    await host.prepare('index.html', projectId); // open in the editor, clean
    const results = await search([{ relPath: 'index.html', text: tabs.get('index.html')?.text ?? '' }]);
    const external = `${FILES['index.html']}<!-- edited elsewhere -->\n`;
    await writeFile(path.join(root, 'index.html'), external); // the watcher has not reloaded the tab yet
    const summary = await applyReplace(buildPlan(projectId, results, query, 'panel', new Set(), new Set()), host);
    expect(summary.failed).toEqual([{ relPath: 'index.html', reason: 'save-failed', detail: 'changed-on-disk' }]);
    expect(await disk('index.html')).toBe(external);
    // The replace stays in the editor (undoable there); the save stopped at the S11 conflict state, whose banner
    // compares the two versions. Nothing was lost on either side.
    expect(tabs.get('index.html')?.text).toContain('class="panel"');
    expect(saveStatus(tabs.get('index.html')!.state)).toBe('conflict');
  });

  it('a buffer edited since the search is refused, also between prepare and commit', async () => {
    const { host, tabs } = editorHost();
    await host.prepare('index.html', projectId);
    const results = await search([{ relPath: 'index.html', text: tabs.get('index.html')?.text ?? '' }]);
    tabs.get('index.html')?.edit(`${FILES['index.html']}<p>typed after the search</p>\n`);
    const summary = await applyReplace(buildPlan(projectId, results, query, 'panel', new Set(), new Set()), host);
    expect(summary.failed).toEqual([{ relPath: 'index.html', reason: 'changed-since-search' }]);
    expect(await disk('index.html')).toBe(FILES['index.html']);

    const racing: ReplaceHost = { ...host, commit: async () => ({ ok: false, code: 'changed-since' }) };
    const fresh = await search();
    const raced = await applyReplace(buildPlan(projectId, fresh, query, 'panel', new Set(), new Set()), racing);
    expect(raced.failed.every((f) => f.reason === 'changed-since-search')).toBe(true);
  });

  it('never applies a plan to another project, even with files of the same names', async () => {
    const results = await search();
    const { host } = editorHost();
    const other = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
    const summary = await applyReplace(buildPlan(other, results, query, 'panel', new Set(), new Set()), host);
    expect(summary.applied).toEqual([]);
    expect(summary.failed.every((f) => f.reason === 'project-changed')).toBe(true);
    for (const relPath of Object.keys(FILES)) expect(await disk(relPath)).toBe(FILES[relPath]);
  });

  it('a plan whose query no longer finds the listed matches changes nothing in that file', async () => {
    const results = await search();
    const { host } = editorHost();
    // The results of "card", applied with "card-title" (a query typed after the search): the keys do not all match.
    const stale = { ...query, text: 'card-title' };
    const summary = await applyReplace(buildPlan(projectId, results, stale, 'x', new Set(), new Set()), host);
    expect(summary.applied).toEqual([]);
    expect(summary.failed.map((f) => f.reason)).toEqual([
      'changed-since-search',
      'changed-since-search',
      'changed-since-search',
    ]);
    for (const relPath of Object.keys(FILES)) expect(await disk(relPath)).toBe(FILES[relPath]);
  });

  it('holds the preview refresh for the whole batch and releases it once', async () => {
    const results = await search();
    const { host } = editorHost();
    const events: string[] = [];
    const tracked: ReplaceHost = {
      prepare: (relPath, pid) => host.prepare(relPath, pid),
      commit: async (relPath, before, after, pid) => {
        events.push(`commit ${relPath}`);
        return host.commit(relPath, before, after, pid);
      },
      holdPreview: () => {
        events.push('hold');
        return () => events.push('release');
      },
    };
    await applyReplace(buildPlan(projectId, results, query, 'panel', new Set(), new Set()), tracked);
    expect(events[0]).toBe('hold');
    expect(events.at(-1)).toBe('release');
    expect(events.filter((e) => e === 'release')).toHaveLength(1);
    expect(events.filter((e) => e.startsWith('commit'))).toHaveLength(3);
  });
});
