import { describe, expect, it } from 'vitest';
import type { FileContent, IpcResult } from '../../shared/ipc/contract';
import type { JournalRecordRequest, JournalSavedRequest } from '../../shared/ipc/recovery-contract';
import { JournalScheduler, type JournalBuffer, type Timers as JournalTimers } from '../recovery/journal-scheduler';
import { DocumentSaver, type Timers } from './save-controller';
import { isUnsaved } from './save-machine';
import { moveTab, type TabMoveDeps } from './tab-move';

/**
 * S52.1: a dirty file that is moved keeps its unsaved edits — the tab follows with the real DocumentSaver and the
 * real JournalScheduler: the new saver is dirty with the text, autosave writes to the new path only, and the crash
 * copy continues the same buffer record at the new path with a higher revision. Paths with Chinese and spaces.
 */
const PROJECT = '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f';
const FROM = '子 文件夹/页面 二.html';
const TO = '图片 素材/子 文件夹/页面 二.html';
const BUFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const disk = (relPath: string, text: string): FileContent => ({
  text,
  eol: '\n',
  bom: false,
  mixedEol: false,
  uri: `file:///p/${encodeURIComponent(relPath)}`,
  version: { mtimeMs: 1, size: text.length, hash: 'a'.repeat(64) },
});
const noTimers: Timers = { set: () => 0, clear: () => undefined };
const journalTimers: JournalTimers = { setTimeout: () => 0, clearTimeout: () => undefined, now: () => 0 };

function workbench(options: { recordFails?: boolean; readable?: boolean } = {}) {
  const writes: { relPath: string; text: string }[] = [];
  const records: JournalRecordRequest[] = [];
  const discards: { from: string; buffer: JournalBuffer; revision: number }[] = [];
  const sink = {
    record: async (request: JournalRecordRequest): Promise<IpcResult<{ written: boolean }, string>> => {
      if (options.recordFails) return { ok: false, code: 'write-failed', message: 'locked' };
      records.push(request);
      return { ok: true, value: { written: true } };
    },
    discardSaved: async (_r: JournalSavedRequest) => ({ ok: true as const, value: { removed: true } }),
  };
  const savers = new Map<string, DocumentSaver>();
  const journals = new Map<string, JournalScheduler>();
  const uris = new Map<string, string>();
  const checked: string[] = [];
  const released: string[] = [];
  const shown: { from: string; to: string; content: FileContent }[] = [];
  const open = (relPath: string, initial: string, baseRevision = 0) => {
    const saver = new DocumentSaver({
      initialText: initial,
      timers: noTimers,
      write: async (text) => {
        writes.push({ relPath, text });
        return { ok: true };
      },
    });
    const journal = new JournalScheduler(sink, journalTimers);
    journal.begin({ projectId: PROJECT, relPath, bufferId: BUFFER, bom: false, baseRevision });
    savers.set(relPath, saver);
    journals.set(relPath, journal);
    uris.set(relPath, disk(relPath, '').uri);
    return { saver, journal };
  };
  const deps: TabMoveDeps = {
    saverOf: (relPath) => savers.get(relPath),
    journalOf: (relPath) => journals.get(relPath),
    uriOf: (relPath) => uris.get(relPath),
    read: async (relPath) => (options.readable === false ? null : disk(relPath, '<p>二</p>\n')),
    forget: (relPath) => {
      savers.get(relPath)?.dispose();
      savers.delete(relPath);
      journals.get(relPath)?.begin(null);
      journals.delete(relPath);
      uris.delete(relPath);
    },
    create: (relPath, content, journal) => {
      const created = open(relPath, content.text, journal?.baseRevision ?? 0);
      return created;
    },
    moved: (from, to, content) => shown.push({ from, to, content }),
    releaseModel: (uri) => released.push(uri),
    check: (relPath) => checked.push(relPath),
    discardOld: async (from, buffer, revision) => void discards.push({ from, buffer, revision }),
    stillCurrent: () => true,
  };
  return { deps, open, savers, journals, writes, records, discards, checked, released, shown };
}

