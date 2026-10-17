import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECKPOINT_LIMITS, planAutoPrune } from './checkpoints';

/** S56.3: the documented pruning policy for automatic checkpoints (docs/decisions/0041, docs/product/checkpoints.md). */
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const limits = { maxAuto: 3, maxAutoAgeMs: 14 * DAY };

const auto = (id: string, daysAgo: number) => ({ id, kind: 'auto' as const, createdAt: NOW - daysAgo * DAY });
const named = (id: string, daysAgo: number) => ({ id, kind: 'named' as const, createdAt: NOW - daysAgo * DAY });

describe('planAutoPrune (S56.3)', () => {
  it('keeps the newest automatic checkpoints up to the count limit', () => {
    const list = [auto('a1', 1), auto('a2', 2), auto('a3', 3), auto('a4', 4), auto('a5', 5)];
    expect(planAutoPrune(list, NOW, limits).sort()).toEqual(['a4', 'a5']);
  });

  it('removes automatic checkpoints older than the age limit, but always keeps the newest one', () => {
    expect(planAutoPrune([auto('new', 1), auto('old', 15)], NOW, limits)).toEqual(['old']);
    // Even when every automatic checkpoint is old, the newest stays as a safety net.
    expect(planAutoPrune([auto('old1', 20), auto('old2', 30)], NOW, limits)).toEqual(['old2']);
    expect(planAutoPrune([auto('only', 400)], NOW, limits)).toEqual([]);
  });

  it('never removes a named checkpoint, whatever its age or count', () => {
    const list = [
      named('n1', 900),
      named('n2', 1),
      ...Array.from({ length: 10 }, (_, i) => named(`many${i}`, i)),
      auto('a1', 1),
      auto('a2', 30),
    ];
    const doomed = planAutoPrune(list, NOW, limits);
    expect(doomed).toEqual(['a2']);
    expect(doomed.some((id) => id.startsWith('n') || id.startsWith('many'))).toBe(false);
  });

  it('named checkpoints do not count against the automatic limit', () => {
    const list = [named('n1', 0), named('n2', 0), named('n3', 0), auto('a1', 1), auto('a2', 2), auto('a3', 3)];
    expect(planAutoPrune(list, NOW, limits)).toEqual([]);
  });

  it('the defaults are 20 automatic checkpoints for 14 days', () => {
    expect(DEFAULT_CHECKPOINT_LIMITS.maxAuto).toBe(20);
    expect(DEFAULT_CHECKPOINT_LIMITS.maxAutoAgeMs).toBe(14 * DAY);
    const list = Array.from({ length: 25 }, (_, i) => auto(`a${i}`, i * 0.1));
    expect(planAutoPrune(list, NOW, DEFAULT_CHECKPOINT_LIMITS)).toHaveLength(5);
  });
});
