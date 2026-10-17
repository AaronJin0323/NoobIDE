import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toIpcResult } from '../../src/shared/ipc/contract';
import { ProjectService } from '../../src/workspace/project-service';
import { CHANGED_ON_DISK, DocumentSaver } from '../../src/renderer/workbench/save-controller';
import { applyRename, type RenameHost } from '../../src/renderer/workbench/rename-apply';

/**
 * S57.2 cross-file rename through the save pipeline, on a real folder with a Chinese path: every file is written by
 * its own DocumentSaver (atomic write, S11.1 "changed on disk" hash check), exactly as the workbench's tabs are.
 * "The editor" keeps one undo stack per tab, as Monaco does (the rename is one undoable edit per file).
 */
let tmp: string;
let root: string;
const CONFIG = 'function greet(name) {\n  return name;\n}\n';
const APP = "greet('a');\ngreet('b');\n";
const plan = [
  { relPath: 'app.js', before: APP, after: "sayHello('a');\nsayHello('b');\n" },
  { relPath: 'config.js', before: CONFIG, after: CONFIG.replace('greet', 'sayHello') },
];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-rename-'));
  root = path.join(tmp, '重命名 练习');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'app.js'), APP);
  await writeFile(path.join(root, 'config.js'), CONFIG);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const onDisk = (name: string) => readFile(path.join(root, name), 'utf8');

/** A minimal workbench: tabs opened from disk, each with a saver and an undo stack. */
async function workbench(options: { failWrites?: Set<string> } = {}) {
  const service = new ProjectService({ atomic: { syncDirectory: false } });
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  const projectId = opened.value.projectId;
  const tabs = new Map<string, { saver: DocumentSaver; undo: string[]; hash: string }>();
  const openTab = async (relPath: string) => {
    const existing = tabs.get(relPath);
    if (existing) return existing;
    const read = await service.read({ projectId, relPath });
    if (!read.ok) return null;
    const tab = { saver: undefined as unknown as DocumentSaver, undo: [] as string[], hash: read.value.version.hash };
    tab.saver = new DocumentSaver({
      initialText: read.value.text,
      autosave: false,
      write: async (text) => {
        if (options.failWrites?.has(relPath)) return { ok: false, code: 'write-failed', message: 'disk full' };
        const result = toIpcResult(
          await service.write({ projectId, relPath, text, bom: false, expectedHash: tab.hash }),
        );
        if (!result.ok) return { ok: false, code: result.code, message: result.message };
        tab.hash = result.value.version.hash;
        return { ok: true };
      },
    });
    tabs.set(relPath, tab);
    return tab;
  };
  const host: RenameHost = {
    open: async (relPath) => {
      const tab = await openTab(relPath);
      return tab ? { text: tab.saver.text, blocked: tab.saver.state.conflict } : null;
    },
    replace: async (relPath, before, after) => {
      const tab = tabs.get(relPath);
      if (!tab || tab.saver.text !== before) return false;
      tab.undo.push(tab.saver.text); // one undoable edit
      tab.saver.edit(after);
      return true;
    },
    save: async (relPath) => (await tabs.get(relPath)?.saver.save()) ?? false,
  };
  const undo = (relPath: string) => {
    const tab = tabs.get(relPath);
    const previous = tab?.undo.pop();
    if (tab && previous !== undefined) tab.saver.edit(previous);
  };
  return { host, tabs, undo, openTab };
}

