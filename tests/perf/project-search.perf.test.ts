import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchProject } from '../../src/workspace/project-search';
import type { SearchResults } from '../../src/shared/ipc/search-contract';
import type { SearchQuery } from '../../src/shared/search';
import { checkBudget } from './budget';

/**
 * S51.2 timing budget: on a generated 2 000-file project whose paths have Chinese characters and spaces, a search
 * answers in under 1 s and the main-process event loop is never blocked for more than 100 ms (a 5 ms timer runs
 * beside the search; its largest gap between ticks is the longest stall). The functional half — every file searched,
 * the hits, the match cap — stays in tests/integration/project-search.test.ts.
 *
 * Hosted CI runners (3–4 shared vCPUs) deschedule this worker for hundreds of milliseconds (a Windows shard measured
 * 1 066 ms against ≈ 150 ms on the dev machine), so a search that misses the budget is timed again, up to BATCHES
 * times, and the best batch is judged, as completion-latency.perf.test.ts does: a batch inside the budget proves the
 * engine's cost does, and a stalled batch is scheduling noise, not engine work. Every batch is judged against the
 * same, unchanged budget. Perf project (S58.3, ADR 0038): enforced by `npm run verify` on the dev machine, reported
 * on GitHub Actions.
 */
const SEARCH_BUDGET_MS = 1000;
const GAP_BUDGET_MS = 100;
const BATCHES = 3;
const FILES = 2000;

let tmp: string;
let root: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-search-perf-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  await mkdir(root, { recursive: true });
  const line = '<div class="card 卡片">林小雨的 网页 practice line with some words</div>\n';
  const body = line.repeat(60); // ~4 KB per file, 8 MB in all
  const writes: Promise<void>[] = [];
  for (let i = 0; i < FILES; i += 1) {
    const dir = path.join(root, `栏目 ${i % 20}`, `子 目录 ${i % 7}`);
    writes.push(
      mkdir(dir, { recursive: true }).then(() =>
        writeFile(path.join(dir, `页面 ${i}.html`), i % 10 === 0 ? `${body}<p>needle 针</p>\n` : body),
      ),
    );
  }
  await Promise.all(writes);
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const q = (text: string): SearchQuery => ({ text, regex: false, caseSensitive: false, wholeWord: false });

async function search(query: SearchQuery): Promise<SearchResults> {
  const result = await searchProject(root, 1, query, [], {});
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}

/** One timed search with the event-loop lag probe running beside it. */
async function timed(query: string): Promise<{ results: SearchResults; elapsed: number; maxGap: number }> {
  let maxGap = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 5);
  const started = performance.now();
  try {
    const results = await search(q(query));
    const elapsed = performance.now() - started;
    maxGap = Math.max(maxGap, performance.now() - last);
    return { results, elapsed, maxGap };
  } finally {
    clearInterval(probe);
  }
}

/** The best of up to BATCHES searches: the first batch inside both budgets ends the loop. */
async function bestOf(query: string): Promise<{ results: SearchResults; elapsed: number; maxGap: number }> {
  let best = await timed(query);
  for (let b = 1; b < BATCHES && (best.elapsed > SEARCH_BUDGET_MS || best.maxGap > GAP_BUDGET_MS); b += 1) {
    const next = await timed(query);
    if (next.elapsed + next.maxGap < best.elapsed + best.maxGap) best = next;
  }
  return best;
}

describe('project search timing budget (S51.2)', () => {
  it('2 000 files with Chinese names and spaces: under 1 s, main never blocked for more than 100 ms', async () => {
    const needle = await bestOf('needle 针');
    expect(needle.results.filesSearched).toBe(FILES);
    expect(needle.results.files).toHaveLength(FILES / 10);
    // A common word with thousands of matches is cut at the cap and stays inside the budget too.
    const common = await bestOf('card');
    expect(common.results.truncated).toBe(true);
    if (process.env.NOOBIDE_PERF_PRINT) {
      console.log(
        JSON.stringify({
          needle: { elapsed: needle.elapsed, maxGap: needle.maxGap },
          common: { elapsed: common.elapsed, maxGap: common.maxGap },
        }),
      );
    }
    checkBudget('project search: 2 000 files with Chinese paths, 200 hits', needle.elapsed, SEARCH_BUDGET_MS);
    checkBudget('project search: max event-loop gap during the 2 000-file search', needle.maxGap, GAP_BUDGET_MS);
    checkBudget('project search: 2 000 files, common word cut at the match cap', common.elapsed, SEARCH_BUDGET_MS);
  }, 90_000);
});
