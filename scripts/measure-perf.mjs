#!/usr/bin/env node
// S27.1 performance measurements against PLAN §11, per platform. Supersedes the S05.6 baseline script for new runs
// (scripts/measure-baseline.mjs stays as the record of how docs/perf/baseline.md was produced).
//
//   npm run package                         # production bundles in .vite/ and the packaged app in out/
//   node scripts/measure-perf.mjs           # prints JSON + Markdown
//   node scripts/measure-perf.mjs --write   # also writes docs/perf/<platform>-<arch>.md (e.g. darwin-arm64.md)
//
// Options: --runs N (cold starts, default 20), --edits N (save→preview samples, default 20), --memory-runs N
// (default 3), --idle-ms N (default 30000), --no-packaged (skip the packaged-binary start measurement).
//
// What is measured (definitions repeated in the written document):
//  1. Cold start → editor-interactive (PLAN §11, p95 ≤ 5 s): spawn the app until Monaco is rendered AND a typed
//     character appears in it. Fresh, empty app-data directory per sample (a first launch). Production bundles
//     (.vite) on the unpackaged Electron binary, because Playwright cannot attach to the packaged binary (the
//     EnableNodeCliInspectArguments fuse is off on purpose).
//  2. Packaged cold start: the shipped executable in out/ is spawned with the built-in self-test (NOOBIDE_SELF_TEST=1),
//     which reports the wall-clock times at which the workbench's Monaco editor was rendered and the HTML/CSS/JS
//     workers first answered (src/renderer/editor/self-test-run.ts). Includes asar loading and the OS signature
//     checks, but no keystroke (no automation can attach). Fresh app-data directory per sample.
//  3. Update after saving (PLAN §11, p95 ≤ 1 s): a generated 50-file project (scripts/perf-fixture.mjs: every file
//     ≤ 200 KB, local resources only, 40 resources per page load) is open with its preview running. Each sample puts
//     a new heading into index.html, presses Ctrl/Cmd+S, and reads the preview page's own Navigation Timing: the
//     latency is (timeOrigin + loadEventEnd) − the wall-clock time just before the key press. It therefore includes
//     the save itself (an upper bound for "completed save → updated page") and the load of all 40 resources.
//  4. Memory (PLAN §11, ~700 MB budget): sum of app.getAppMetrics() working sets over all processes after an idle
//     period (30 s), no DevTools — (a) no project open, (b) "typical": the default built-in template (personal-intro)
//     open in the editor with its preview running. Also the sum of private memory (macOS phys_footprint, Windows
//     privateBytes): working sets count shared pages once per process, so their sum overstates the real cost
//     (docs/perf/memory.md). Per-process detail: scripts/measure-memory.mjs.
// Never prints file contents.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import * as prettier from 'prettier';
import { perfFixtureIndex, writePerfFixture } from './perf-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function option(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) || fallback : fallback;
}
const RUNS = option('--runs', 20);
const EDITS = option('--edits', 20);
const MEMORY_RUNS = option('--memory-runs', 3);
const IDLE_MS = option('--idle-ms', 30_000);
const WRITE = argv.includes('--write');
const PACKAGED = !argv.includes('--no-packaged');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sandboxArgs = isRoot ? ['--no-sandbox'] : [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile: with n = 20, p95 is the 19th value (only the slowest sample is above it).
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

async function launch(userDataDir) {
  if (!existsSync(path.join(root, '.vite', 'build', 'main.cjs'))) throw new Error('run npm run package first');
  return electron.launch({ args: [...sandboxArgs, `--user-data-dir=${userDataDir}`, '.'], cwd: root });
}

/** macOS phys_footprint (bytes) per pid: private dirty + compressed + GPU memory attributed to the process. */
function footprints(pids) {
  if (process.platform !== 'darwin' || pids.length === 0) return new Map();
  const out = execFileSync('footprint', ['-f', 'bytes', '--noCategories', ...pids.flatMap((p) => ['-p', String(p)])], {
    encoding: 'utf8',
  });
  return new Map([...out.matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)].map((m) => [Number(m[1]), Number(m[2])]));
}

async function memoryMb(app) {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      kb: m.memory.workingSetSize,
      privateKb: m.memory.privateBytes ?? null,
    })),
  );
  const total = metrics.reduce((sum, m) => sum + m.kb, 0) / 1024;
  // Private memory: macOS footprint, Windows privateBytes. Shared pages (the Electron framework, mapped once but
  // counted in every process's working set) are not in it, so it is the better estimate of what the app costs.
  const fp = footprints(metrics.map((m) => m.pid));
  const privateMb = metrics.map((m) =>
    fp.has(m.pid) ? fp.get(m.pid) / 1048576 : m.privateKb === null ? null : m.privateKb / 1024,
  );
  const privateTotal = privateMb.every((v) => v !== null) ? Math.round(privateMb.reduce((a, b) => a + b, 0)) : null;
  return {
    totalMb: Math.round(total),
    privateMb: privateTotal,
    processes: metrics.map(
      (m, i) => `${m.type}:${Math.round(m.kb / 1024)}/${privateMb[i] === null ? '?' : Math.round(privateMb[i])}`,
    ),
  };
}

