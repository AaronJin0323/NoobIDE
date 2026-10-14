import { describe, expect, it } from 'vitest';
import { DocumentSaver, saveEvery, type Timers, type WriteOutcome } from './save-controller';
import { saveStatus, type SaveSnapshot } from './save-machine';

/** A write that resolves only when the test says so — models a slow disk or a rename that is still pending. */
function slowDisk() {
  const writes: { text: string; resolve: (outcome: WriteOutcome) => void }[] = [];
  let disk = '';
  return {
    writes,
    get disk() {
      return disk;
    },
    write: (text: string) =>
      new Promise<WriteOutcome>((resolve) => {
        writes.push({
          text,
          resolve: (outcome) => {
            if (outcome.ok) disk = text;
            resolve(outcome);
          },
        });
      }),
    /** Confirms (or fails) the oldest pending write and lets the saver react. */
    async settle(outcome: WriteOutcome = { ok: true }) {
      const next = writes.shift();
      if (!next) throw new Error('no write pending');
      next.resolve(outcome);
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function manualTimers(): Timers & { fire(): void; pending(): number } {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    set: (callback) => {
      timers.set(next, callback);
      return next++;
    },
    clear: (handle) => void timers.delete(handle as number),
    fire: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pending: () => timers.size,
  };
}

function setup(options: { autosave?: boolean } = {}) {
  const disk = slowDisk();
  const timers = manualTimers();
  const states: SaveSnapshot[] = [];
  const saver = new DocumentSaver({
    initialText: 'v0',
    write: disk.write,
    onState: (s) => states.push(s),
    timers,
    autosave: options.autosave ?? true,
  });
  const status = () => saveStatus(saver.state);
  return { disk, timers, saver, states, status };
}

const FAIL: WriteOutcome = { ok: false, code: 'permission-denied', message: 'EACCES' };

describe('document saver: serialized writes (S10.2)', () => {
  it('saves several times while a write is pending: one write at a time, newest text last, never a stale "saved"', async () => {
    const { disk, saver, status } = setup({ autosave: false });
    saver.edit('v1');
    const a = saver.save();
    saver.edit('v2');
    const b = saver.save();
    saver.edit('v3');
    const c = saver.save();
    const d = saver.save();
    await flush();
    expect(disk.writes.map((w) => w.text)).toEqual(['v1']); // no concurrent writes
    await disk.settle();
    expect(disk.writes.map((w) => w.text)).toEqual(['v3']); // coalesced: v2 is skipped, v3 carries everything
    expect(status()).toBe('saving');
    await disk.settle();
    expect(await Promise.all([a, b, c, d])).toEqual([true, true, true, true]);
    expect(disk.disk).toBe('v3');
    expect(status()).toBe('saved');
    expect(disk.writes).toHaveLength(0);
  });

  it('a save resolves true only when the newest text is on disk (edits during the write are written too)', async () => {
    const { disk, saver, status } = setup({ autosave: false });
    saver.edit('v1');
    const done = saver.save();
    await flush();
    saver.edit('v2'); // typed while v1 is being written
    await disk.settle();
    expect(disk.writes.map((w) => w.text)).toEqual(['v2']);
    await disk.settle();
    expect(await done).toBe(true);
    expect(disk.disk).toBe('v2');
    expect(status()).toBe('saved');
  });

  it('a failed write keeps the text, reports the cause and resolves false; the next save retries', async () => {
    const { disk, saver, status } = setup({ autosave: false });
    saver.edit('important');
    const first = saver.save();
    await flush();
    await disk.settle(FAIL);
    expect(await first).toBe(false);
    expect(status()).toBe('failed');
    expect(saver.state.error).toEqual({ code: 'permission-denied', message: 'EACCES' });
    expect(saver.text).toBe('important');
    expect(disk.disk).toBe('');
    const retry = saver.save();
    await flush();
    await disk.settle();
    expect(await retry).toBe(true);
    expect(status()).toBe('saved');
    expect(saver.state.error).toBeNull();
  });

  it('a write that throws is a failure, not a crash', async () => {
    const saver = new DocumentSaver({ initialText: '', write: () => Promise.reject(new TypeError('boom')) });
    saver.edit('x');
    expect(await saver.save()).toBe(false);
    expect(saver.state.error).toEqual({ code: 'write-failed', message: 'TypeError' });
  });

  it('nothing to save resolves true without writing', async () => {
    const { disk, saver } = setup();
    expect(await saver.save()).toBe(true);
    expect(disk.writes).toHaveLength(0);
  });
});

describe('document saver: autosave (S10.2)', () => {
  it('writes after a typing pause, coalescing all edits of the pause into one write', async () => {
    const { disk, timers, saver, status } = setup();
    saver.edit('a');
    saver.edit('ab');
    saver.edit('abc');
    expect(timers.pending()).toBe(1); // each edit restarts the same pause
    expect(disk.writes).toHaveLength(0);
    expect(status()).toBe('dirty');
    timers.fire();
    await flush();
    expect(disk.writes.map((w) => w.text)).toEqual(['abc']);
    await disk.settle();
    expect(status()).toBe('saved');
  });

  it('writes immediately when the editor loses focus', async () => {
    const { disk, timers, saver } = setup();
    saver.edit('x');
    saver.blur();
    await flush();
    expect(disk.writes.map((w) => w.text)).toEqual(['x']);
    expect(timers.pending()).toBe(0);
  });

  it('never writes during an IME composition; the pause restarts when the composition ends (S09.4/S09.5)', async () => {
    const { disk, timers, saver } = setup();
    saver.compositionStart();
    saver.edit('n');
    saver.edit('ni');
    saver.blur();
    expect(timers.pending()).toBe(0);
    await flush();
    expect(disk.writes).toHaveLength(0);
    saver.edit('你');
    saver.compositionEnd();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await flush();
    expect(disk.writes.map((w) => w.text)).toEqual(['你']);
  });

  it('a pause that ends during a composition does not write', async () => {
    const { disk, timers, saver } = setup();
    saver.edit('a');
    saver.compositionStart();
    timers.fire();
    await flush();
    expect(disk.writes).toHaveLength(0);
  });

  it('autosave off: only manual saves write', async () => {
    const { disk, timers, saver } = setup({ autosave: false });
    saver.edit('x');
    saver.blur();
    expect(timers.pending()).toBe(0);
    await flush();
    expect(disk.writes).toHaveLength(0);
  });

  it('stops over a conflict and never writes it automatically', async () => {
    const { disk, timers, saver, status } = setup();
    saver.edit('mine');
    saver.externalChange();
    expect(status()).toBe('conflict');
    expect(timers.pending()).toBe(0);
    saver.edit('mine 2');
    saver.blur();
    expect(await saver.save()).toBe(false);
    expect(disk.writes).toHaveLength(0);
  });
});

describe('document saver: "saved" notifications for the preview (S10.5)', () => {
  it('notifies strictly after the write is confirmed and after the status says saved', async () => {
    const { disk, saver } = setup({ autosave: false });
    const seen: { revision: number; status: string; disk: string }[] = [];
    saver.onSaved(({ revision }) => seen.push({ revision, status: saveStatus(saver.state), disk: disk.disk }));
    saver.edit('v1');
    const done = saver.save();
    await flush();
    expect(seen).toEqual([]); // write still pending: no refresh yet
    await disk.settle();
    await done;
    expect(seen).toEqual([{ revision: 1, status: 'saved', disk: 'v1' }]);
  });

  it('never notifies for a failed write', async () => {
    const { disk, saver } = setup({ autosave: false });
    let notified = 0;
    saver.onSaved(() => (notified += 1));
    saver.edit('x');
    const done = saver.save();
    await flush();
    await disk.settle(FAIL);
    await done;
    expect(notified).toBe(0);
  });

  it('stops notifying after unsubscribe or dispose', async () => {
    const { disk, saver } = setup({ autosave: false });
    let notified = 0;
    const off = saver.onSaved(() => (notified += 1));
    off();
    saver.edit('x');
    const done = saver.save();
    await flush();
    await disk.settle();
    await done;
    expect(notified).toBe(0);
  });
});

describe('saving every open file (close / project switch)', () => {
  it('saves edits typed in an already-saved file while another file is still being written', async () => {
    const a = setup({ autosave: false });
    const b = setup({ autosave: false });
    a.saver.edit('a1');
    b.saver.edit('b1');
    const all = saveEvery(() => [['a.html', a.saver] as const, ['b.html', b.saver] as const]);
    await flush();
    await a.disk.settle(); // a.html done in this pass
    expect(b.disk.writes.map((w) => w.text)).toEqual(['b1']);
    a.saver.edit('a2'); // typed while b.html is still being written
    await b.disk.settle();
    expect(a.disk.writes.map((w) => w.text)).toEqual(['a2']); // a second pass picks it up
    await a.disk.settle();
    expect(await all).toEqual({ ok: true });
    expect(a.disk.disk).toBe('a2');
    expect(b.disk.disk).toBe('b1');
  });

  it('stops at the first file that cannot be saved and names it', async () => {
    const a = setup({ autosave: false });
    const b = setup({ autosave: false });
    a.saver.edit('a1');
    b.saver.edit('b1');
    const all = saveEvery(() => [['a.html', a.saver] as const, ['b.html', b.saver] as const]);
    await flush();
    await a.disk.settle(FAIL);
    expect(await all).toEqual({ ok: false, failed: 'a.html' });
    expect(b.disk.writes).toHaveLength(0);
  });
});

describe('document saver: lifecycle', () => {
  it('ignores edits and stops timers after dispose', () => {
    const { timers, saver, states } = setup();
    saver.edit('x');
    saver.dispose();
    expect(timers.pending()).toBe(0);
    const count = states.length;
    saver.edit('y');
    expect(states).toHaveLength(count);
    expect(saver.text).toBe('x');
  });
});
