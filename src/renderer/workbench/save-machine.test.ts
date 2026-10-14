import { describe, expect, it } from 'vitest';
import {
  INITIAL_SAVE,
  SAVE_STATUSES,
  canSave,
  isUnsaved,
  saveReducer,
  saveStatus,
  type SaveEvent,
  type SaveSnapshot,
} from './save-machine';

const run = (...events: SaveEvent[]) => events.reduce(saveReducer, INITIAL_SAVE);
const edited: SaveEvent = { type: 'edited' };
const started: SaveEvent = { type: 'saveStarted' };
const succeeded = (revision: number): SaveEvent => ({ type: 'saveSucceeded', revision });
const failed: SaveEvent = { type: 'saveFailed', error: { code: 'permission-denied', message: 'EACCES' } };

describe('save state machine (S10.2)', () => {
  it('has the six states clean/dirty/saving/saved/failed/conflict', () => {
    const reached = new Set([
      saveStatus(run()),
      saveStatus(run(edited)),
      saveStatus(run(edited, started)),
      saveStatus(run(edited, started, succeeded(1))),
      saveStatus(run(edited, started, failed)),
      saveStatus(run(edited, { type: 'externalChange' })),
    ]);
    expect([...reached].sort()).toEqual([...SAVE_STATUSES].sort());
  });

  it('a freshly opened file is clean; an edit makes it dirty', () => {
    expect(saveStatus(INITIAL_SAVE)).toBe('clean');
    expect(saveStatus(run(edited))).toBe('dirty');
    expect(canSave(INITIAL_SAVE)).toBe(false);
    expect(canSave(run(edited))).toBe(true);
  });

  it('a confirmed write of the newest revision is saved', () => {
    const s = run(edited, edited, started);
    expect(s.savingRevision).toBe(2);
    expect(saveStatus(s)).toBe('saving');
    expect(saveStatus(saveReducer(s, succeeded(2)))).toBe('saved');
  });

  it('typing during a save leaves the file dirty after the write is confirmed', () => {
    const s = run(edited, started, edited, succeeded(1));
    expect(saveStatus(s)).toBe('dirty');
    expect(isUnsaved(s)).toBe(true);
  });

  it('the saved revision never goes backwards when an older confirmation arrives late', () => {
    const s = run(edited, started, succeeded(1), edited, started, succeeded(2), succeeded(1));
    expect(s.savedRevision).toBe(2);
    expect(saveStatus(s)).toBe('saved');
  });

  it('a failed write is reported with its cause, keeps the file unsaved and clears on the next success', () => {
    const s = run(edited, started, failed);
    expect(saveStatus(s)).toBe('failed');
    expect(s.error).toEqual({ code: 'permission-denied', message: 'EACCES' });
    expect(isUnsaved(s)).toBe(true);
    // More typing keeps the failure visible until a write succeeds.
    expect(saveStatus(saveReducer(s, edited))).toBe('failed');
    const retried = run(edited, started, failed, edited, started, succeeded(2));
    expect(saveStatus(retried)).toBe('saved');
    expect(retried.error).toBeNull();
  });

  it('an external change under unsaved edits is a conflict that blocks writing until resolved', () => {
    const s = run(edited, { type: 'externalChange' });
    expect(saveStatus(s)).toBe('conflict');
    expect(canSave(s)).toBe(false);
    expect(saveStatus(saveReducer(s, { type: 'conflictResolved' }))).toBe('dirty');
  });

  it('an external change of a clean file is not a conflict', () => {
    expect(saveStatus(run({ type: 'externalChange' }))).toBe('clean');
    expect(saveStatus(run(edited, started, succeeded(1), { type: 'externalChange' }))).toBe('saved');
  });

  it('is pure: events never mutate the previous snapshot', () => {
    const before: SaveSnapshot = run(edited);
    const copy = { ...before };
    saveReducer(before, started);
    saveReducer(before, failed);
    expect(before).toEqual(copy);
  });
});
