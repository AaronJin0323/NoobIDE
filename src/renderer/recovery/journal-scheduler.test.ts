import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JOURNAL_DEBOUNCE_MS,
  JOURNAL_MAX_WAIT_MS,
  JOURNAL_RETRY_MAX_MS,
  JOURNAL_RETRY_MS,
  JournalScheduler,
  type JournalBuffer,
  type JournalSink,
} from './journal-scheduler';

const BUFFER: JournalBuffer = {
  projectId: '3f1c2a9e-8b7d-4c6e-9f00-1a2b3c4d5e6f',
  relPath: '中文 路径/index.html',
  bufferId: '11111111-2222-4333-8444-555555555555',
  bom: false,
  baseRevision: 0,
};

let sink: { record: ReturnType<typeof vi.fn>; discardSaved: ReturnType<typeof vi.fn> };
let health: (string | null)[];
let scheduler: JournalScheduler;
let text: string;

beforeEach(() => {
  vi.useFakeTimers();
  sink = {
    record: vi.fn(async () => ({ ok: true, value: { written: true } })),
    discardSaved: vi.fn(async () => ({ ok: true, value: { removed: true } })),
  };
  health = [];
  scheduler = new JournalScheduler(
    sink as unknown as JournalSink,
    {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as never),
      now: () => Date.now(),
    },
    (h) => health.push(h),
  );
  scheduler.begin(BUFFER);
  text = '';
});

afterEach(() => {
  vi.useRealTimers();
});

const type = (revision: number) => {
  text = `text ${revision}`;
  scheduler.edited(revision, () => text);
};

describe('journal scheduling (S12.1)', () => {
  it('the limits guarantee a copy within 2 s', () => {
    expect(JOURNAL_DEBOUNCE_MS).toBeLessThanOrEqual(JOURNAL_MAX_WAIT_MS);
    expect(JOURNAL_MAX_WAIT_MS).toBeLessThan(2000);
  });

  it('sends one copy shortly after typing pauses', async () => {
    type(1);
    type(2);
    await vi.advanceTimersByTimeAsync(JOURNAL_DEBOUNCE_MS - 1);
    expect(sink.record).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(sink.record).toHaveBeenCalledWith({
      projectId: BUFFER.projectId,
      relPath: BUFFER.relPath,
      bufferId: BUFFER.bufferId,
      revision: 2,
      text: 'text 2',
      bom: false,
    });
  });

  it('copies carry the BOM the file has now, after another program added or removed it', async () => {
    scheduler.setBom(true);
    type(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_DEBOUNCE_MS);
    expect(sink.record).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1, bom: true }));
    scheduler.setBom(false);
    type(2);
    await vi.advanceTimersByTimeAsync(JOURNAL_DEBOUNCE_MS);
    expect(sink.record).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2, bom: false }));
    // A new buffer starts from its own BOM again.
    scheduler.begin({ ...BUFFER, bom: true });
    type(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_DEBOUNCE_MS);
    expect(sink.record).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1, bom: true }));
  });

  it('continuous typing still reaches the journal within 2 s of the first unsent edit', async () => {
    const start = Date.now();
    const sentAt: number[] = [];
    sink.record.mockImplementation(async (request: { revision: number; text: string }) => {
      sentAt.push(Date.now() - start);
      expect(request.text).toBe(`text ${request.revision}`); // always the newest text
      return { ok: true, value: { written: true } };
    });
    let revision = 0;
    for (let t = 0; t < 6000; t += 100) {
      type(++revision);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(sentAt[0]).toBeLessThanOrEqual(2000);
    for (let i = 1; i < sentAt.length; i += 1) expect(sentAt[i]! - sentAt[i - 1]!).toBeLessThanOrEqual(2000);
    expect(6000 - sentAt.at(-1)!).toBeLessThanOrEqual(2000);
  });

  it('a save of the latest revision cancels the unsent copy and removes the record', async () => {
    type(1);
    scheduler.saved(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS * 2);
    expect(sink.record).not.toHaveBeenCalled();
    expect(sink.discardSaved).toHaveBeenCalledWith({
      projectId: BUFFER.projectId,
      relPath: BUFFER.relPath,
      bufferId: BUFFER.bufferId,
      revision: 1,
    });
  });

  it('edits typed while a save runs are still journaled', async () => {
    type(1);
    type(2);
    scheduler.saved(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it('a restored copy continues the journal revision of the crashed buffer', async () => {
    scheduler.begin({ ...BUFFER, baseRevision: 40 });
    type(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ revision: 41 }));
    scheduler.saved(1);
    expect(sink.discardSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 41 }));
  });

  it('switching buffers drops the unsent copy of the previous one; no buffer means no journal', async () => {
    type(1);
    scheduler.begin(null);
    type(2);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS * 2);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it('reports journal failures and their recovery; a new buffer starts healthy', async () => {
    health.length = 0;
    sink.record.mockResolvedValueOnce({ ok: false, code: 'too-large', message: 'big' });
    type(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    type(2);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    expect(health).toEqual(['too-large', null]);
    sink.record.mockResolvedValueOnce({ ok: false, code: 'too-large', message: 'big' });
    type(3);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    scheduler.begin({ ...BUFFER, bufferId: '22222222-2222-4222-8222-222222222222' });
    expect(health).toEqual(['too-large', null, 'too-large', null]);
  });

  it('retries a failed copy with backoff until it is written, always with the newest text', async () => {
    health.length = 0;
    sink.record
      .mockResolvedValueOnce({ ok: false, code: 'write-failed', message: 'EBUSY' })
      .mockRejectedValueOnce(new Error('bridge gone'));
    type(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    expect(sink.record).toHaveBeenCalledTimes(1);
    text = 'text 1 (still typing)';
    await vi.advanceTimersByTimeAsync(JOURNAL_RETRY_MS);
    expect(sink.record).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(JOURNAL_RETRY_MS * 2);
    expect(sink.record).toHaveBeenCalledTimes(3);
    expect(sink.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ revision: 1, text: 'text 1 (still typing)' }),
    );
    expect(health).toEqual(['write-failed', 'write-failed', null]);
    await vi.advanceTimersByTimeAsync(JOURNAL_RETRY_MAX_MS * 2);
    expect(sink.record).toHaveBeenCalledTimes(3);
  });

  it('a successful save clears a past failure; a save stops pending retries', async () => {
    health.length = 0;
    sink.record.mockResolvedValue({ ok: false, code: 'quota-exceeded', message: 'full' });
    type(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    scheduler.saved(1);
    await vi.advanceTimersByTimeAsync(JOURNAL_RETRY_MAX_MS * 4);
    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(health).toEqual(['quota-exceeded', null]);
  });

  it('resend journals the buffer again (after the journal was cleared)', async () => {
    type(4);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    scheduler.resend(4, () => text);
    await vi.advanceTimersByTimeAsync(JOURNAL_MAX_WAIT_MS);
    expect(sink.record).toHaveBeenCalledTimes(2);
    expect(sink.record).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 4 }));
  });
});
