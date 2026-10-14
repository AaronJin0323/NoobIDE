import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toIpcResult, type WriteFileRequest } from '../../src/shared/ipc/contract';
import { nodeAtomicFs, type AtomicFs } from '../../src/workspace/atomic-write';
import { ProjectService, type ProjectServiceOptions } from '../../src/workspace/project-service';
import { DocumentSaver } from '../../src/renderer/workbench/save-controller';
import { saveStatus } from '../../src/renderer/workbench/save-machine';
import { createSavedFileEvents } from '../../src/renderer/workbench/saved-file-events';

/**
 * The save pipeline from the editor's saver through the IPC result shape to the atomic write on a real folder
 * (S10.4 failure scenarios, S10.5 "saved" ordering, serialized writes). A "preview" subscribes to saved-file events
 * exactly like the workbench wires it, so "preview not refreshed" is checked, not assumed.
 */
let tmp: string;
let root: string;
const ORIGINAL = '<p>原来的内容</p>\n';
const fsError = (code: string) => Object.assign(new Error(code), { code });
const isPosix = path.sep === '/';

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-pipeline-'));
  root = path.join(tmp, '网页 练习');
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'index.html'), ORIGINAL);
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await chmod(path.join(root, 'index.html'), 0o644).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

async function pipeline(options: ProjectServiceOptions = {}) {
  const service = new ProjectService({ ...options, atomic: { syncDirectory: false, ...options.atomic } });
  const opened = await service.open(root);
  if (!opened.ok) throw new Error(opened.message);
  const projectId = opened.value.projectId;
  const request = (text: string): WriteFileRequest => ({ projectId, relPath: 'index.html', text, bom: false });
  const saver = new DocumentSaver({
    initialText: ORIGINAL,
    autosave: false,
    write: async (text) => {
      const result = toIpcResult(await service.write(request(text)));
      return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
    },
  });
  // Wired like Workbench.tsx: the preview hears about a file only through the saver's confirmed writes.
  const savedFiles = createSavedFileEvents();
  saver.onSaved(({ revision }) => savedFiles.emit({ relPath: 'index.html', uri: 'file:///x', revision }));
  const previewRefreshes: number[] = [];
  savedFiles.subscribe(({ revision }) => previewRefreshes.push(revision));
  return { service, saver, previewRefreshes, request, projectId };
}

const leftovers = async () => (await readdir(root)).filter((name) => name.endsWith('.noobide-tmp'));
const onDisk = () => readFile(path.join(root, 'index.html'), 'utf8');