describe('a moved tab keeps its unsaved edits (S52.1)', () => {
  it('the new tab is dirty with the text, and saving writes to the new path only', async () => {
    const w = workbench();
    const { saver } = w.open(FROM, '<p>二</p>\n');
    saver.edit('<p>二，没保存</p>\n');
    expect(await moveTab(w.deps, FROM, TO)).toBe('moved');
    const next = w.savers.get(TO);
    expect(next?.text).toBe('<p>二，没保存</p>\n');
    expect(next && isUnsaved(next.state)).toBe(true);
    expect(w.shown).toEqual([
      { from: FROM, to: TO, content: expect.objectContaining({ text: '<p>二，没保存</p>\n' }) },
    ]);
    expect(w.savers.has(FROM)).toBe(false);
    expect(w.released).toEqual([disk(FROM, '').uri]);
    expect(await next?.save()).toBe(true);
    expect(w.writes).toEqual([{ relPath: TO, text: '<p>二，没保存</p>\n' }]);
  });

  it('the crash copy continues the same buffer record at the new path, with a higher revision', async () => {
    const w = workbench();
    const { saver, journal } = w.open(FROM, '<p>二</p>\n');
    saver.edit('a');
    journal.edited(saver.state.revision, () => saver.text);
    await journal.flush();
    saver.edit('ab');
    expect(w.records.at(-1)).toMatchObject({ relPath: FROM, bufferId: BUFFER, revision: 1 });
    await moveTab(w.deps, FROM, TO);
    await w.journals.get(TO)?.flush();
    expect(w.records.at(-1)).toMatchObject({ relPath: TO, bufferId: BUFFER, text: 'ab' });
    expect(w.records.at(-1)?.revision).toBeGreaterThan(2);
    expect(w.discards).toEqual([]); // a NoobIDE move: main already moved the old record
  });

  it('a clean tab follows without becoming dirty', async () => {
    const w = workbench();
    w.open(FROM, '<p>二</p>\n');
    await moveTab(w.deps, FROM, TO);
    const next = w.savers.get(TO);
    expect(next && isUnsaved(next.state)).toBe(false);
    expect(w.records).toEqual([]);
  });

  it('after a move outside NoobIDE the old crash copy is removed once the new one is written', async () => {
    const w = workbench();
    const { saver } = w.open(FROM, '<p>二</p>\n');
    saver.edit('mine');
    await moveTab(w.deps, FROM, TO, { content: disk(TO, '<p>二</p>\n'), external: true });
    expect(w.records.at(-1)).toMatchObject({ relPath: TO, text: 'mine' });
    expect(w.discards).toEqual([{ from: FROM, buffer: expect.objectContaining({ bufferId: BUFFER }), revision: 1 }]);
  });

  it('if the new crash copy cannot be written, the old one is kept', async () => {
    const w = workbench({ recordFails: true });
    const { saver } = w.open(FROM, '<p>二</p>\n');
    saver.edit('mine');
    await moveTab(w.deps, FROM, TO, { content: disk(TO, '<p>二</p>\n'), external: true });
    expect(w.discards).toEqual([]);
    expect(w.savers.get(TO)?.text).toBe('mine');
  });

  it('an unreadable new path re-keys nothing: the old tab is checked and keeps its text', async () => {
    const w = workbench({ readable: false });
    const { saver } = w.open(FROM, '<p>二</p>\n');
    saver.edit('mine');
    expect(await moveTab(w.deps, FROM, TO)).toBe('unreadable');
    expect(w.savers.get(FROM)?.text).toBe('mine');
    expect(w.checked).toEqual([FROM]);
  });

  it('a tab already open at the new path is never replaced; the old tab is checked', async () => {
    const w = workbench();
    w.open(FROM, 'x');
    w.open(TO, 'other');
    expect(await moveTab(w.deps, FROM, TO)).toBe('superseded');
    expect(w.savers.get(TO)?.text).toBe('other');
    expect(w.checked).toEqual([FROM]);
  });
});
