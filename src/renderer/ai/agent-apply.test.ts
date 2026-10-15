import { describe, expect, it } from 'vitest';
import type { AiFileChange } from '../../shared/ipc/ai-contract';
import { applyChange, failureForAgent, undoGroup, undoGroupById } from './agent-apply';
import { fakeAgentHost } from './agent-host.test-util';

/**
 * S34.2: accepted agent changes go through the workbench's paths only (open tab → editor model + saver; closed file →
 * writeFile with the hash of the version read; create/rename/trash → workspace APIs with the file-op hooks), never
 * over text the agent did not see; every applied change is recorded in the turn's local-history group, and the turn
 * undoes from that group.
 */
const GROUP = { id: 'req-0001-turn', label: 'Make the heading blue' };

describe('applyChange (S34.2)', () => {
  it('writes a closed file with the hash of the version it compared, keeping its BOM, and records the step', async () => {
    const { host, log, files } = fakeAgentHost({ 'a.css': { text: 'h1{color:red}', hash: 'h0', bom: true } });
    const result = await applyChange(
      host,
      { kind: 'edit', relPath: 'a.css', before: 'h1{color:red}', after: 'h1{color:blue}' },
      GROUP,
    );
    expect(result.ok).toBe(true);
    expect(log).toEqual(['keep a.css', 'write a.css expect=h0', 'record edit a.css']);
    expect(files['a.css']).toMatchObject({ text: 'h1{color:blue}', bom: true });
  });

  it('never overwrites a closed file that differs from what the agent read; nothing is recorded', async () => {
    const { host, log, files } = fakeAgentHost({ 'a.css': { text: 'user changed it', hash: 'h0' } });
    const result = await applyChange(
      host,
      { kind: 'edit', relPath: 'a.css', before: 'h1{color:red}', after: 'x' },
      GROUP,
    );
    expect(result).toEqual({ ok: false, failure: { code: 'changed-since' } });
    expect(log).toEqual([]);
    expect(files['a.css']?.text).toBe('user changed it');
  });

  it('a change on disk between the read and the write is refused by the hash check and not recorded', async () => {
    const env = fakeAgentHost({ 'a.css': { text: 'old', hash: 'h0' } });
    const read = env.host.workspace.readFile;
    env.host.workspace.readFile = async (request) => {
      const result = await read(request);
      env.files['a.css'] = { text: 'old', hash: 'h-other' }; // same text, another version (written meanwhile)
      return result;
    };
    const result = await applyChange(env.host, { kind: 'edit', relPath: 'a.css', before: 'old', after: 'new' }, GROUP);
    expect(result).toMatchObject({ ok: false, failure: { code: 'changed-since', detail: 'changed-on-disk' } });
    expect(env.log.some((line) => line.startsWith('record'))).toBe(false);
  });

  it('edits an open file only through its tab, and only if the buffer is still the agent’s text', async () => {
    const env = fakeAgentHost({ 'i.html': { text: 'a\nb', hash: 'h0' } }, { 'i.html': { text: 'a\r\nb' } });
    expect(
      await applyChange(env.host, { kind: 'edit', relPath: 'i.html', before: 'a\nb', after: 'a\nc' }, GROUP),
    ).toMatchObject({ ok: true });
    expect(env.log).toEqual(['keep i.html', 'tab i.html', 'record edit i.html']);
    // Unsaved edits the agent did not see: refused, the buffer is kept.
    const env2 = fakeAgentHost({}, { 'i.html': { text: 'user typing' } });
    expect(
      await applyChange(env2.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' }, GROUP),
    ).toMatchObject({ ok: false, failure: { code: 'changed-since' } });
    expect(env2.log).toEqual([]);
    const env3 = fakeAgentHost({}, { 'i.html': { text: 'a', blocked: true } });
    expect(
      await applyChange(env3.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' }, GROUP),
    ).toMatchObject({ ok: false });
    const env4 = fakeAgentHost({}, { 'i.html': { text: 'a', readOnly: true } });
    expect(
      await applyChange(env4.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' }, GROUP),
    ).toMatchObject({ ok: false, failure: { code: 'read-only' } });
  });

  it('saves an open tab’s unsaved edits first, so the version kept before the change is the text it replaces', async () => {
    const env = fakeAgentHost({ 'i.html': { text: 'disk', hash: 'h0' } }, { 'i.html': { text: 'typed', dirty: true } });
    expect(
      await applyChange(env.host, { kind: 'edit', relPath: 'i.html', before: 'typed', after: 'agent' }, GROUP),
    ).toMatchObject({ ok: true });
    expect(env.log).toEqual(['save i.html', 'keep i.html', 'tab i.html', 'record edit i.html']);
    expect([...env.versions.values()]).toEqual([{ relPath: 'i.html', text: 'typed' }]);
    // A failed save: nothing starts.
    const env2 = fakeAgentHost({ 'i.html': { text: 'disk', hash: 'h0' } }, { 'i.html': { text: 't', dirty: true } });
    env2.host.saveOpen = async () => false;
    expect(
      await applyChange(env2.host, { kind: 'edit', relPath: 'i.html', before: 't', after: 'x' }, GROUP),
    ).toMatchObject({ ok: false, failure: { code: 'save-first-failed' } });
    expect(env2.files['i.html']?.text).toBe('disk');
  });

  it('a failed tab save is not recorded (nothing reached the disk)', async () => {
    const env = fakeAgentHost({ 'i.html': { text: 'a', hash: 'h0' } }, { 'i.html': { text: 'a' } });
    env.host.replaceOpenText = async () => ({ code: 'save-failed' });
    expect(
      await applyChange(env.host, { kind: 'edit', relPath: 'i.html', before: 'a', after: 'b' }, GROUP),
    ).toMatchObject({ ok: false, failure: { code: 'save-failed' } });
    expect(env.groups.size).toBe(0);
  });

  it('creates missing folders, then the file exclusively, and opens it; an existing file is never replaced', async () => {
    const env = fakeAgentHost({});
    expect(
      await applyChange(env.host, { kind: 'create', relPath: '页面/关于 我.html', after: '<h1>About</h1>' }, GROUP),
    ).toMatchObject({ ok: true });
    expect(env.log).toEqual([
      'mkdir 页面',
      'write 页面/关于 我.html create',
      'open 页面/关于 我.html',
      'record create 页面/关于 我.html',
    ]);
    const again = await applyChange(env.host, { kind: 'create', relPath: '页面/关于 我.html', after: 'other' }, GROUP);
    expect(again).toMatchObject({ ok: false, failure: { code: 'exists' } });
    expect(env.files['页面/关于 我.html']?.text).toBe('<h1>About</h1>');
  });

  it('renames and trashes with the file-op hooks, like the Files panel; a deletion keeps the content first', async () => {
    const env = fakeAgentHost({ 'a.html': { text: 'a', hash: 'h' }, 'b.txt': { text: 'b', hash: 'h' } });
    expect(await applyChange(env.host, { kind: 'rename', relPath: 'a.html', to: 'about.html' }, GROUP)).toMatchObject({
      ok: true,
    });
    expect(await applyChange(env.host, { kind: 'delete', relPath: 'b.txt' }, GROUP)).toMatchObject({ ok: true });
    expect(env.log).toEqual([
      'before a.html',
      'rename a.html about.html',
      'after renamed',
      'record rename a.html',
      'before b.txt',
      'keep b.txt',
      'trash b.txt',
      'after deleted',
      'record delete b.txt',
    ]);
    const failed = await applyChange(env.host, { kind: 'delete', relPath: 'gone.txt' }, GROUP);
    expect(failed).toMatchObject({ ok: false, failure: { code: 'not-found' } });
    expect(env.log.slice(-1)).toEqual(['cancelled gone.txt']);
  });

  it('does not start a rename when the open file could not be saved first', async () => {
    const env = fakeAgentHost({ 'a.html': { text: 'a', hash: 'h' } });
    env.host.fileOps.beforeChange = async () => false;
    expect(await applyChange(env.host, { kind: 'rename', relPath: 'a.html', to: 'b.html' }, GROUP)).toMatchObject({
      ok: false,
      failure: { code: 'save-first-failed' },
    });
    expect(env.files['a.html']).toBeDefined();
  });
});

describe('undoGroup (S34.2)', () => {
  const turn: readonly AiFileChange[] = [
    { kind: 'edit', relPath: 'style.css', before: 'red', after: 'blue' },
    { kind: 'create', relPath: 'about.html', after: '<h1>About</h1>' },
    { kind: 'rename', relPath: 'old.html', to: 'new.html' },
    { kind: 'delete', relPath: 'notes.txt' },
  ];

  async function applied() {
    const env = fakeAgentHost({
      'style.css': { text: 'red', hash: 'h0' },
      'old.html': { text: 'o', hash: 'h0' },
      'notes.txt': { text: 'n', hash: 'h0' },
    });
    for (const change of turn) {
      const result = await applyChange(env.host, change, GROUP);
      if (!result.ok) throw new Error(result.failure.code);
    }
    env.log.length = 0;
    return env;
  }

  it('reverses a whole turn from its history group, newest first: deleted file back, rename back, created file to the trash, edit restored', async () => {
    const env = await applied();
    // Found by id in local history, as after a reload (no memory of the turn needed).
    const result = await undoGroupById(env.host, GROUP.id);
    expect(result).toEqual({ undone: 4, failures: [] });
    expect(Object.keys(env.files).sort()).toEqual(['notes.txt', 'old.html', 'style.css']);
    expect(env.files['style.css']?.text).toBe('red');
    expect(env.files['notes.txt']?.text).toBe('n');
    expect(env.log[0]).toBe('restore notes.txt');
    expect(env.log).toContain('rename new.html old.html');
    expect(env.log).toContain('trash about.html'); // a created file goes to the trash, never deleted for good
    expect(env.log).toContain('restore-version style.css'); // the History window's restore path
    expect(env.log.at(-1)).toBe(`undone ${GROUP.id}`);
    expect(env.trash['about.html']?.text).toBe('<h1>About</h1>');
  });

  it('skips and reports files changed after the turn, undoing the rest', async () => {
    const env = await applied();
    env.files['style.css'] = { text: 'blue, then the user edited', hash: 'h-user' };
    env.files['about.html'] = { text: 'user rewrote it', hash: 'h-user2' };
    env.files['notes.txt'] = { text: 'a new notes file', hash: 'h-new' };
    const result = await undoGroupById(env.host, GROUP.id);
    expect(result.undone).toBe(1); // only the rename
    expect(result.failures.map((f) => [f.step?.relPath, f.failure.code])).toEqual([
      ['notes.txt', 'exists'],
      ['about.html', 'changed-since'],
      ['style.css', 'changed-since'],
    ]);
    expect(env.files['style.css']?.text).toBe('blue, then the user edited');
    expect(env.files['about.html']?.text).toBe('user rewrote it');
    expect(env.files['notes.txt']?.text).toBe('a new notes file');
  });

  it('a partial undo leaves the turn open: once the user reverts their edit, undoing again finishes it', async () => {
    const env = await applied();
    const left = env.files['style.css'];
    env.files['style.css'] = { text: 'user edit', hash: 'h-user' };
    const first = await undoGroupById(env.host, GROUP.id);
    expect(first.undone).toBe(3);
    expect(env.log).not.toContain(`undone ${GROUP.id}`); // not marked: it can be tried again
    env.files['style.css'] = left as { text: string; hash: string }; // the user put back what the turn left
    const second = await undoGroupById(env.host, GROUP.id);
    expect(second.undone).toBe(1); // the rest: their files are no longer what the turn left, so they are skipped
    expect(env.files['style.css']?.text).toBe('red');
    expect(Object.keys(env.files).sort()).toEqual(['notes.txt', 'old.html', 'style.css']);
  });

  it('a created file edited while its tab’s edits are saved first is not trashed', async () => {
    const env = await applied();
    env.host.fileOps.beforeChange = async (relPath) => {
      env.log.push(`before ${relPath}`);
      if (relPath === 'about.html') env.files['about.html'] = { text: 'typed meanwhile', hash: 'h-typed' };
      return true;
    };
    const result = await undoGroupById(env.host, GROUP.id);
    expect(result.failures.map((f) => [f.step?.relPath, f.failure.code])).toEqual([['about.html', 'changed-since']]);
    expect(env.files['about.html']?.text).toBe('typed meanwhile');
    expect(env.log).toContain('cancelled about.html');
    expect(env.log).not.toContain('trash about.html');
  });

  it('an open created file is trashed although the undo’s own file-op lock makes its tab read-only', async () => {
    const env = await applied();
    const tabs: Record<string, { text: string; blocked: boolean }> = {
      'about.html': { text: '<h1>About</h1>', blocked: false },
    };
    env.host.openTab = (relPath) => {
      const tab = tabs[relPath];
      return tab ? { text: tab.text, readOnly: false, blocked: tab.blocked } : undefined;
    };
    env.host.fileOps.beforeChange = async (relPath) => {
      if (tabs[relPath]) tabs[relPath].blocked = true; // the workbench locks the tab during the operation
      return true;
    };
    expect(await undoGroupById(env.host, GROUP.id)).toEqual({ undone: 4, failures: [] });
    expect(env.trash['about.html']).toBeDefined();
  });

  it('records the step under the path main kept the version under (the file’s real case)', async () => {
    const env = fakeAgentHost({ 'Notes.txt': { text: 'n', hash: 'h0' } });
    const groupBefore = env.host.history.groupBefore;
    env.host.history.groupBefore = async (request) => {
      const kept = await groupBefore({ ...request, relPath: 'Notes.txt' });
      return kept;
    };
    env.host.workspace.trashEntry = async () => {
      delete env.files['Notes.txt'];
      return { ok: true, value: null };
    };
    await applyChange(env.host, { kind: 'delete', relPath: 'notes.txt' }, GROUP);
    expect(env.groups.get(GROUP.id)?.steps[0]).toMatchObject({ kind: 'delete', relPath: 'Notes.txt' });
    expect(await undoGroupById(env.host, GROUP.id)).toEqual({ undone: 1, failures: [] });
    expect(env.files['Notes.txt']?.text).toBe('n');
  });

  it('an open tab with edits since the turn is not touched', async () => {
    const env = fakeAgentHost({ 'style.css': { text: 'red', hash: 'h0' } }, { 'style.css': { text: 'red' } });
    await applyChange(env.host, turn[0] as AiFileChange, GROUP);
    const tab = { text: 'blue + typing', dirty: true };
    env.host.openTab = () => ({ text: tab.text, readOnly: false, dirty: true });
    const result = await undoGroupById(env.host, GROUP.id);
    expect(result.failures[0]?.failure.code).toBe('changed-since');
    expect(env.files['style.css']?.text).toBe('blue');
  });

  it('a turn missing from history, or a step without a kept version, is reported as no-history', async () => {
    const env = fakeAgentHost({});
    expect(await undoGroupById(env.host, 'not-a-turn-1')).toEqual({
      undone: 0,
      failures: [{ step: null, failure: { code: 'no-history' } }],
    });
    const result = await undoGroup(env.host, {
      id: 'req-x-12345',
      kind: 'ai-agent',
      label: '',
      createdAt: 1,
      undoneAt: null,
      files: ['a.css'],
      steps: [{ kind: 'edit', relPath: 'a.css', before: null, afterHash: 'h1' }],
    });
    expect(result.failures[0]?.failure.code).toBe('no-history');
    expect(env.log).not.toContain('undone req-x-12345');
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
