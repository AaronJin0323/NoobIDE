import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
interface Suite {
  suites?: Suite[];
  specs?: { id: string; file: string }[];
}

function collect(suite: Suite): string[] {
  return [...(suite.specs ?? []).map((s) => `${s.file}:${s.id}`), ...(suite.suites ?? []).flatMap(collect)];
}

function list(shard?: string): string[] {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'noobide-shard-list-'));
  const report = path.join(temporary, 'report.json');
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '-c',
        'tests/e2e/playwright.config.ts',
        '--list',
        '--reporter=json',
        ...(shard ? [`--shard=${shard}`] : []),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: report },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return collect(JSON.parse(readFileSync(report, 'utf8')) as Suite);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

it('two real Playwright shard selections cover every E2E test exactly once', () => {
  const all = list();
  const first = list('1/2');
  const second = list('2/2');
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  // Keep the CPU-load startup test separate from the long preview isolation/flood suite.
  expect(first.some((id) => id.includes('app-startup-restore.spec.ts'))).toBe(true);
  expect(second.some((id) => id.includes('preview-isolation.spec.ts'))).toBe(true);
  expect(new Set([...first, ...second]).size).toBe(first.length + second.length);
  expect([...first, ...second].sort()).toEqual(all.sort());
}, 360_000);
