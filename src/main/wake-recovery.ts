import type { PreviewState } from '../shared/ipc/preview-contract';
import type { WakeSignals } from '../platform/power-events';

/**
 * S25.1/S25.2 sleep/wake recovery (decision 0028). Main process; Electron-free so every path is unit-tested with a
 * simulated powerMonitor and clock. After the computer wakes (`resume`, `unlock-screen`, or a wall-clock jump seen
 * by the drift check when no event came):
 *
 * 1. the project watcher re-attaches on a fresh snapshot and reports `rescan` (the tree reloads, open files are
 *    compared with the disk by the renderer's usual external-change rules — a dirty buffer is never replaced);
 * 2. the preview's loopback server is health-checked; if it no longer answers, the preview restarts (same port if
 *    free, otherwise the new URL is loaded) and the user is told why;
 * 3. the page is pinged; only if it stopped answering *and* it was answering before the sleep, the preview
 *    restarts (a hung page cannot reload itself). A page that was already hung before the sleep is left alone:
 *    restarting would only run the same endless loop again, and Stop/Start stays available.
 *
 * Editor buffers, autosave and the recovery journal live in the renderer and app data; nothing here touches them,
 * and no project file is read for content or written.
 */
export type PowerEventName = 'suspend' | 'resume' | 'unlock-screen';

export interface PowerEvents {
  on(event: PowerEventName, listener: () => void): unknown;
  removeListener(event: PowerEventName, listener: () => void): unknown;
}

/** What recovery needs from the preview manager (PreviewManager implements it). */
export interface WakePreview {
  wakeSubject(): { readonly projectId: string; readonly state: PreviewState } | null;
  forgetStalePing(): void;
  serverAnswers(timeoutMs: number): Promise<boolean>;
  pageAnswers(timeoutMs: number): Promise<boolean>;
  restartAfterWake(reason: 'server' | 'page'): Promise<boolean>;
}

export interface WakeWatchers {
  /** Re-attaches the open project's watch and reports a rescan; false when no project is open. */
  resync(): Promise<boolean>;
}

export type WakeTrigger = 'resume' | 'unlock-screen' | 'clock-jump';

export interface WakeReport {
  readonly trigger: WakeTrigger;
  readonly watcher: 'rescanned' | 'none';
  readonly server: 'ok' | 'restarted' | 'restart-failed' | 'none';
  readonly page: 'ok' | 'restarted' | 'restart-failed' | 'left-alone' | 'not-checked' | 'none';
  /** When the recovery finished (the injected clock). */
  readonly at: number;
}

export interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
}

export interface WakeRecoveryDeps {
  readonly power: PowerEvents;
  readonly signals: WakeSignals;
  readonly watchers: WakeWatchers;
  readonly preview: WakePreview;
  /** Content-free log line (app-log.ts). */
  readonly log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
  readonly now?: () => number;
  readonly timers?: Timers;
  /** Pause after the wake signal before probing (Wi-Fi, disks and the loopback stack come back first). */
  readonly settleMs?: number;
  /** How long the server and the page get to answer. */
  readonly probeTimeoutMs?: number;
  /** A further unlock or clock jump within this long after a recovery is the same wake (no second recovery). */
  readonly minGapMs?: number;
}

/** States in which the page was answering (or loading) before the sleep. */
const WAS_ALIVE: readonly PreviewState[] = ['starting', 'running', 'refreshing'];

const defaultTimers: Timers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
};

export class WakeRecovery {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly settleMs: number;
  private readonly probeTimeoutMs: number;
  private readonly minGapMs: number;
  private readonly listeners: [PowerEventName, () => void][] = [];
  private drift: unknown = null;
  private lastTick = 0;
  /** Preview state when the machine went to sleep (suspend), or at the last drift tick before a jump. */
  private stateAtSuspend: PreviewState | null | undefined = undefined;
  private lastSeenState: PreviewState | null = null;
  private running: Promise<WakeReport> | null = null;
  private lastReport: WakeReport | null = null;
  private disposed = false;
  private suspendedAt = 0;

  constructor(private readonly deps: WakeRecoveryDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? defaultTimers;
    this.settleMs = deps.settleMs ?? 1_500;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 3_000;
    this.minGapMs = deps.minGapMs ?? 10_000;
  }

