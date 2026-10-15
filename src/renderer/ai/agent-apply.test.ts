import { describe, expect, it } from 'vitest';
import { applyChange, failureForAgent, undoTurn, type AgentApplyHost, type UndoStep } from './agent-apply';
import type { FilesChange } from '../workbench/FilesPanel';

/**
 * S34.2: accepted agent changes go through the workbench's paths only (open tab → editor model + saver; closed file →
 * writeFile with the hash of the version read; create/rename/trash → workspace APIs with the file-op hooks), never
 * over text the agent did not see, and one turn undoes as a group.
 */
interface FakeFile {
  text: string;
  hash: string;
  bom?: boolean;
}

function fakeHost(
  files: Record<string, FakeFile>,
  open: Record<string, { text: string; readOnly?: boolean; blocked?: boolean }> = {},
) {
  const log: string[] = [];
  const trash: Record<string, FakeFile> = {};
  const folders = new Set<string>(['']);
  let hashes = 0;
  const host: AgentApplyHost = {
    projectId: 'p',
    workspace: {
      async readFile({ relPath }) {
        const f = files[relPath];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        return {
          ok: true,
          value: {
            text: f.text,
            eol: '\n',
            bom: f.bom ?? false,
            uri: `file:///${relPath}`,
            mixedEol: false,
            version: { mtimeMs: 1, size: 1, hash: f.hash },
          },
        };
      },
      async writeFile(request) {
        log.push(
          `write ${request.relPath}${request.create ? ' create' : ''}${request.expectedHash ? ` expect=${request.expectedHash}` : ''}`,
        );
        const f = files[request.relPath];
        if (request.create) {
          if (f) return { ok: false, code: 'changed-on-disk', message: '' };
        } else if (!f) return { ok: false, code: 'not-found', message: '' };
        else if (request.expectedHash && request.expectedHash !== f.hash)
          return { ok: false, code: 'changed-on-disk', message: '' };
        files[request.relPath] = { text: request.text, hash: `h${(hashes += 1)}`, bom: request.bom };
        return { ok: true, value: { savedAt: 1, version: { mtimeMs: 1, size: 1, hash: 'x' } } };
      },
      async createEntry({ relPath, kind }) {
        log.push(`mkdir ${relPath}`);
        if (kind === 'directory' && folders.has(relPath)) return { ok: false, code: 'exists', message: '' };
        folders.add(relPath);
        return { ok: true, value: { relPath } };
      },
      async renameEntry({ from, to }) {
        log.push(`rename ${from} ${to}`);
        const f = files[from];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        if (files[to]) return { ok: false, code: 'exists', message: '' };
        files[to] = f;
        delete files[from];
        return { ok: true, value: { from, to } };
      },
      async trashEntry({ relPath }) {
        log.push(`trash ${relPath}`);
        const f = files[relPath];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        trash[relPath] = f;
        delete files[relPath];
        return { ok: true, value: null };
      },
    },
    history: {
      async versions({ relPath }) {
        return trash[relPath]
          ? { ok: true, value: [{ id: '1-abcdefabcdef-1', createdAt: 1, reason: 'before-delete', size: 1 }] }
          : { ok: true, value: [] };
      },
      async restoreDeleted({ relPath }) {
        log.push(`restore ${relPath}`);
        const f = trash[relPath];
        if (!f) return { ok: false, code: 'not-found', message: '' };
        if (files[relPath]) return { ok: false, code: 'exists', message: '' };
        files[relPath] = f;
        return { ok: true, value: { relPath } };
      },
    },
    fileOps: {
      async beforeChange(relPath) {
        log.push(`before ${relPath}`);
        return true;
      },
      afterChange(change: FilesChange) {
        log.push(`after ${change.type}`);
      },
      cancelled(relPath) {
        log.push(`cancelled ${relPath}`);
      },
    },
    openTab: (relPath) => {
      const tab = open[relPath];
      return tab ? { text: tab.text, readOnly: tab.readOnly ?? false, blocked: tab.blocked ?? false } : undefined;
    },
    async replaceOpenText(relPath, _before, text) {
      log.push(`tab ${relPath}`);
      const tab = open[relPath];
      if (!tab) return { code: 'changed-since' };
      tab.text = text;
      return null;
    },
    openFile(relPath) {
      log.push(`open ${relPath}`);
    },
  };
  return { host, log, files, trash };
}

