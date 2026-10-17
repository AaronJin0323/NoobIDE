// S58.6 — the E2E job summary: after every Playwright run, scripts/e2e.mjs appends the 10 slowest spec files and
// the shard total from reports/e2e/results.json to $GITHUB_STEP_SUMMARY (plan §4 S58.6 item 2). The formatter is
// pure so tests/integration/ci-timings.test.ts can check it on a saved report.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { formatDuration, slowestSpecFiles } from './ci-timings-parse.mjs';

/** Markdown for the job summary: heading with totals, then a table of the slowest files. */
export function formatStepSummary(results, { shard = null, limit = 10 } = {}) {
  const stats = results?.stats ?? {};
  const shardLabel =
    shard ?? (results?.config?.shard ? `${results.config.shard.current}/${results.config.shard.total}` : null);
  const files = slowestSpecFiles(results, limit);
  const testedMs = slowestSpecFiles(results, Number.MAX_SAFE_INTEGER).reduce((sum, f) => sum + f.ms, 0);
  const wall = typeof stats.duration === 'number' ? formatDuration(stats.duration / 1000) : '–';
  const lines = [
    `### E2E${shardLabel ? ` shard ${shardLabel}` : ''}: ${stats.expected ?? 0} passed, ${stats.unexpected ?? 0} failed, ${stats.flaky ?? 0} flaky, ${stats.skipped ?? 0} skipped`,
    '',
    `Playwright wall-clock **${wall}**; test time ${formatDuration(testedMs / 1000)} across ${slowestSpecFiles(results, Number.MAX_SAFE_INTEGER).length} spec files.`,
    '',
    `| Slowest spec files (${files.length}) | Tests | Time |`,
    '| --- | ---: | ---: |',
    ...files.map((f) => `| \`${f.file}\` | ${f.tests} | ${formatDuration(f.ms / 1000)} |`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Append the summary for `resultsPath` to the file named by `summaryPath` (GITHUB_STEP_SUMMARY). Never throws:
 * a missing or unreadable report must not change the Playwright exit status.
 */
export function appendStepSummary(resultsPath, summaryPath, { shard = null } = {}) {
  if (!summaryPath || !resultsPath || !existsSync(resultsPath)) return false;
  try {
    const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
    appendFileSync(summaryPath, `${formatStepSummary(results, { shard })}\n`);
    return true;
  } catch (e) {
    process.stderr.write(`e2e summary not written: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}
