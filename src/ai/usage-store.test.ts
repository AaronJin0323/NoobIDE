import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiUsageStore, dayKey, USAGE_DAYS_KEPT } from './usage-store';

/** S39.2: token use per day and provider, and the optional daily budget, in app data. */
let dir: string;
let file: string;
let clock: number;

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const make = () => new AiUsageStore({ file, now: () => clock });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noobide-usage-'));
  file = path.join(dir, 'ai-usage.json');
  clock = at(2026, 10, 15);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('AiUsageStore (S39.2)', () => {
  it('adds tokens per provider for today and keeps them across restarts', async () => {
    const s = make();
    expect(await s.summary()).toEqual({
      day: '2026-10-15',
      perProvider: { anthropic: { inputTokens: 0, outputTokens: 0 }, openai: { inputTokens: 0, outputTokens: 0 } },
      totalTokens: 0,
      dailyBudget: null,
      budgetReached: false,
    });
    await s.record('anthropic', { inputTokens: 120, outputTokens: 48 });
    await s.record('anthropic', { inputTokens: 10, outputTokens: 2 });
    await s.record('openai', { inputTokens: 5, outputTokens: 1 });
    await s.record('openai', { inputTokens: -3, outputTokens: Number.NaN }); // ignored
    const summary = await make().summary();
    expect(summary.perProvider).toEqual({
      anthropic: { inputTokens: 130, outputTokens: 50 },
      openai: { inputTokens: 5, outputTokens: 1 },
    });
    expect(summary.totalTokens).toBe(186);
    // Only numbers are stored.
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')) as object)).toEqual(['version', 'dailyBudget', 'days']);
  });

  it('starts a new day at local midnight and keeps only recent days', async () => {
    const s = make();
    clock = at(2026, 10, 15, 23);
    await s.record('anthropic', { inputTokens: 900, outputTokens: 0 });
    clock = at(2026, 10, 16, 0);
    expect(dayKey(clock)).toBe('2026-10-16');
    expect((await s.summary()).totalTokens).toBe(0);
    await s.record('anthropic', { inputTokens: 1, outputTokens: 1 });
    expect((await s.summary()).totalTokens).toBe(2);
    // Retention: more days than are kept are seeded into the file, then one more day is recorded. (Recording each day
    // was ~70 atomic writes, which took over 5 s on the Windows CI runner and leaked its clock into the next test.)
    const stored = JSON.parse(await readFile(file, 'utf8')) as { days: Record<string, unknown> };
    const last = at(2026, 11, 1) + (USAGE_DAYS_KEPT + 4) * 86_400_000;
    for (let d = 0; d < USAGE_DAYS_KEPT + 4; d += 1)
      stored.days[dayKey(at(2026, 11, 1) + d * 86_400_000)] = { openai: { inputTokens: 1, outputTokens: 0 } };
    await writeFile(file, JSON.stringify(stored));
    clock = last;
    await make().record('openai', { inputTokens: 1, outputTokens: 0 });
    const days = Object.keys((JSON.parse(await readFile(file, 'utf8')) as { days: object }).days);
    expect(days).toHaveLength(USAGE_DAYS_KEPT);
    expect(days).not.toContain('2026-10-15');
    expect(days).not.toContain('2026-10-16');
    expect(days).toContain(dayKey(last));
  });

  it('has no budget by default; a budget is reached at the limit and resets the next day', async () => {
    const s = make();
    await s.record('anthropic', { inputTokens: 5000, outputTokens: 0 });
    expect(await s.budgetReached()).toBe(false);
    expect(await s.setBudget(6000)).toMatchObject({ dailyBudget: 6000, budgetReached: false, totalTokens: 5000 });
    await s.record('openai', { inputTokens: 900, outputTokens: 100 });
    expect(await s.budgetReached()).toBe(true);
    expect((await make().summary()).dailyBudget).toBe(6000);
    clock = at(2026, 10, 16, 0);
    expect(await s.budgetReached()).toBe(false);
    expect(await s.setBudget(null)).toMatchObject({ dailyBudget: null, budgetReached: false });
    // Out-of-range values never become a budget.
    expect((await s.setBudget(5)).dailyBudget).toBeNull();
  });

  it('tolerates a damaged file: backed up and started fresh', async () => {
    await writeFile(file, '{ broken');
    const s = make();
    expect((await s.summary()).totalTokens).toBe(0);
    await s.record('anthropic', { inputTokens: 1, outputTokens: 1 });
    const names = await readdir(dir);
    expect(names.some((n) => n.startsWith('ai-usage.corrupt-'))).toBe(true);
    await writeFile(
      file,
      JSON.stringify({ version: 1, dailyBudget: 'x', days: { bad: 1, '2026-10-15': { anthropic: 'no' } } }),
    );
    expect(await make().summary()).toMatchObject({ dailyBudget: null, totalTokens: 0 });
  });
});