describe('applyChange (S34.2)', () => {
  it('writes a closed file with the hash of the version it compared, keeping its BOM', async () => {
    const { host, log, files } = fakeHost({ 'a.css': { text: 'h1{color:red}', hash: 'h0', bom: true } });
    const result = await applyChange(host, {
      kind: 'edit',
      relPath: 'a.css',
      before: 'h1{color:red}',
      after: 'h1{color:blue}',
    });
    expect(result.ok).toBe(true);
    expect(log).toEqual(['write a.css expect=h0']);
    expect(files['a.css']).toMatchObject({ text: 'h1{color:blue}', bom: true });
  });

  it('never overwrites a closed file that differs from what the agent read', async () => {
    const { host, log, files } = fakeHost({ 'a.css': { text: 'user changed it', hash: 'h0' } });
    const result = await applyChange(host, { kind: 'edit', relPath: 'a.css', before: 'h1{color:red}', after: 'x' });
    expect(result).toEqual({ ok: false, failure: { code: 'changed-since' } });
    expect(log).toEqual([]);
    expect(files['a.css']?.text).toBe('user changed it');
  });

  it('a change on disk between the read and the write is refused by the hash check', async () => {
    const env = fakeHost({ 'a.css': { text: 'old', hash: 'h0' } });
    const read = env.host.workspace.readFile;
    env.host.workspace.readFile = async (request) => {
      const result = await read(request);
      env.files['a.css'] = { text: 'old', hash: 'h-other' }; // same text, another version (written meanwhile)
      return result;
    };
    const result = await applyChange(env.host, { kind: 'edit', relPath: 'a.css', before: 'old', after: 'new' });
    expect(result).toMatchObject({ ok: false, failure: { code: 'changed-since', detail: 'changed-on-disk' } });
  });

  it('edits an open file only through its tab, and only if the buffer is still the agent’s text', async () => {
    const env = fakeHost({ 'i.html': { text: 'disk', hash: 'h0' } }, { 'i.html': { text: 'a\r\nb' } });
    expect(
      await applyChange(env.host, { kind: 'edit', relPath: 'i.html', before: 'a\nb', after: 'a\nc' }),
    ).toMatchObject({ ok: true });
    expect(env.log).toEqual(['tab i.html']);
    // Unsaved edits the agent did not see: refused, the buffer is kept.
    const env2 = fakeHost({}, { 'i.html': { text: 'user typing' } });
    expect(await applyChange(env2.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' })).toMatchObject({
      ok: false,
      failure: { code: 'changed-since' },
    });
    expect(env2.log).toEqual([]);
    const env3 = fakeHost({}, { 'i.html': { text: 'a', blocked: true } });
    expect(await applyChange(env3.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' })).toMatchObject({
      ok: false,
    });
    const env4 = fakeHost({}, { 'i.html': { text: 'a', readOnly: true } });
    expect(await applyChange(env4.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' })).toMatchObject({
      ok: false,
      failure: { code: 'read-only' },
    });
  });

  it('creates missing folders, then the file exclusively, and opens it; an existing file is never replaced', async () => {
    const env = fakeHost({});
    expect(
      await applyChange(env.host, { kind: 'create', relPath: '页面/关于 我.html', after: '<h1>About</h1>' }),
    ).toMatchObject({ ok: true });
    expect(env.log).toEqual(['mkdir 页面', 'write 页面/关于 我.html create', 'open 页面/关于 我.html']);
    const again = await applyChange(env.host, { kind: 'create', relPath: '页面/关于 我.html', after: 'other' });
    expect(again).toMatchObject({ ok: false, failure: { code: 'exists' } });
    expect(env.files['页面/关于 我.html']?.text).toBe('<h1>About</h1>');
  });

  it('renames and trashes with the file-op hooks, like the Files panel', async () => {
    const env = fakeHost({ 'a.html': { text: 'a', hash: 'h' }, 'b.txt': { text: 'b', hash: 'h' } });
    expect(await applyChange(env.host, { kind: 'rename', relPath: 'a.html', to: 'about.html' })).toMatchObject({
      ok: true,
    });
    expect(await applyChange(env.host, { kind: 'delete', relPath: 'b.txt' })).toMatchObject({ ok: true });
    expect(env.log).toEqual([
      'before a.html',
      'rename a.html about.html',
      'after renamed',
      'before b.txt',
      'trash b.txt',
      'after deleted',
    ]);
    const failed = await applyChange(env.host, { kind: 'delete', relPath: 'gone.txt' });
    expect(failed).toMatchObject({ ok: false, failure: { code: 'not-found' } });
    expect(env.log.slice(-1)).toEqual(['cancelled gone.txt']);
  });

  it('does not start a rename when the open file could not be saved first', async () => {
    const env = fakeHost({ 'a.html': { text: 'a', hash: 'h' } });
    env.host.fileOps.beforeChange = async () => false;
    expect(await applyChange(env.host, { kind: 'rename', relPath: 'a.html', to: 'b.html' })).toMatchObject({
      ok: false,
      failure: { code: 'save-first-failed' },
    });
    expect(env.files['a.html']).toBeDefined();
  });
});

