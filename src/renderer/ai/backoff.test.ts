import { describe, expect, it } from 'vitest';
import { BACKOFF, backoffDelayMs, busyCause, countdownParts, planRetry } from './backoff';

describe('provider backoff (S48.7)', () => {
  it('waits only for 429 and 503', () => {
    expect(busyCause({ code: 'rate-limited', status: 429 })).toBe(429);
    expect(busyCause({ code: 'rate-limited' })).toBe(429);
    expect(busyCause({ code: 'provider-error', status: 503 })).toBe(503);
    expect(busyCause({ code: 'provider-error', status: 500 })).toBeNull();
    expect(busyCause({ code: 'offline' })).toBeNull();
    expect(busyCause({ code: 'unauthorized', status: 401 })).toBeNull();
  });

  it('min(max(base, 5s) * 2^(n-1) * jitter, 600s)', () => {
    // No Retry-After: base 5 s; random 0.5 is jitter 1.0.
    expect(backoffDelayMs(1, undefined, 0.5)).toBe(5_000);
    expect(backoffDelayMs(2, undefined, 0.5)).toBe(10_000);
    expect(backoffDelayMs(3, undefined, 0.5)).toBe(20_000);
    // Retry-After below 5 s still waits 5 s; above it is the base.
    expect(backoffDelayMs(1, 2, 0.5)).toBe(5_000);
    expect(backoffDelayMs(1, 30, 0.5)).toBe(30_000);
    expect(backoffDelayMs(3, 30, 0.5)).toBe(120_000);
    // Capped at 600 s.
    expect(backoffDelayMs(3, 400, 0.5)).toBe(BACKOFF.maxMs);
    expect(backoffDelayMs(1, 3600, 0)).toBe(BACKOFF.maxMs);
  });

  it('jitter stays within 0.85–1.15', () => {
    expect(backoffDelayMs(1, undefined, 0)).toBe(4_250);
    expect(backoffDelayMs(1, undefined, 0.9999999)).toBe(5_750);
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelayMs(2, undefined, Math.random());
      expect(delay).toBeGreaterThanOrEqual(8_500);
      expect(delay).toBeLessThanOrEqual(11_500);
    }
    // Out-of-range randomness is clamped.
    expect(backoffDelayMs(1, undefined, -1)).toBe(4_250);
    expect(backoffDelayMs(1, undefined, 2)).toBe(5_750);
  });

  it('retries automatically at most three times, then only by hand, keeping the cause', () => {
    const busy = { code: 'provider-error', status: 503, retryAfterSeconds: 7 };
    expect(planRetry(busy, 0, 0.5)).toEqual({ kind: 'automatic', attempt: 1, delayMs: 7_000, cause: 503 });
    expect(planRetry(busy, 1, 0.5)).toEqual({ kind: 'automatic', attempt: 2, delayMs: 14_000, cause: 503 });
    expect(planRetry(busy, 2, 0.5)).toEqual({ kind: 'automatic', attempt: 3, delayMs: 28_000, cause: 503 });
    expect(planRetry(busy, 3, 0.5)).toEqual({ kind: 'manual', cause: 503, exhausted: true });
    expect(planRetry({ code: 'offline' }, 0, 0.5)).toEqual({ kind: 'manual', cause: null, exhausted: false });
  });

  it('counts down in whole seconds and minutes', () => {
    expect(countdownParts(4_250)).toEqual({ minutes: 0, seconds: 5 });
    expect(countdownParts(1)).toEqual({ minutes: 0, seconds: 1 });
    expect(countdownParts(0)).toEqual({ minutes: 0, seconds: 1 });
    expect(countdownParts(80_000)).toEqual({ minutes: 1, seconds: 20 });
    expect(countdownParts(600_000)).toEqual({ minutes: 10, seconds: 0 });
  });
});