async function editorInteractive(page) {
  const lines = page.locator('.monaco-editor .view-lines');
  await lines.waitFor({ timeout: 60_000 });
  await lines.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Z');
  await page.locator('.monaco-editor .view-lines', { hasText: 'Z' }).waitFor();
}

async function openFolder(app, page, folder) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
  const first = page.getByTestId('open-folder');
  await ((await first.count()) > 0 ? first : page.getByTestId('open-other-folder')).click();
  await page
    .getByTestId('project-name')
    .filter({ hasText: path.basename(folder) })
    .waitFor();
}

async function startPreview(page) {
  await page.getByTestId('preview-start').click();
  await page.locator('[data-testid="preview-state"][data-state="running"]').waitFor({ timeout: 30_000 });
}

function previewEval(app, js) {
  return app.evaluate(({ webContents }, code) => {
    const hooks = globalThis.__noobideTestHooks;
    const id = hooks.preview().previewWebContentsId;
    const wc = id === null ? undefined : webContents.fromId(id);
    return wc ? wc.executeJavaScript(code, true) : null;
  }, js);
}

async function openFile(page, name) {
  await page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true }).click();
  await page.getByTestId('tab-bar').getByRole('tab', { name }).and(page.locator('[aria-selected="true"]')).waitFor();
}

async function replaceEditorText(app, page, text) {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+V');
}

async function copyDefaultTemplate(target) {
  const dir = path.join(root, 'resources', 'templates');
  for (const id of readdirSync(dir)) {
    const manifestPath = path.join(dir, id, 'template.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!manifest.default) continue;
    for (const rel of manifest.files) {
      const to = path.join(target, ...rel.split('/'));
      await mkdir(path.dirname(to), { recursive: true });
      await cp(path.join(dir, id, ...rel.split('/')), to);
    }
    return { id, entry: manifest.entry };
  }
  throw new Error('no default template');
}

function packagedExecutable() {
  const out = path.join(root, 'out');
  if (!existsSync(out)) return undefined;
  const dir = readdirSync(out).find((d) => d.startsWith(`NoobIDE-${process.platform}-${process.arch}`));
  if (!dir) return undefined;
  const base = path.join(out, dir);
  if (process.platform === 'darwin') {
    const macos = path.join(base, 'NoobIDE.app', 'Contents', 'MacOS');
    const bin = existsSync(macos) ? readdirSync(macos)[0] : undefined;
    return bin ? path.join(macos, bin) : undefined;
  }
  return path.join(base, process.platform === 'win32' ? 'noobide.exe' : 'noobide');
}

function packagedStart(exe, userDataDir) {
  return new Promise((resolve, reject) => {
    const spawnedAt = Date.now();
    const child = spawn(exe, [...sandboxArgs, `--user-data-dir=${userDataDir}`], {
      env: { ...process.env, NOOBIDE_SELF_TEST: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('NOOBIDE_SELFTEST '));
      const startup = line ? JSON.parse(line.slice('NOOBIDE_SELFTEST '.length)).startup : undefined;
      if (code !== 0 || !startup || startup.editorShownAt === null) {
        reject(new Error(`packaged self-test exited with ${code} (no start-up times)`));
        return;
      }
      resolve({
        editorShown: startup.editorShownAt - spawnedAt,
        workersAnswered: startup.workersAnsweredAt - spawnedAt,
      });
    });
  });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'noobide-perf-'));
const result = {
  date: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model.trim(),
  cores: os.cpus().length,
  ramGb: Math.round(os.totalmem() / 1024 ** 3),
  electron: JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version,
};

