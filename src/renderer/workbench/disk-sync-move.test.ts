import { describe, expect, it, vi } from 'vitest';
import type { FileContent, FileVersion } from '../../shared/ipc/contract';
import { DiskSync, planWatchEvents, type DiskRead } from './disk-sync';
import { DocumentSaver, type Timers } from './save-controller';
import { isUnsaved } from './save-machine';

/**
 * S52.1 watcher replay: a rename or move made outside NoobIDE (Explorer, Finder, another editor) is replayed as a
 * move for the open tab when the file at the new path has the content the buffer is based on; otherwise it is a
 * delete + create, and the tab is kept with its text and marked deleted (S11.3). Paths with Chinese and spaces.
 */
const version = (hash: string, size = 10): FileVersion => ({ mtimeMs: 1, size, hash: hash.repeat(64) });
const content = (relPath: string, text: string, v: FileVersion): FileContent => ({
  text,
  eol: '\n',
  bom: false,
  mixedEol: false,
  uri: `file:///p/${encodeURIComponent(relPath)}`,
  version: v,
});
const noTimers: Timers = { set: () => 0, clear: () => undefined };

const OLD = '子 文件夹/页面 二.html';
const NEW = '新 文件夹/页面 二.html';

function harness() {
  const saver = new DocumentSaver({
    initialText: 'disk A',
    timers: noTimers,
    write: async () => ({ ok: true }),
  });
  const disk = new Map<string, DiskRead>([[NEW, { ok: true, content: content(NEW, 'disk A', version('a')) }]]);
  const moves: { from: string; to: string; content: FileContent }[] = [];
  const deletions: string[] = [];
  const conflicts: string[] = [];
  const sync = new DiskSync({
    tab: (relPath) => (relPath === OLD ? { saver, known: () => version('a') } : undefined),
    read: vi.fn(async (relPath: string) => disk.get(relPath) ?? { ok: false as const, code: 'not-found' }),
    reload: () => undefined,
    conflict: (relPath) => conflicts.push(relPath),
    deleted: (relPath) => {
      deletions.push(relPath);
      saver.markDeleted();
    },
    moved: (from, to, c) => moves.push({ from, to, content: c }),
  });
  return { saver, disk, sync, moves, deletions, conflicts };
}

describe('watcher batches with renames and moves (S52.1)', () => {
  const open = ['index.html', '子 文件夹/页面 二.html', '子 文件夹/深 一层/脚本.js', 'css/style.css'];

  it('a moved open file is replayed as a move and not checked as deleted', () => {
    const plan = planWatchEvents([{ type: 'renamed', from: OLD, to: NEW, caseOnly: false }], open);
    expect(plan.moves).toEqual([{ from: OLD, to: NEW }]);
    expect(plan.check).toEqual([]);
  });

  it('a moved folder moves every open file below it; other events are checked as before', () => {
    const plan = planWatchEvents(
      [
        { type: 'renamed', from: '子 文件夹', to: '素材/子 文件夹', caseOnly: false },
        { type: 'changed', relPath: 'css/style.css' },
      ],
      open,
    );
    expect(plan.moves).toEqual([
      { from: '子 文件夹/页面 二.html', to: '素材/子 文件夹/页面 二.html' },
      { from: '子 文件夹/深 一层/脚本.js', to: '素材/子 文件夹/深 一层/脚本.js' },
    ]);
    expect(plan.check).toEqual(['css/style.css']);
  });

  it('a case-only rename is a move too; a rescan still checks every file that does not move', () => {
    const plan = planWatchEvents(
      [{ type: 'renamed', from: 'index.html', to: 'Index.html', caseOnly: true }, { type: 'rescan' }],
      open,
    );
    expect(plan.moves).toEqual([{ from: 'index.html', to: 'Index.html' }]);
    expect(plan.check).toEqual(open.filter((p) => p !== 'index.html'));
  });
});

describe('replaying a move for an open tab (S52.1)', () => {
  it('same content at the new path → the tab follows', async () => {
    const h = harness();
    await h.sync.replayMove(OLD, NEW);
    expect(h.moves.map(({ from, to }) => ({ from, to }))).toEqual([{ from: OLD, to: NEW }]);
    expect(h.moves[0]?.content.uri).toContain(encodeURIComponent(NEW));
    expect(h.deletions).toEqual([]);
  });

  it('a tab with unsaved edits follows too when the base content matches (its edits move with it)', async () => {
    const h = harness();
    h.saver.edit('mine, not saved');
    await h.sync.replayMove(OLD, NEW);
    expect(h.moves).toHaveLength(1);
    expect(isUnsaved(h.saver.state)).toBe(true); // the workbench carries the text to the new tab
  });

  it('different content at the new path → delete + create: the tab is kept and marked deleted', async () => {
    const h = harness();
    h.disk.set(NEW, { ok: true, content: content(NEW, 'something else', version('b')) });
    await h.sync.replayMove(OLD, NEW);
    expect(h.moves).toEqual([]);
    expect(h.deletions).toEqual([OLD]);
    expect(h.saver.state.deleted).toBe(true);
  });

  it('the new path cannot be read → the tab is kept and marked deleted, its text stays', async () => {
    const h = harness();
    h.saver.edit('mine');
    h.disk.delete(NEW);
    await h.sync.replayMove(OLD, NEW);
    expect(h.moves).toEqual([]);
    expect(h.deletions).toEqual([OLD]);
    expect(h.saver.text).toBe('mine');
  });

  it('the old file is still there (the event was wrong) → nothing moves and nothing is marked', async () => {
    const h = harness();
    h.disk.set(NEW, { ok: true, content: content(NEW, 'other', version('c')) });
    h.disk.set(OLD, { ok: true, content: content(OLD, 'disk A', version('a')) });
    await h.sync.replayMove(OLD, NEW);
    expect(h.moves).toEqual([]);
    expect(h.deletions).toEqual([]);
    expect(h.conflicts).toEqual([]);
  });
});
