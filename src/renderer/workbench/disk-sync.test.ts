import { describe, expect, it, vi } from 'vitest';
import type { FileContent, FileVersion } from '../../shared/ipc/contract';
import { changedRegion } from '../editor/changed-region';
import { DiskSync, pathsToCheck, type DiskRead } from './disk-sync';
import { documentReducer, INITIAL_DOCUMENT_STATE } from './document-state';
import { DocumentSaver, type Timers, type WriteOptions, type WriteOutcome } from './save-controller';
import { saveStatus } from './save-machine';

/**
 * S11.1–S11.3 renderer logic: what a watcher event means for an open file is decided by re-reading it and comparing
 * content hashes with the version the buffer is based on — never by timing. Own saves (whose version the save
 * reported) are not external changes; clean buffers reload; dirty buffers conflict; vanished files are kept.
 */
const version = (hash: string, size = 10, mtimeMs = 1): FileVersion => ({ mtimeMs, size, hash: hash.repeat(64) });
const content = (text: string, v: FileVersion): FileContent => ({
  text,
  eol: '\n',
  bom: false,
  mixedEol: false,
  uri: 'file:///p/index.html',
  version: v,
});

const noTimers: Timers = { set: () => 0, clear: () => undefined };

function harness(options: { initial?: string } = {}) {
  let known: FileVersion | undefined = version('a');
  const writes: { text: string; options: WriteOptions; resolve(o: WriteOutcome): void }[] = [];
  const saver = new DocumentSaver({
    initialText: options.initial ?? 'disk A',
    timers: noTimers,
    write: (text, writeOptions) => new Promise((resolve) => writes.push({ text, options: writeOptions, resolve })),
  });
  let disk: DiskRead = { ok: true, content: content('disk A', version('a')) };
  const reloads: FileContent[] = [];
  const conflicts: FileContent[] = [];
  const deletions: string[] = [];
  const read = vi.fn(async () => disk);
  const sync = new DiskSync({
    tab: (relPath) => (relPath === 'index.html' ? { saver, known: () => known } : undefined),
    read,
    reload: (_relPath, c) => {
      reloads.push(c);
      saver.reload(c.text);
      known = c.version;
    },
    conflict: (_relPath, c) => {
      conflicts.push(c);
      saver.externalChange();
    },
    deleted: () => {
      deletions.push('index.html');
      saver.markDeleted();
    },
  });
  return {
    saver,
    sync,
    read,
    writes,
    reloads,
    conflicts,
    deletions,
    setDisk(next: DiskRead) {
      disk = next;
    },
    setKnown(v: FileVersion) {
      known = v;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('which open files a watcher batch concerns (S11.1)', () => {
  const open = ['index.html', 'css/style.css', 'css/print.css', 'js/app.js'];
  it('changed / created / deleted name the file or every open file below a folder', () => {
    expect(pathsToCheck([{ type: 'changed', relPath: 'index.html' }], open)).toEqual(['index.html']);
    expect(pathsToCheck([{ type: 'deleted', relPath: 'css' }], open).sort()).toEqual([
      'css/print.css',
      'css/style.css',
    ]);
    expect(pathsToCheck([{ type: 'created', relPath: 'other.html' }], open)).toEqual([]);
  });
  it('renames concern both names; rescan concerns every open file', () => {
    expect(pathsToCheck([{ type: 'renamed', from: 'js/app.js', to: 'js/main.js', caseOnly: false }], open)).toEqual([
      'js/app.js',
    ]);
    expect(pathsToCheck([{ type: 'rescan' }], open)).toEqual(open);
  });
});

describe('disk check of one open file (S11.1)', () => {
  it('same hash → nothing happens (our own atomic save, a touch with a new mtime)', async () => {
    const h = harness();
    h.setDisk({ ok: true, content: content('disk A', version('a', 10, 999)) });
    await h.sync.check('index.html');
    expect(h.reloads).toEqual([]);
    expect(h.conflicts).toEqual([]);
    expect(saveStatus(h.saver.state)).toBe('clean');
  });

  it('a clean buffer reloads the new disk text', async () => {
    const h = harness();
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    expect(h.reloads.map((c) => c.text)).toEqual(['disk B']);
    expect(h.saver.text).toBe('disk B');
    expect(saveStatus(h.saver.state)).toBe('clean');
  });

  it('unsaved edits + changed disk → conflict; autosave and saving stop, nothing is written', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    expect(h.conflicts.map((c) => c.text)).toEqual(['disk B']);
    expect(saveStatus(h.saver.state)).toBe('conflict');
    expect(await h.saver.save()).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.saver.text).toBe('mine');
  });

  it('waits for our own write in flight and uses the version it reported (no false conflict)', async () => {
    const h = harness();
    h.saver.edit('mine');
    const saving = h.saver.save();
    // The watcher fires while our write is still pending; the disk already holds our bytes.
    h.setDisk({ ok: true, content: content('mine', version('m')) });
    const checking = h.sync.check('index.html');
    await flush();
    expect(h.read).not.toHaveBeenCalled();
    h.setKnown(version('m')); // what the confirmed save reports
    h.writes[0]?.resolve({ ok: true });
    await saving;
    await checking;
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.conflicts).toEqual([]);
    expect(h.reloads).toEqual([]);
    expect(saveStatus(h.saver.state)).toBe('saved');
  });

  it('a refused write (changed-on-disk, the check before write) is a conflict, never a retry loop', async () => {
    const h = harness();
    h.saver.edit('mine');
    const saving = h.saver.save();
    h.writes[0]?.resolve({ ok: false, code: 'changed-on-disk', message: 'x' });
    expect(await saving).toBe(false);
    expect(saveStatus(h.saver.state)).toBe('conflict');
    h.saver.edit('mine 2');
    await flush();
    expect(h.writes).toHaveLength(1); // only the refused write; no automatic retry over the other version
  });

  it('checks of one file are serialized', async () => {
    const h = harness();
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await Promise.all([h.sync.check('index.html'), h.sync.check('index.html')]);
    expect(h.reloads).toHaveLength(1); // the second check sees the reloaded version as known
  });
});

