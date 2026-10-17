import { publishSummary, resetReport } from './budget';

/**
 * Perf project lifecycle (vitest.perf.config.ts): start every run from an empty report, and at the end turn the
 * report into the GitHub job summary when the run is on GitHub Actions (no-op elsewhere).
 */
export function setup(): void {
  resetReport();
}

export function teardown(): void {
  publishSummary();
}
