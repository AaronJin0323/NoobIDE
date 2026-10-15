import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { PreviewState } from '../shared/ipc/preview-contract';
import { wakeSignals } from '../platform/power-events';
import { WakeRecovery, type WakePreview, type WakeRecoveryDeps } from './wake-recovery';

/** S25.1/S25.2: recovery decisions with a simulated powerMonitor, clock and drift timer (decision 0028). */

class FakePreview implements WakePreview {
  subject: { projectId: string; state: PreviewState } | null = { projectId: 'p1', state: 'running' };
  server = true;
  page = true;
  restartWorks = true;
  readonly calls: string[] = [];
  wakeSubject() {
    return this.subject;
  }
  forgetStalePing() {
    this.calls.push('forget-ping');
  }
  async serverAnswers() {
    this.calls.push('server?');
    return this.server;
  }
  async pageAnswers() {
    this.calls.push('page?');
    return this.page;
  }
  async restartAfterWake(reason: 'server' | 'page') {
    this.calls.push(`restart:${reason}`);
    if (this.restartWorks) {
      this.server = true;
      this.page = true;
    }
    return this.restartWorks;
  }
}

function setup(overrides: Partial<WakeRecoveryDeps> = {}, platform: NodeJS.Platform = 'win32') {
  const power = new EventEmitter();
  const preview = new FakePreview();
  const resyncs: number[] = [];
  let clock = 1_000_000;
  let tick: (() => void) | null = null;
  const logs: { event: string; fields: object }[] = [];
  let resyncResult: boolean | Error = true;
  const recovery = new WakeRecovery({
    power: power as unknown as WakeRecoveryDeps['power'],
    signals: wakeSignals(platform),
    watchers: {
      resync: async () => {
        resyncs.push(clock);
        if (resyncResult instanceof Error) throw resyncResult;
        return resyncResult;
      },
    },
    preview,
    log: (event, fields) => logs.push({ event, fields }),
    now: () => clock,
    timers: {
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
      setTimeout: (callback) => {
        callback();
        return 1;
      },
    },
    ...overrides,
  });
  recovery.install();
  return {
    power,
    preview,
    recovery,
    resyncs,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => tick?.(),
    hasTimer: () => tick !== null,
    setResync: (value: boolean | Error) => {
      resyncResult = value;
    },
  };
}

async function settled(recovery: WakeRecovery) {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  return recovery.last;
}

