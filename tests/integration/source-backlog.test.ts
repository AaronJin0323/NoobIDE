import { expect, it } from 'vitest';
import { sourceBacklog } from '../e2e/source-backlog';
it('keeps a valid delayed stream within its source burst regardless of IPC arrival order', () => {
  const times = Array.from({ length: 755 }, (_, i) => (i < 160 ? 0 : (i - 159) * 5));
  expect(sourceBacklog(times.reverse(), 200)).toBe(160);
});
it('detects a real source burst bypass even when later gaps would hide its average rate', () => {
  expect(sourceBacklog([...Array(1000).fill(0), 10000], 200)).toBe(1000);
});
it('does not bank idle time beyond a burst and handles an empty observation', () => {
  expect(sourceBacklog([0, ...Array(300).fill(10000)], 200)).toBe(300);
  expect(sourceBacklog([], 200)).toBe(0);
});

it('writes the JSON report where the workflow uploads it, relative to the config directory', async () => {
  const { default: config } = await import('../e2e/playwright.config');
  const reporters = config.reporter as [string, { outputFile?: string }][];
  const json = reporters.find(([name]) => name === 'json');
  expect(json?.[1].outputFile).toBe('../../reports/e2e/results.json');
});
