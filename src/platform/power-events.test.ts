import { describe, expect, it } from 'vitest';
import { wakeSignals } from './power-events';

describe('wakeSignals (S25.1/S25.2)', () => {
  it('Windows: resume and unlock, and a short drift check for Modern Standby wakes without events', () => {
    const s = wakeSignals('win32');
    expect(s.wakeEvents).toEqual(['resume', 'unlock-screen']);
    expect(s.drift.intervalMs).toBeLessThanOrEqual(10_000);
    expect(s.drift.gapMs).toBeGreaterThanOrEqual(30_000);
  });

  it('macOS: resume and unlock; the drift check tolerates App Nap timer delays', () => {
    const s = wakeSignals('darwin');
    expect(s.wakeEvents).toEqual(['resume', 'unlock-screen']);
    expect(s.drift.gapMs).toBeGreaterThan(wakeSignals('win32').drift.gapMs);
  });

  it('other platforms (dev runs): resume only', () => {
    expect(wakeSignals('linux').wakeEvents).toEqual(['resume']);
  });
});
