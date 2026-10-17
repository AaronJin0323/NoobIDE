/**
 * S48.7: what the chat does when the provider is busy. HTTP 429 (too many requests) and 503 (unavailable) are
 * retried automatically after a growing wait — min(max(base, 5 s) · 2^(n−1) · jitter 0.85–1.15, 600 s), where base
 * is the provider's Retry-After — at most three times; then the user retries by hand. Other failures are never
 * retried automatically (Retry is offered). Pure, so every rule is unit-tested.
 */

export const BACKOFF = {
  /** The shortest wait, whatever Retry-After says. */
  minBaseMs: 5_000,
  /** The longest wait. */
  maxMs: 600_000,
  /** Automatic retries before only the manual Retry is left. */
  maxAutomatic: 3,
  jitterMin: 0.85,
  jitterMax: 1.15,
} as const;

/** Why the provider asked us to wait, when it did. */
export type BusyCause = 429 | 503;

/** The failure as the turn recorded it. */
export interface FailureInfo {
  readonly code: string;
  readonly status?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;
}

/** 429 (or the provider's `rate-limited`) and 503 wait and retry; anything else does not. */
export function busyCause(failure: FailureInfo): BusyCause | null {
  if (failure.status === 503) return 503;
  if (failure.status === 429 || failure.code === 'rate-limited') return 429;
  return null;
}

/** The wait before automatic retry `attempt` (1-based). `random` is in [0, 1). */
export function backoffDelayMs(attempt: number, retryAfterSeconds: number | undefined, random: number): number {
  const base = Math.max((retryAfterSeconds ?? 0) * 1000, BACKOFF.minBaseMs);
  const jitter = BACKOFF.jitterMin + (BACKOFF.jitterMax - BACKOFF.jitterMin) * Math.min(Math.max(random, 0), 1);
  return Math.round(Math.min(base * 2 ** (Math.max(attempt, 1) - 1) * jitter, BACKOFF.maxMs));
}

export type RetryPlan =
  | { readonly kind: 'automatic'; readonly attempt: number; readonly delayMs: number; readonly cause: BusyCause }
  /** No (more) automatic retries: the user presses Retry. `cause` says why the provider refused, when it was busy. */
  | { readonly kind: 'manual'; readonly cause: BusyCause | null; readonly exhausted: boolean };

/** What follows a failure, given how many automatic retries this question already had. */
export function planRetry(failure: FailureInfo, automaticSoFar: number, random: number): RetryPlan {
  const cause = busyCause(failure);
  if (cause === null) return { kind: 'manual', cause: null, exhausted: false };
  if (automaticSoFar >= BACKOFF.maxAutomatic) return { kind: 'manual', cause, exhausted: true };
  const attempt = automaticSoFar + 1;
  return { kind: 'automatic', attempt, delayMs: backoffDelayMs(attempt, failure.retryAfterSeconds, random), cause };
}

/** The countdown in whole seconds (never 0 while waiting), split for "1 minute 20 seconds" style wording. */
export function countdownParts(remainingMs: number): { readonly minutes: number; readonly seconds: number } {
  const total = Math.max(1, Math.ceil(remainingMs / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}