describe('conflict choices (S11.2)', () => {
  it('a file deleted during keep mine becomes deleted even before the watcher reports it', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.saver.externalChange();
    const keeping = h.saver.keepMine();
    await flush();
    h.writes[0]?.resolve({ ok: false, code: 'not-found', message: 'ENOENT' });
    expect(await keeping).toBe(false);
    expect(saveStatus(h.saver.state)).toBe('deleted');
    expect(h.saver.text).toBe('mine');
    expect(await h.saver.save()).toBe(false);
    expect(h.writes).toHaveLength(1);
  });

  it('another change during keep mine returns to a conflict without retrying over it', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    const keeping = h.saver.keepMine();
    await flush();
    h.writes[0]?.resolve({ ok: false, code: 'changed-on-disk', message: 'changed again' });
    expect(await keeping).toBe(false);
    h.setDisk({ ok: true, content: content('disk C', version('c')) });
    await h.sync.check('index.html');
    expect(saveStatus(h.saver.state)).toBe('conflict');
    expect(h.conflicts.at(-1)?.text).toBe('disk C');
    expect(h.saver.text).toBe('mine');
    expect(h.writes).toHaveLength(1);
  });

  it('deletion ends an obsolete conflict and allows an explicit re-create with the retained edits', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    expect(saveStatus(h.saver.state)).toBe('deleted');
    expect(h.saver.state.conflict).toBe(false);
    expect(h.saver.text).toBe('mine');
    expect(await h.saver.keepMine()).toBe(false);
    expect(h.writes).toHaveLength(0);
    const resaving = h.saver.recreate();
    await flush();
    expect(h.writes[0]).toMatchObject({ text: 'mine', options: { create: true } });
    h.writes[0]?.resolve({ ok: true });
    expect(await resaving).toBe(true);
  });

  it('a different file reappearing after conflict deletion requires a fresh choice', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    h.setDisk({ ok: true, content: content('disk C', version('c')) });
    await h.sync.check('index.html');
    expect(saveStatus(h.saver.state)).toBe('conflict');
    expect(h.conflicts.at(-1)?.text).toBe('disk C');
    expect(h.saver.text).toBe('mine');
    expect(h.writes).toHaveLength(0);
  });

  it('keep mine writes the buffer (only after the user chose it)', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    expect(h.writes).toHaveLength(0);
    const keeping = h.saver.keepMine();
    await flush();
    expect(h.writes.map((w) => w.text)).toEqual(['mine']);
    h.writes[0]?.resolve({ ok: true });
    expect(await keeping).toBe(true);
    expect(saveStatus(h.saver.state)).toBe('saved');
  });

  it('take disk replaces the buffer and leaves nothing to save', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: true, content: content('disk B', version('b')) });
    await h.sync.check('index.html');
    h.saver.reload('disk B');
    expect(saveStatus(h.saver.state)).toBe('clean');
    expect(h.saver.text).toBe('disk B');
    expect(await h.saver.save()).toBe(true);
    expect(h.writes).toHaveLength(0);
  });
});