function failingFs(where: 'open' | 'write' | 'rename', code: string): AtomicFs {
  return {
    ...nodeAtomicFs,
    open: async (p, flags, mode) => {
      if (where === 'open' && flags === 'wx') throw fsError(code);
      const handle = await nodeAtomicFs.open(p, flags, mode);
      return {
        writeFile: (data) => (where === 'write' ? Promise.reject(fsError(code)) : handle.writeFile(data)),
        chmod: (m) => handle.chmod(m),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    rename: (a, b) => (where === 'rename' ? Promise.reject(fsError(code)) : nodeAtomicFs.rename(a, b)),
  };
}

describe('save failures keep the edits (S10.4)', () => {
  const scenarios: [string, ProjectServiceOptions, string, string][] = [
    [
      'read-only folder (temp file cannot be created)',
      { atomic: { fs: failingFs('open', 'EACCES'), renameBackoffMs: [] } },
      'permission-denied',
      'EACCES',
    ],
    [
      'file locked by another program (rename stays blocked)',
      { atomic: { fs: failingFs('rename', 'EBUSY'), renameBackoffMs: [1, 1], sleep: async () => {} } },
      'busy',
      'EBUSY after 3 attempts',
    ],
    [
      'file held open without delete sharing on Windows (rename EPERM)',
      { atomic: { fs: failingFs('rename', 'EPERM'), renameBackoffMs: [1], sleep: async () => {} } },
      'busy',
      'EPERM after 2 attempts',
    ],
    [
      'disk full (simulated ENOSPC)',
      { atomic: { fs: failingFs('write', 'ENOSPC'), renameBackoffMs: [] } },
      'disk-full',
      'ENOSPC',
    ],
  ];

  it.each(scenarios)(
    '%s → status failed, text kept, disk unchanged, preview not refreshed',
    async (_name, options, code, message) => {
      const { saver, previewRefreshes } = await pipeline(options);
      saver.edit('<p>新的内容</p>\n');
      expect(await saver.save()).toBe(false);
      expect(saveStatus(saver.state)).toBe('failed');
      expect(saver.state.error).toEqual({ code, message });
      expect(saver.text).toBe('<p>新的内容</p>\n');
      expect(await onDisk()).toBe(ORIGINAL);
      expect(await leftovers()).toEqual([]);
      expect(previewRefreshes).toEqual([]);
    },
  );

  it('permission denied on a read-only file (real file system) → failed, text kept, preview not refreshed', async () => {
    await chmod(path.join(root, 'index.html'), 0o444);
    const { saver, previewRefreshes } = await pipeline();
    saver.edit('<p>只读</p>\n');
    expect(await saver.save()).toBe(false);
    expect(saver.state.error?.code).toBe('permission-denied');
    expect(saver.text).toBe('<p>只读</p>\n');
    expect(await onDisk()).toBe(ORIGINAL);
    expect(previewRefreshes).toEqual([]);
  });

  it.skipIf(!isPosix || process.getuid?.() === 0)('read-only folder on the real file system (POSIX)', async () => {
    await chmod(root, 0o555);
    const { saver, previewRefreshes } = await pipeline();
    saver.edit('<p>只读文件夹</p>\n');
    expect(await saver.save()).toBe(false);
    expect(saver.state.error?.code).toBe('permission-denied');
    expect(await onDisk()).toBe(ORIGINAL);
    expect(previewRefreshes).toEqual([]);
  });

  it('after the cause is fixed, the next save writes the kept text and refreshes the preview once', async () => {
    await chmod(path.join(root, 'index.html'), 0o444);
    const { saver, previewRefreshes } = await pipeline();
    saver.edit('<p>终于保存</p>\n');
    expect(await saver.save()).toBe(false);
    await chmod(path.join(root, 'index.html'), 0o644);
    expect(await saver.save()).toBe(true);
    expect(await onDisk()).toBe('<p>终于保存</p>\n');
    expect(saveStatus(saver.state)).toBe('saved');
    expect(previewRefreshes).toEqual([1]);
  });
});

describe('"saved" is emitted strictly after a successful rename (S10.5)', () => {
  function delayedRenameFs(log: string[]) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fs: AtomicFs = {
      ...nodeAtomicFs,
      rename: async (a, b) => {
        log.push('rename started');
        await gate;
        await nodeAtomicFs.rename(a, b);
        log.push('rename done');
      },
    };
    return { fs, release };
  }

  it('main: ProjectService.onSaved fires after the rename resolved, never before', async () => {
    const log: string[] = [];
    const { fs, release } = delayedRenameFs(log);
    const { service, request } = await pipeline({ atomic: { fs } });
    service.onSaved((file) => log.push(`saved ${file.relPath}`));
    const writing = service.write(request('<p>v1</p>'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(['rename started']);
    release();
    expect((await writing).ok).toBe(true);
    expect(log).toEqual(['rename started', 'rename done', 'saved index.html']);
  });

  it('renderer: the preview refresh comes after the write result and the status update', async () => {
    const log: string[] = [];
    const { fs, release } = delayedRenameFs(log);
    const { saver, previewRefreshes } = await pipeline({ atomic: { fs } });
    saver.onSaved(() => log.push(`preview refresh (status ${saveStatus(saver.state)})`));
    saver.edit('<p>v1</p>');
    const saving = saver.save();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previewRefreshes).toEqual([]);
    release();
    expect(await saving).toBe(true);
    expect(log).toEqual(['rename started', 'rename done', 'preview refresh (status saved)']);
    expect(previewRefreshes).toEqual([1]);
  });

  it('a failed rename never emits "saved" on either side', async () => {
    const { service, saver, previewRefreshes } = await pipeline({
      atomic: { fs: failingFs('rename', 'EIO'), renameBackoffMs: [] },
    });
    const mainSaved: string[] = [];
    service.onSaved((file) => mainSaved.push(file.relPath));
    saver.edit('x');
    expect(await saver.save()).toBe(false);
    expect(mainSaved).toEqual([]);
    expect(previewRefreshes).toEqual([]);
  });
});

describe('writes to one file are serialized (review finding: concurrent saves)', () => {
  it('two overlapping writes run one after the other and the newer text ends on disk', async () => {
    const events: string[] = [];
    let first = true;
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const fs: AtomicFs = {
      ...nodeAtomicFs,
      rename: async (a, b) => {
        const name = first ? 'A' : 'B';
        first = false;
        events.push(`${name} start`);
        if (name === 'A') await firstGate;
        await nodeAtomicFs.rename(a, b);
        events.push(`${name} end`);
      },
    };
    const { service, request } = await pipeline({ atomic: { fs } });
    const a = service.write(request('older'));
    const b = service.write(request('newer'));
    // Wait until A reached its rename (a fixed 20 ms was flaky on a loaded machine), then give B time to race.
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5000, interval: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['A start']); // B waits for A instead of racing it
    releaseFirst();
    expect((await a).ok && (await b).ok).toBe(true);
    expect(events).toEqual(['A start', 'A end', 'B start', 'B end']);
    expect(await onDisk()).toBe('newer');
  });
});

describe('save elsewhere (S10.3)', () => {
  it('writes a new file outside the project and leaves the project file alone', async () => {
    const { service, request } = await pipeline();
    const destination = path.join(tmp, '备份', '副本 一.html');
    await mkdir(path.dirname(destination));
    const result = await service.writeCopy(destination, request('<p>副本</p>'));
    expect(result).toEqual({ ok: true, value: { path: destination } });
    expect(await readFile(destination, 'utf8')).toBe('<p>副本</p>');
    expect(await onDisk()).toBe(ORIGINAL);
  });

  it('reports why a copy failed and refuses unknown projects', async () => {
    const { service, request, projectId } = await pipeline();
    const missingDir = path.join(tmp, 'missing', 'x.html');
    const failed = await service.writeCopy(missingDir, request('x'));
    expect(failed).toMatchObject({ ok: false, code: 'not-found' });
    const unknown = await service.writeCopy(path.join(tmp, 'y.html'), {
      ...request('x'),
      projectId: projectId.replace(/^./, projectId[0] === '0' ? '1' : '0'),
    });
    expect(unknown).toMatchObject({ ok: false, code: 'unknown-project' });
  });
});