describe('undoTurn (S34.2)', () => {
  it('reverses a whole turn newest first: edit back, created file to the trash, rename back, deleted file from history', async () => {
    const env = fakeHost({
      'style.css': { text: 'red', hash: 'h0' },
      'old.html': { text: 'o', hash: 'h0' },
      'notes.txt': { text: 'n', hash: 'h0' },
    });
    const steps: UndoStep[] = [];
    for (const change of [
      { kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' },
      { kind: 'create', relPath: 'about.html', after: '<h1>About</h1>' },
      { kind: 'rename', relPath: 'old.html', to: 'new.html' },
      { kind: 'delete', relPath: 'notes.txt' },
    ] as const) {
      const result = await applyChange(env.host, change);
      if (!result.ok) throw new Error(result.failure.code);
      steps.push(result.undo);
    }
    env.log.length = 0;
    const result = await undoTurn(env.host, steps);
    expect(result).toEqual({ undone: 4, failures: [] });
    expect(Object.keys(env.files).sort()).toEqual(['notes.txt', 'old.html', 'style.css']);
    expect(env.files['style.css']?.text).toBe('red');
    expect(env.log[0]).toBe('restore notes.txt');
    expect(env.log).toContain('trash about.html'); // created file goes to the trash, never deleted for good
  });

  it('skips a step whose file was changed after the agent turn and reports it', async () => {
    const env = fakeHost({ 'style.css': { text: 'red', hash: 'h0' } });
    const applied = await applyChange(env.host, { kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' });
    if (!applied.ok) throw new Error('apply');
    env.files['style.css'] = { text: 'blue, then the user edited', hash: 'h9' };
    const result = await undoTurn(env.host, [applied.undo]);
    expect(result.undone).toBe(0);
    expect(result.failures[0]?.failure.code).toBe('changed-since');
    expect(env.files['style.css']?.text).toBe('blue, then the user edited');
  });
});

describe('failureForAgent', () => {
  it('describes failures without file contents', () => {
    expect(failureForAgent({ code: 'changed-since' })).toContain('read it again');
    expect(failureForAgent({ code: 'write-failed', detail: 'permission-denied' })).toBe(
      'Writing failed. (permission-denied)',
    );
  });
});