describe('externally deleted open file (S11.3)', () => {
  it.each(['permission-denied', 'disk-full', 'busy'])(
    'a failed re-create (%s) stays deleted and can be retried explicitly',
    async (code) => {
      const h = harness();
      h.saver.edit('kept edits');
      h.saver.markDeleted();
      const first = h.saver.recreate();
      await flush();
      h.writes[0]?.resolve({ ok: false, code, message: code });
      expect(await first).toBe(false);
      expect(saveStatus(h.saver.state)).toBe('deleted');
      expect(h.saver.state.error?.code).toBe(code);
      expect(h.saver.text).toBe('kept edits');
      h.saver.blur();
      expect(await h.saver.save()).toBe(false);
      expect(h.writes).toHaveLength(1);
      const retry = h.saver.recreate();
      await flush();
      expect(h.writes[1]).toMatchObject({ text: 'kept edits', options: { create: true } });
      h.writes[1]?.resolve({ ok: true });
      expect(await retry).toBe(true);
      expect(saveStatus(h.saver.state)).toBe('saved');
    },
  );

  it('marks the tab deleted, keeps the text and stops autosave', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    expect(h.deletions).toEqual(['index.html']);
    expect(saveStatus(h.saver.state)).toBe('deleted');
    expect(h.saver.text).toBe('mine');
    expect(await h.saver.save()).toBe(false); // never "saved" by doing nothing
    expect(h.writes).toHaveLength(0);
  });

  it('a clean deleted tab is kept too (closing needs the user)', async () => {
    const h = harness();
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    expect(saveStatus(h.saver.state)).toBe('deleted');
    expect(await h.saver.save()).toBe(false);
  });

  it('re-save writes the buffer with create, so main never overwrites a new file', async () => {
    const h = harness();
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    const resaving = h.saver.recreate();
    await flush();
    expect(h.writes.map((w) => [w.text, w.options.create])).toEqual([['disk A', true]]);
    h.writes[0]?.resolve({ ok: true });
    expect(await resaving).toBe(true);
    expect(saveStatus(h.saver.state)).toBe('saved');
    // The next ordinary save is not a create again.
    h.saver.edit('more');
    void h.saver.save();
    await flush();
    expect(h.writes[1]?.options.create).toBe(false);
  });

  it('re-save over a file that appeared meanwhile becomes a conflict', async () => {
    const h = harness();
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    const resaving = h.saver.recreate();
    await flush();
    h.writes[0]?.resolve({ ok: false, code: 'changed-on-disk', message: 'exists' });
    expect(await resaving).toBe(false);
    expect(saveStatus(h.saver.state)).toBe('conflict');
  });

  it('a file that comes back unchanged simply stops being deleted', async () => {
    const h = harness();
    h.setDisk({ ok: false, code: 'not-found' });
    await h.sync.check('index.html');
    h.setDisk({ ok: true, content: content('disk A', version('a')) });
    await h.sync.check('index.html');
    expect(saveStatus(h.saver.state)).toBe('clean');
    expect(h.reloads).toEqual([]);
  });
});

describe('tab state for external changes (S11)', () => {
  const project = { projectId: 'p', name: 'p', rootPath: '/p', files: [], truncated: false };
  const loaded = documentReducer(documentReducer(INITIAL_DOCUMENT_STATE, { type: 'projectOpened', project }), {
    type: 'docLoaded',
    relPath: 'index.html',
    content: content('disk A', version('a')),
  });
  it('a reload replaces the tab content and shows a notice until dismissed', () => {
    const s = documentReducer(loaded, {
      type: 'diskReloaded',
      relPath: 'index.html',
      content: content('disk B', version('b')),
      notice: true,
    });
    expect(s.tabs[0]?.content.text).toBe('disk B');
    expect(s.tabs[0]?.diskNotice).toBe('reloaded');
    expect(documentReducer(s, { type: 'diskNoticeDismissed', relPath: 'index.html' }).tabs[0]?.diskNotice).toBe(
      undefined,
    );
  });
  it('a conflict keeps the disk version for the comparison until resolved', () => {
    const s = documentReducer(loaded, {
      type: 'diskConflict',
      relPath: 'index.html',
      content: content('B', version('b')),
    });
    expect(s.tabs[0]?.conflictDisk?.text).toBe('B');
    expect(documentReducer(s, { type: 'conflictCleared', relPath: 'index.html' }).tabs[0]?.conflictDisk).toBe(
      undefined,
    );
  });
  it('deletion discards the obsolete comparison and reload notice', () => {
    const conflicted = documentReducer(loaded, {
      type: 'diskConflict',
      relPath: 'index.html',
      content: content('B', version('b')),
    });
    const saver = new DocumentSaver({ initialText: 'mine', timers: noTimers, write: async () => ({ ok: true }) });
    saver.markDeleted();
    const deleted = documentReducer(conflicted, { type: 'saveState', relPath: 'index.html', save: saver.state });
    expect(deleted.tabs[0]?.conflictDisk).toBeUndefined();
    expect(deleted.tabs[0]?.diskNotice).toBeUndefined();
  });
});

describe('reload keeps the cursor: only the changed region is replaced (S11.1)', () => {
  it('finds the common prefix and suffix', () => {
    expect(changedRegion('a\nb\nc\n', 'a\nX\nc\n')).toEqual({ start: 2, endCurrent: 3, endNext: 3 });
    expect(changedRegion('same', 'same')).toEqual({ start: 4, endCurrent: 4, endNext: 4 });
  });
  it('never splits CRLF or a surrogate pair', () => {
    const r = changedRegion('a\r\nb', 'a\r\r\nb');
    expect(r.start).toBeLessThanOrEqual(1);
    const emoji = changedRegion('x😀y', 'x😁y');
    expect(emoji.start).toBe(1);
  });
});
