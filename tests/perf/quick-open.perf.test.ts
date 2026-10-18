import { describe, expect, it } from 'vitest';
import { rankFiles } from '../../src/renderer/commands/quick-open-model';
import { checkBudget } from './budget';

/**
 * S51.5: quick open filters 2 000 indexed files within 50 ms per keystroke, a miss (the full scan) included. Moved out
 * of src/renderer/commands/quick-open-model.test.ts by S58.8 (ADR 0038) after it failed hosted macOS runners twice
 * (75.7 ms in run 39081924736, 59.7 ms in run 39055086790): enforced by `npm run verify` on the dev machine, reported
 * on GitHub Actions. The ranking itself stays tested there.
 */
describe('quick open budget (S51.5)', () => {
  it('filters 2 000 indexed files: worst keystroke < 50 ms', () => {
    const files: string[] = [];
    for (let i = 0; i < 2000; i += 1) files.push(`栏目 ${i % 20}/子 目录 ${i % 7}/页面 ${i}.html`);
    files.push('css/样式 表.css');
    const typed = '子 目录 3/页面 19';
    rankFiles(files, typed, ['css/样式 表.css']); // warm up
    let worst = 0;
    for (let n = 1; n <= typed.length; n += 1) {
      const started = performance.now();
      const result = rankFiles(files, typed.slice(0, n), ['css/样式 表.css']);
      worst = Math.max(worst, performance.now() - started);
      expect(result.length).toBeGreaterThan(0);
    }
    // A miss scans everything (the slowest case).
    const started = performance.now();
    expect(rankFiles(files, 'zzzz不存在')).toEqual([]);
    worst = Math.max(worst, performance.now() - started);
    checkBudget('quick open: worst keystroke over 2 001 files', worst, 50);
  });
});