describe('WakeRecovery', () => {
  it('on resume: rescans the watcher, checks the server and the page, restarts nothing when both answer', async () => {
    const t = setup();
    t.power.emit('suspend');
    t.advance(5 * 60_000);
    t.power.emit('resume');
    const report = await settled(t.recovery);
    expect(report).toMatchObject({ trigger: 'resume', watcher: 'rescanned', server: 'ok', page: 'ok' });
    expect(t.resyncs).toHaveLength(1);
    expect(t.preview.calls).toEqual(['forget-ping', 'forget-ping', 'server?', 'page?']);
    // The log line has decisions only: no paths, no page content.
    expect(t.logs.map((l) => l.event)).toEqual(['power-suspend', 'wake-recovery']);
    expect(t.logs[1]?.fields).toEqual({ trigger: 'resume', watcher: 'rescanned', server: 'ok', page: 'ok' });
  });

  it('server socket died during sleep: the preview restarts and is reported as such', async () => {
    const t = setup();
    t.power.emit('suspend');
    t.preview.server = false;
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ server: 'restarted', page: 'restarted' });
    expect(t.preview.calls).toContain('restart:server');
    expect(t.preview.calls).not.toContain('page?');
  });

  it('a failed restart is reported, never retried in a loop', async () => {
    const t = setup();
    t.preview.server = false;
    t.preview.restartWorks = false;
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ server: 'restart-failed' });
    expect(t.preview.calls.filter((c) => c.startsWith('restart'))).toHaveLength(1);
  });

  it('page answered before the sleep but not after: restarted (a hung page cannot reload itself)', async () => {
    const t = setup();
    t.power.emit('suspend');
    t.preview.page = false;
    t.preview.subject = { projectId: 'p1', state: 'unresponsive' }; // the watchdog noticed first
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ server: 'ok', page: 'restarted' });
    expect(t.preview.calls).toContain('restart:page');
  });

  it('a page that was already hung before the sleep is left alone (its own endless loop)', async () => {
    const t = setup();
    t.preview.subject = { projectId: 'p1', state: 'unresponsive' };
    t.preview.page = false;
    t.power.emit('suspend');
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ page: 'left-alone' });
    expect(t.preview.calls.some((c) => c.startsWith('restart'))).toBe(false);
  });

  it('a preview that is still starting is not pinged; no preview at all: only the watcher', async () => {
    const t = setup();
    t.preview.subject = { projectId: 'p1', state: 'starting' };
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ server: 'ok', page: 'not-checked' });
    t.preview.subject = null;
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ watcher: 'rescanned', server: 'none', page: 'none' });
  });

  it('no project open: nothing to rescan; a failing resync still lets the preview be checked', async () => {
    const t = setup();
    t.setResync(false);
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ watcher: 'none', server: 'ok' });
    t.setResync(new Error('watch failed'));
    t.power.emit('resume');
    expect(await settled(t.recovery)).toMatchObject({ watcher: 'none', server: 'ok', page: 'ok' });
  });

  it('clock jump without any power event (Windows Modern Standby) is detected by the drift check', async () => {
    const t = setup();
    const { intervalMs } = wakeSignals('win32').drift;
    t.advance(intervalMs);
    t.tick(); // normal tick: samples the page as running
    t.preview.page = false; // hung after the unreported sleep
    t.advance(intervalMs + 10 * 60_000);
    t.tick();
    expect(await settled(t.recovery)).toMatchObject({ trigger: 'clock-jump', watcher: 'rescanned', page: 'restarted' });
  });

  it('ordinary timer lateness and a clock set backwards are not wakes', async () => {
    const t = setup({}, 'darwin');
    const { intervalMs, gapMs } = wakeSignals('darwin').drift;
    t.advance(intervalMs + gapMs - 1); // App Nap: late, within tolerance
    t.tick();
    t.advance(-3_600_000); // the user set the clock back an hour
    t.tick();
    await settled(t.recovery);
    expect(t.recovery.last).toBeNull();
    expect(t.resyncs).toHaveLength(0);
  });

  it('resume and unlock-screen of one wake give one recovery; an overlapping signal joins the one in flight', async () => {
    const t = setup();
    t.power.emit('suspend');
    t.power.emit('resume');
    t.power.emit('unlock-screen'); // in flight: joins
    await settled(t.recovery);
    t.advance(2_000);
    t.power.emit('unlock-screen'); // right after: same wake
    await settled(t.recovery);
    expect(t.resyncs).toHaveLength(1);
    t.advance(60_000);
    t.power.emit('unlock-screen'); // a later unlock (macOS screen lock without sleep) is checked again
    expect(await settled(t.recovery)).toMatchObject({ trigger: 'unlock-screen' });
    expect(t.resyncs).toHaveLength(2);
  });

  it('a preview stopped or switched during the checks is not restarted', async () => {
    const t = setup();
    t.preview.server = false;
    const original = t.preview.serverAnswers.bind(t.preview);
    t.preview.serverAnswers = async () => {
      const answer = await original();
      t.preview.subject = { projectId: 'other', state: 'running' };
      return answer;
    };
    t.power.emit('resume');
    await settled(t.recovery);
    expect(t.preview.calls.some((c) => c.startsWith('restart'))).toBe(false);
  });

  it('a suspend that was not followed by a sleep expires: later ordinary ticks decide what "before" means', async () => {
    const t = setup();
    const { intervalMs, gapMs } = wakeSignals('win32').drift;
    t.power.emit('suspend'); // page running
    t.preview.subject = { projectId: 'p1', state: 'unresponsive' }; // the user's own loop, much later
    for (let elapsed = 0; elapsed <= gapMs + intervalMs; elapsed += intervalMs) {
      t.advance(intervalMs);
      t.tick();
    }
    t.preview.page = false;
    t.power.emit('unlock-screen');
    expect(await settled(t.recovery)).toMatchObject({ page: 'left-alone' });
  });

  it('a late resume after the drift check already recovered from the same wake is not a second recovery', async () => {
    const t = setup();
    const { intervalMs } = wakeSignals('win32').drift;
    t.advance(intervalMs + 5 * 60_000);
    t.tick();
    expect(await settled(t.recovery)).toMatchObject({ trigger: 'clock-jump' });
    t.advance(1_000);
    t.power.emit('resume');
    await settled(t.recovery);
    expect(t.resyncs).toHaveLength(1);
  });

  it('after dispose a recovery waiting for its settle pause touches nothing', async () => {
    let settle: () => void = () => undefined;
    const t = setup({
      timers: {
        setInterval: () => 1,
        clearInterval: () => undefined,
        setTimeout: (callback) => {
          settle = callback;
          return 1;
        },
      },
    });
    t.power.emit('resume');
    t.recovery.dispose();
    settle();
    await settled(t.recovery);
    expect(t.resyncs).toHaveLength(0);
    expect(t.preview.calls.filter((c) => c !== 'forget-ping')).toEqual([]);
  });

  it('dispose removes the power listeners and the drift timer', () => {
    const t = setup();
    expect(t.power.listenerCount('resume')).toBe(1);
    expect(t.power.listenerCount('unlock-screen')).toBe(1);
    t.recovery.dispose();
    for (const event of ['suspend', 'resume', 'unlock-screen']) expect(t.power.listenerCount(event)).toBe(0);
    expect(t.hasTimer()).toBe(false);
  });
});
