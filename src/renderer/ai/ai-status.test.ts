import { describe, expect, it } from 'vitest';
import { latestOnly } from './ai-status';

/** A read whose replies the test releases in any order. */
function deferredReads() {
  const pending: ((value: string) => void)[] = [];
  const read = () => new Promise<string>((resolve) => pending.push(resolve));
  return { read, answer: (call: number, value: string) => pending[call]?.(value) };
}

describe('latestOnly (AI status reads)', () => {
  it('applies the newest reply and drops an older one that answers after it', async () => {
    const { read, answer } = deferredReads();
    const applied: string[] = [];
    const refresh = latestOnly(read, (value) => applied.push(value));
    const first = refresh(); // sent while the key was stored
    const second = refresh(); // sent after the key was removed
    answer(1, 'no key');
    await second;
    answer(0, 'key stored');
    await first;
    expect(applied).toEqual(['no key']);
  });

  it('applies every reply of calls that do not overlap', async () => {
    const { read, answer } = deferredReads();
    const applied: string[] = [];
    const refresh = latestOnly(read, (value) => applied.push(value));
    const first = refresh();
    answer(0, 'a');
    await first;
    const second = refresh();
    answer(1, 'b');
    await second;
    expect(applied).toEqual(['a', 'b']);
  });
});