try {
  // 1. Cold start (unpackaged Electron, production bundles).
  const startups = [];
  for (let i = 0; i < RUNS; i += 1) {
    const userData = mkdtempSync(path.join(tmp, 'userdata-'));
    const started = performance.now();
    const app = await launch(userData);
    const page = await app.firstWindow();
    await editorInteractive(page);
    startups.push(Math.round(performance.now() - started));
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    process.stderr.write(`cold start ${i + 1}/${RUNS}: ${startups.at(-1)} ms\n`);
  }
  result.coldStartMs = { samples: startups, firstSample: startups[0], ...stats(startups) };

  // 2. Packaged binary: spawn → self-test result (editor up and language workers answered).
  const exe = PACKAGED ? packagedExecutable() : undefined;
  if (exe) {
    const shown = [];
    const answered = [];
    for (let i = 0; i < RUNS; i += 1) {
      const userData = mkdtempSync(path.join(tmp, 'userdata-pkg-'));
      const t = await packagedStart(exe, userData);
      shown.push(t.editorShown);
      answered.push(t.workersAnswered);
      rmSync(userData, { recursive: true, force: true });
      process.stderr.write(
        `packaged start ${i + 1}/${RUNS}: editor ${t.editorShown} ms, workers ${t.workersAnswered} ms\n`,
      );
    }
    result.packagedStartToEditorShownMs = { samples: shown, firstSample: shown[0], ...stats(shown) };
    result.packagedStartToWorkersMs = { samples: answered, firstSample: answered[0], ...stats(answered) };
  }

  // 3. Save → preview updated, 50-file project.
  const project = path.join(tmp, '性能 测试', '五十 个文件');
  result.saveToPreviewFixture = await writePerfFixture(project);
  {
    const userData = mkdtempSync(path.join(tmp, 'userdata-save-'));
    const app = await launch(userData);
    const page = await app.firstWindow();
    await editorInteractive(page);
    await openFolder(app, page, project);
    await startPreview(page);
    await openFile(page, 'index.html');
    const latencies = [];
    const toDomContentLoaded = [];
    const WARMUP = 2;
    for (let i = 1; i <= EDITS + WARMUP; i += 1) {
      const title = `T${i}`;
      await replaceEditorText(app, page, perfFixtureIndex(title));
      await page.getByTestId('save-status').and(page.locator('.save-dirty')).waitFor();
      const before = Date.now();
      await page.keyboard.press('ControlOrMeta+S');
      let timing = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        timing = await previewEval(
          app,
          `(() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const done = document.getElementById('title')?.textContent === ${JSON.stringify(title)} &&
              document.readyState === 'complete' && nav && nav.loadEventEnd > 0;
            return done ? { load: performance.timeOrigin + nav.loadEventEnd,
              dcl: performance.timeOrigin + nav.domContentLoadedEventEnd,
              resources: performance.getEntriesByType('resource').length } : null;
          })()`,
        );
        if (timing) break;
        await sleep(5);
      }
      if (!timing) throw new Error(`preview did not show edit ${i} within 10 s`);
      if (i > WARMUP) {
        latencies.push(Math.round(timing.load - before));
        toDomContentLoaded.push(Math.round(timing.dcl - before));
        result.saveToPreviewResourcesPerLoad = timing.resources;
      }
      process.stderr.write(`save → preview ${i}/${EDITS + WARMUP}: ${Math.round(timing.load - before)} ms\n`);
      await page.getByTestId('save-status').and(page.locator('.save-saved, .save-clean')).waitFor();
    }
    result.saveToPreviewLoadMs = { samples: latencies, ...stats(latencies) };
    result.saveToPreviewDomContentLoadedMs = { samples: toDomContentLoaded, ...stats(toDomContentLoaded) };
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }

  // 4. Memory: idle without a project, and the default template open with its preview running.
  const template = path.join(tmp, '我的 网页', '个人介绍 练习');
  const tpl = await copyDefaultTemplate(template);
  result.typicalProject = `built-in template "${tpl.id}" (entry ${tpl.entry}), preview running`;
  const idleNoProject = [];
  const idleTypical = [];
  for (let i = 0; i < MEMORY_RUNS; i += 1) {
    const userData = mkdtempSync(path.join(tmp, 'userdata-mem-'));
    const app = await launch(userData);
    const page = await app.firstWindow();
    await editorInteractive(page);
    await sleep(IDLE_MS);
    idleNoProject.push(await memoryMb(app));
    await openFolder(app, page, template);
    await openFile(page, tpl.entry);
    await startPreview(page);
    await sleep(IDLE_MS);
    idleTypical.push(await memoryMb(app));
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    process.stderr.write(
      `memory ${i + 1}/${MEMORY_RUNS}: ${idleNoProject.at(-1).totalMb} / ${idleTypical.at(-1).totalMb} MB\n`,
    );
  }
  result.memoryIdleNoProjectMb = {
    samples: idleNoProject.map((m) => m.totalMb),
    ...stats(idleNoProject.map((m) => m.totalMb)),
  };
  result.memoryTypicalMb = { samples: idleTypical.map((m) => m.totalMb), ...stats(idleTypical.map((m) => m.totalMb)) };
  const privateOf = (list) => list.map((m) => m.privateMb);
  if (idleNoProject.every((m) => m.privateMb !== null)) {
    result.memoryPrivateIdleNoProjectMb = { samples: privateOf(idleNoProject), ...stats(privateOf(idleNoProject)) };
    result.memoryPrivateTypicalMb = { samples: privateOf(idleTypical), ...stats(privateOf(idleTypical)) };
  }
  result.memoryBreakdownMb = { noProject: idleNoProject[0]?.processes, typical: idleTypical[0]?.processes };
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const ok = (value, limit) => (value <= limit ? 'within target' : '**target missed**');
const fmt = (s) => `median ${s.median}, p95 ${s.p95}, min ${s.min}, max ${s.max} (n=${s.n})`;
const c = result.coldStartMs;
const p = result.packagedStartToEditorShownMs;
const pw = result.packagedStartToWorkersMs;
const s = result.saveToPreviewLoadMs;
const m1 = result.memoryIdleNoProjectMb;
const m2 = result.memoryTypicalMb;
const mp1 = result.memoryPrivateIdleNoProjectMb;
const mp2 = result.memoryPrivateTypicalMb;
const markdown = `# Performance — ${result.platform} (S27.1)

Generated by \`node scripts/measure-perf.mjs --write\` on ${result.date.slice(0, 10)}. Definitions are in the header of
\`scripts/measure-perf.mjs\`. PLAN §11 targets: cold start p95 ≤ 5 s to an interactive editor on a fixed 8 GB reference
machine; update after saving p95 ≤ 1 s for ≤ 50 files of ≤ 200 KB; memory recorded per platform against a ~700 MB
budget (a baseline, not a claim). "Within target" below applies to THIS device only; PLAN §11 claims need the fixed
8 GB reference machine of each platform (see docs/perf/targets.md).

**Device:** ${result.cpu}, ${result.cores} cores, ${result.ramGb} GB RAM — ${result.os} (${result.platform}), Electron ${result.electron}.

| Metric | Result (ms / MB) | PLAN §11 target | On this device |
| --- | --- | --- | --- |
| Cold start → editor-interactive (production bundles, unpackaged Electron) | ${fmt(c)}; first ${c.firstSample} | p95 ≤ 5000 ms | ${ok(c.p95, 5000)} |
${p ? `| Packaged app start → workbench editor rendered (no keystroke) | ${fmt(p)}; first ${p.firstSample} | p95 ≤ 5000 ms | ${ok(p.p95, 5000)} |\n| Packaged app start → HTML/CSS/JS workers answered | ${fmt(pw)}; first ${pw.firstSample} | — | — |\n` : ''}| Ctrl/Cmd+S → preview page fully loaded (50 files, ${result.saveToPreviewFixture.totalBytes} bytes, ${result.saveToPreviewResourcesPerLoad} resources per load) | ${fmt(s)} | p95 ≤ 1000 ms | ${ok(s.p95, 1000)} |
| … same, to DOMContentLoaded | ${fmt(result.saveToPreviewDomContentLoadedMs)} | — | — |
| Memory, idle, no project (all processes) | ${fmt(m1)} | ~700 MB budget | ${ok(m1.max, 700)} |
| Memory, typical: ${result.typicalProject} | ${fmt(m2)} | ~700 MB budget | ${ok(m2.max, 700)} |
${mp1 ? `| … private memory (${process.platform === 'darwin' ? 'phys_footprint' : 'privateBytes'}), idle, no project | ${fmt(mp1)} | — | — |\n| … private memory, typical | ${fmt(mp2)} | — | — |\n` : ''}
Memory rows: the budget is compared with the sum of working sets after ${IDLE_MS / 1000} s idle (as in S05.6). Working sets
count shared pages (the Electron framework) once per process; private memory does not, and is the closer estimate of
what the app costs the machine (docs/perf/memory.md).

Process breakdown of the first memory sample (MB, working set/private): no project —
${result.memoryBreakdownMb.noProject?.join(', ')}; typical — ${result.memoryBreakdownMb.typical?.join(', ')}.

Raw samples (ms): cold start ${c.samples.join(', ')}${p ? `; packaged ${p.samples.join(', ')}` : ''}; save → preview
${s.samples.join(', ')}.
`;
console.log(JSON.stringify(result, null, 2));
console.log(`\n${markdown}`);
if (WRITE) {
  const file = path.join(root, 'docs', 'perf', `${result.platform}.md`);
  // Formatted like the rest of docs/ so `npm run verify` (prettier --check) stays green.
  const options = (await prettier.resolveConfig(file)) ?? {};
  await writeFile(file, await prettier.format(markdown, { ...options, filepath: file }));
  console.log(`written: ${path.relative(root, file)}`);
}