describe('cross-file rename through the save pipeline (S57.2)', () => {
  it('writes every file through its saver; each file can be undone on its own', async () => {
    const { host, tabs, undo } = await workbench();
    const outcome = await applyRename(plan, host);
    expect(outcome).toEqual({
      applied: true,
      files: [
        { relPath: 'app.js', status: 'renamed' },
        { relPath: 'config.js', status: 'renamed' },
      ],
    });
    expect(await onDisk('app.js')).toBe(plan[0]?.after);
    expect(await onDisk('config.js')).toBe(plan[1]?.after);
    // Undo in one tab only: that file goes back, the other stays renamed.
    undo('config.js');
    expect(await tabs.get('config.js')?.saver.save()).toBe(true);
    expect(await onDisk('config.js')).toBe(CONFIG);
    expect(await onDisk('app.js')).toBe(plan[0]?.after);
  });

  it('fault: a file changed on disk since the preview is refused, and nothing is changed', async () => {
    await writeFile(path.join(root, 'config.js'), `${CONFIG}// edited elsewhere\n`);
    const { host, tabs } = await workbench();
    const outcome = await applyRename(plan, host);
    expect(outcome).toEqual({
      applied: false,
      files: [
        { relPath: 'app.js', status: 'skipped' },
        { relPath: 'config.js', status: 'changed' },
      ],
    });
    expect(await onDisk('app.js')).toBe(APP);
    expect(tabs.get('app.js')?.saver.text).toBe(APP); // not even the tab was changed
  });

  it('fault: a file changed on disk between the check and the save is not overwritten; the edit stays in the tab', async () => {
    const { host, tabs, openTab } = await workbench();
    await openTab('config.js');
    // Someone else writes the file after NoobIDE read it: the saver's hash check refuses the write.
    const save = host.save.bind(host);
    host.save = async (relPath) => {
      if (relPath === 'config.js') await writeFile(path.join(root, 'config.js'), 'other version\n');
      return save(relPath);
    };
    const outcome = await applyRename(plan, host);
    expect(outcome.files).toEqual([
      { relPath: 'app.js', status: 'renamed' },
      { relPath: 'config.js', status: 'save-failed' },
    ]);
    expect(await onDisk('config.js')).toBe('other version\n'); // never overwritten
    const saver = tabs.get('config.js')?.saver;
    expect(saver?.text).toBe(plan[1]?.after); // the rename is kept in memory
    expect(saver?.state.conflict).toBe(true);
    expect(saver?.state.error?.code).toBe(CHANGED_ON_DISK);
  });

  it('fault: a failed write keeps the renamed text in memory and is reported per file', async () => {
    const { host, tabs } = await workbench({ failWrites: new Set(['app.js']) });
    const outcome = await applyRename(plan, host);
    expect(outcome.files).toEqual([
      { relPath: 'app.js', status: 'save-failed' },
      { relPath: 'config.js', status: 'renamed' },
    ]);
    expect(await onDisk('app.js')).toBe(APP);
    expect(tabs.get('app.js')?.saver.text).toBe(plan[0]?.after);
  });

  it('a file edited in its tab since the preview is refused like a disk change', async () => {
    const { host, openTab } = await workbench();
    (await openTab('app.js'))?.saver.edit(`${APP}greet('c');\n`);
    const outcome = await applyRename(plan, host);
    expect(outcome.applied).toBe(false);
    expect(outcome.files[0]).toEqual({ relPath: 'app.js', status: 'changed' });
    expect(await onDisk('config.js')).toBe(CONFIG);
  });

  it('fault: a file that changes while the rename is being applied puts the others back; nothing is saved', async () => {
    const { host, tabs } = await workbench();
    const replace = host.replace.bind(host);
    host.replace = async (relPath, before, after) => {
      // config.js is typed into after the check, before its turn
      if (relPath === 'config.js' && before === CONFIG) tabs.get('config.js')?.saver.edit(`${CONFIG}// typed\n`);
      return replace(relPath, before, after);
    };
    const outcome = await applyRename(plan, host);
    expect(outcome).toEqual({
      applied: false,
      files: [
        { relPath: 'app.js', status: 'skipped' },
        { relPath: 'config.js', status: 'changed' },
      ],
    });
    expect(tabs.get('app.js')?.saver.text).toBe(APP); // put back
    expect(await onDisk('app.js')).toBe(APP);
    expect(await onDisk('config.js')).toBe(CONFIG);
  });
});
