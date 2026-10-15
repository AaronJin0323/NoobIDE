import { platformId } from './index';

/**
 * S25.1/S25.2 (decision 0027): which OS signals mean "the computer may have slept", per platform.
 *
 * - Electron's powerMonitor emits `suspend` / `resume` on both platforms, and `unlock-screen` after the lock screen
 *   (Windows: WTS session unlock; macOS: `com.apple.screenIsUnlocked`). Waking a locked machine always passes the
 *   lock screen, so `unlock-screen` covers a wake whose `resume` was missed.
 * - Windows Modern Standby (S0ix, most current laptops) does not always report a suspend/resume pair to desktop
 *   apps: the process is frozen and simply continues. The only trace is wall-clock time jumping ahead of the
 *   timers, so a short drift-check interval runs there.
 * - macOS reports sleep reliably, but App Nap delays the timers of a hidden app by tens of seconds; the drift
 *   check therefore runs less often and tolerates a larger gap so a napping app is not mistaken for a wake.
 */
export type WakeEvent = 'resume' | 'unlock-screen';

export interface WakeSignals {
  /** powerMonitor events after which recovery runs. */
  readonly wakeEvents: readonly WakeEvent[];
  /** A tick every `intervalMs`; wall-clock time more than `gapMs` beyond it counts as a wake without an event. */
  readonly drift: { readonly intervalMs: number; readonly gapMs: number };
}

export function wakeSignals(platform: NodeJS.Platform = process.platform): WakeSignals {
  switch (platformId(platform)) {
    case 'windows':
      return { wakeEvents: ['resume', 'unlock-screen'], drift: { intervalMs: 10_000, gapMs: 60_000 } };
    case 'mac':
      return { wakeEvents: ['resume', 'unlock-screen'], drift: { intervalMs: 30_000, gapMs: 120_000 } };
    default:
      return { wakeEvents: ['resume'], drift: { intervalMs: 30_000, gapMs: 120_000 } };
  }
}
