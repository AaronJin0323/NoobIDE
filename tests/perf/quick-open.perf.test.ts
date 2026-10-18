import { describe, expect, it } from 'vitest';
import { rankFiles } from '../../src/renderer/commands/quick-open-model';
import { checkBudget } from './budget';

/**
 * S51.5: with 2 000 files indexed, filtering after each keystroke completes in under 50 ms (worst keystroke ≈ 3 ms on
 * the dev machine). Moved out of src/renderer/commands/quick-open-model.test.ts after hosted macOS measured 51.7 ms
 * (PR #44, run 39095552224): enforced by `npm run verify` on a developer machine, reported on GitHub Actions
 * (ADR 0038).
 */
describe('quick open budget (S51.5)', () => {
  it('filters 2 000 indexed files in under 50 ms per keystroke', () => {
    const files: string[] = [];
    for (let i = 0; i < 2000; i += 1) files.push(`栏目 ${i % 20}/子 目录 ${i % 7}/页面 ${i}.html`);
    files.push('css/样式 表.css');
    const typed = '子 目录 3/页面 19';
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
    checkBudget(`quick open: worst keystroke over ${files.length} files`, worst, 50);
  });
});