  install(): void {
    if (this.drift !== null) return;
    this.disposed = false;
    this.listen('suspend', () => {
      this.stateAtSuspend = this.deps.preview.wakeSubject()?.state ?? null;
      this.suspendedAt = this.now();
      this.deps.log?.('power-suspend', {});
    });
    for (const event of this.deps.signals.wakeEvents) this.listen(event, () => void this.recover(event));
    this.lastTick = this.now();
    this.drift = this.timers.setInterval(() => this.tick(), this.deps.signals.drift.intervalMs);
  }

  dispose(): void {
    this.disposed = true; // a recovery waiting for its settle pause stops there
    for (const [event, listener] of this.listeners) this.deps.power.removeListener(event, listener);
    this.listeners.length = 0;
    if (this.drift !== null) this.timers.clearInterval(this.drift);
    this.drift = null;
  }

  /** The last finished recovery (tests and diagnostics). */
  get last(): WakeReport | null {
    return this.lastReport;
  }

  /**
   * Runs one recovery (or joins the one in flight). `resume` always runs; an unlock or clock jump right after a
   * recovery belongs to the same wake and is skipped (resolves null).
   */
  recover(trigger: WakeTrigger): Promise<WakeReport | null> {
    if (this.running) return this.running;
    if (this.disposed) return Promise.resolve(null);
    const recent = this.lastReport !== null && this.now() - this.lastReport.at < this.minGapMs;
    // A resume always runs (a real sleep), unless the drift check already recovered from this very wake.
    if (recent && (trigger !== 'resume' || this.lastReport?.trigger === 'clock-jump')) return Promise.resolve(null);
    const before = this.stateAtSuspend !== undefined ? this.stateAtSuspend : this.lastSeenState;
    this.stateAtSuspend = undefined;
    const run = this.run(trigger, before).finally(() => {
      this.running = null;
      this.lastTick = this.now(); // the recovery's own duration is not a clock jump
    });
    this.running = run;
    return run;
  }

  private listen(event: PowerEventName, listener: () => void): void {
    this.deps.power.on(event, listener);
    this.listeners.push([event, listener]);
  }

  private tick(): void {
    const now = this.now();
    const late = now - this.lastTick - this.deps.signals.drift.intervalMs;
    this.lastTick = now;
    // A backwards jump (the user set the clock back) or ordinary timer lateness is not a wake.
    if (late > this.deps.signals.drift.gapMs) {
      void this.recover('clock-jump');
      return;
    }
    if (!this.running) {
      this.lastSeenState = this.deps.preview.wakeSubject()?.state ?? null;
      // Ordinary ticks long after a suspend: the sleep did not happen (or was aborted); the samples take over.
      if (now - this.suspendedAt > this.deps.signals.drift.gapMs) this.stateAtSuspend = undefined;
    }
  }

  private async run(trigger: WakeTrigger, before: PreviewState | null): Promise<WakeReport> {
    const { preview, watchers } = this.deps;
    // The watchdog must not count the sleep as the page's time to answer.
    preview.forgetStalePing();
    if (this.settleMs > 0) await new Promise<void>((resolve) => void this.timers.setTimeout(resolve, this.settleMs));
    if (this.disposed) {
      return { trigger, watcher: 'none', server: 'none', page: 'none', at: this.now() };
    }
    preview.forgetStalePing();

    let watcher: WakeReport['watcher'] = 'none';
    try {
      if (await watchers.resync()) watcher = 'rescanned';
    } catch {
      // the watcher reports its own rescan and retries; recovery goes on with the preview
    }

    let server: WakeReport['server'] = 'none';
    let page: WakeReport['page'] = 'none';
    const subject = preview.wakeSubject();
    if (subject) {
      const same = () => preview.wakeSubject()?.projectId === subject.projectId;
      if (!(await preview.serverAnswers(this.probeTimeoutMs))) {
        if (same()) {
          const restarted = await preview.restartAfterWake('server');
          server = restarted ? 'restarted' : 'restart-failed';
          page = restarted ? 'restarted' : 'restart-failed';
        }
      } else {
        server = 'ok';
        if (subject.state === 'starting' || subject.state === 'stopped') {
          page = 'not-checked'; // a fresh load is on its way
        } else if (await preview.pageAnswers(this.probeTimeoutMs)) {
          page = 'ok';
        } else if (before !== null && WAS_ALIVE.includes(before) && same()) {
          page = (await preview.restartAfterWake('page')) ? 'restarted' : 'restart-failed';
        } else {
          page = 'left-alone';
        }
      }
    }
    const report: WakeReport = { trigger, watcher, server, page, at: this.now() };
    this.lastReport = report;
    this.deps.log?.('wake-recovery', { trigger, watcher, server, page });
    return report;
  }
}
