#!/usr/bin/env node
// S05.6 baseline measurements (PLAN §11): cold start to editor-interactive and idle memory of all app processes.
//
//   npm run package                       # builds the production bundles in .vite/ (and out/)
//   node scripts/measure-baseline.mjs     # 10 samples; --runs N
//
// What is measured: the production renderer/main bundles (.vite/build, the same code that is packaged) run by the
// unpackaged Electron binary from node_modules. The packaged executable cannot be driven by Playwright because the
// EnableNodeCliInspectArguments fuse is off (forge.config.ts) — on purpose. Packaged numbers therefore differ by
// asar loading and code signing checks; see docs/perf/baseline.md.
//
// "Editor-interactive": time from spawning the app until Monaco is rendered AND a typed character appears in it.
// Every sample uses a fresh, empty app-data directory (like a first launch). The OS file cache is warm after the
// first sample; sample 1 is reported separately. Memory is the sum of app.getAppMetrics() working sets (all
// processes: main, GPU, utility, workbench renderer, preview renderer) after 10 s idle, without DevTools, measured
// (a) with no project open and (b) with the multi-file fixture open and its preview running.
// Prints a JSON result and a Markdown summary for docs/perf/baseline.md. Never prints file contents.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const runs = Number(argv[argv.indexOf('--runs') + 1]) || 10;
const IDLE_MS = 10_000;

async function launch(userDataDir) {
  if (!existsSync(path.join(root, '.vite', 'build', 'main.cjs'))) throw new Error('run npm run package first');
  return electron.launch({ args: [`--user-data-dir=${userDataDir}`, '.'], cwd: root });
}

async function memoryMb(app) {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })),
  );
  const total = metrics.reduce((sum, m) => sum + m.kb, 0) / 1024;
  return { totalMb: Math.round(total), processes: metrics.map((m) => `${m.type}:${Math.round(m.kb / 1024)}`) };
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

const startups = [];
const idleNoProject = [];
const idleWithPreview = [];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'noobide-measure-'));
const project = path.join(tmp, '网页 练习', '预览 多文件');
// fs.cpSync crashes Node 22 on Windows with this non-ASCII path (segfault); the async cp works.
await cp(path.join(root, 'tests', 'fixtures', '预览 多文件'), project, { recursive: true });

try {
  for (let i = 0; i < runs; i += 1) {
    const userData = mkdtempSync(path.join(tmp, 'userdata-'));
    const started = performance.now();
    const app = await launch(userData);
    const page = await app.firstWindow();
    const lines = page.locator('.monaco-editor .view-lines');
    await lines.waitFor({ timeout: 60_000 });
    await lines.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type('Z');
    await page.locator('.monaco-editor .view-lines', { hasText: 'Z' }).waitFor();
    startups.push(Math.round(performance.now() - started));

    if (i < 3) {
      await page.waitForTimeout(IDLE_MS);
      idleNoProject.push(await memoryMb(app));
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      }, project);
      await page.getByTestId('open-folder').click();
      await page.getByTestId('preview-start').click();
      await page.locator('[data-testid="preview-state"][data-state="running"]').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(IDLE_MS);
      idleWithPreview.push(await memoryMb(app));
    }
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const result = {
  date: new Date().toISOString(),
  build: 'production bundles (.vite) on unpackaged Electron',
  platform: `${process.platform}-${process.arch}`,
  os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model.trim(),
  cores: os.cpus().length,
  ramGb: Math.round(os.totalmem() / 1024 ** 3),
  startupMs: { samples: startups, firstSample: startups[0], ...stats(startups) },
  idleMemoryNoProjectMb: {
    samples: idleNoProject.map((m) => m.totalMb),
    ...stats(idleNoProject.map((m) => m.totalMb)),
  },
  idleMemoryWithPreviewMb: {
    samples: idleWithPreview.map((m) => m.totalMb),
    ...stats(idleWithPreview.map((m) => m.totalMb)),
  },
  processBreakdownMb: { noProject: idleNoProject[0]?.processes, withPreview: idleWithPreview[0]?.processes },
};
console.log(JSON.stringify(result, null, 2));
const s = result.startupMs;
console.log(`
| Platform | Device | Build | Cold start → editor-interactive (ms) | Idle memory, no project (MB) | Idle memory, preview running (MB) |
| --- | --- | --- | --- | --- | --- |
| ${result.platform}, ${result.os} | ${result.cpu}, ${result.cores} threads, ${result.ramGb} GB | ${result.build} | median ${s.median}, p95 ${s.p95}, min ${s.min}, max ${s.max}, first ${s.firstSample} (n=${s.n}) | median ${result.idleMemoryNoProjectMb.median} (n=${result.idleMemoryNoProjectMb.n}) | median ${result.idleMemoryWithPreviewMb.median} (n=${result.idleMemoryWithPreviewMb.n}) |`);
