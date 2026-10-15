#!/usr/bin/env node
// Memory breakdown per process (docs/perf/memory.md). Complements scripts/measure-perf.mjs, which records only the
// sum of working sets: a working set counts shared pages (the Electron framework, the dyld cache, GPU surfaces) once
// per process, so the sum overstates what the app really costs the machine. This script reports, per process:
//   - ws:   app.getAppMetrics() workingSetSize (what measure-perf.mjs sums; comparable with older numbers)
//   - fp:   macOS phys_footprint from `footprint` (dirty private memory + compressed + IOKit/GPU memory attributed to
//           the process; the number Activity Monitor shows as "Memory"). Windows: privateBytes from getAppMetrics.
//
//   npm run package
//   node scripts/measure-memory.mjs [--runs 3] [--idle-ms 30000] [--scenario idle,preview,files10]
//
// Scenarios (fresh app-data directory per run, production bundles on the unpackaged binary — Playwright cannot attach
// to the packaged one; scripts/measure-memory.mjs --packaged measures the packaged binary's idle state without
// automation):
//   idle     — welcome screen, editor interactive, then idle
//   preview  — default built-in template open, entry file in the editor, preview running, then idle
//   files10  — a 10-file project (4 HTML, 3 CSS, 3 JS) with all ten files open in tabs and the preview running
// Never prints file contents.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const RUNS = Number(opt('--runs', 3));
const IDLE_MS = Number(opt('--idle-ms', 30_000));
const SCENARIOS = String(opt('--scenario', 'idle,preview,files10')).split(',');
const PACKAGED = argv.includes('--packaged');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sandboxArgs = isRoot ? ['--no-sandbox'] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => Math.round(bytes / 1024 / 1024);

/** macOS phys_footprint in bytes per pid (one `footprint` call for all pids). */
function footprints(pids) {
  if (process.platform !== 'darwin' || pids.length === 0) return new Map();
  const out = execFileSync('footprint', ['-f', 'bytes', '--noCategories', ...pids.flatMap((p) => ['-p', String(p)])], {
    encoding: 'utf8',
  });
  const result = new Map();
  for (const m of out.matchAll(/\[(\d+)\]:.*?Footprint: (\d+) B/g)) result.set(Number(m[1]), Number(m[2]));
  return result;
}

async function sample(app) {
  const metrics = await app.evaluate(({ app: electronApp, webContents }) => {
    const hooks = globalThis.__noobideTestHooks;
    const previewId = hooks.preview().previewWebContentsId;
    const roles = new Map();
    for (const wc of webContents.getAllWebContents()) {
      const pid = wc.getOSProcessId();
      roles.set(pid, wc.id === previewId ? 'preview' : wc.getURL().startsWith('noobide') ? 'workbench' : 'renderer');
    }
    return electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.serviceName ?? m.name ?? '',
      role: roles.get(m.pid),
      wsKb: m.memory.workingSetSize,
      privKb: m.memory.privateBytes ?? null,
    }));
  });
  const fp = footprints(metrics.map((m) => m.pid));
  return metrics.map((m) => ({
    label: labelOf(m),
    ws: Math.round(m.wsKb / 1024),
    fp: fp.has(m.pid) ? mb(fp.get(m.pid)) : m.privKb === null ? null : Math.round(m.privKb / 1024),
  }));
}

function labelOf(m) {
  if (m.type === 'Browser') return 'main';
  if (m.type === 'GPU') return 'gpu';
  if (m.type === 'Tab') return m.role ?? 'renderer';
  if (m.type === 'Utility') return `utility:${m.name.replace(/^.*\./, '')}`;
  return m.type.toLowerCase();
}

async function launch(userDataDir) {
  if (!existsSync(path.join(root, '.vite', 'build', 'main.cjs'))) throw new Error('run npm run package first');
  return electron.launch({ args: [...sandboxArgs, `--user-data-dir=${userDataDir}`, '.'], cwd: root });
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

async function openFile(page, name) {
  await page.getByTestId('file-tree').getByRole('treeitem', { name, exact: true }).click();
  await page.getByTestId('tab-bar').getByRole('tab', { name }).and(page.locator('[aria-selected="true"]')).waitFor();
}

async function startPreview(page) {
  const start = page.getByTestId('preview-start');
  await start.click();
  const trust = page.getByTestId('preview-trust-confirm');
  if (await trust.isVisible().catch(() => false)) await trust.click();
  await page.locator('[data-testid="preview-state"][data-state="running"]').waitFor({ timeout: 30_000 });
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

/** Ten small-to-medium files at the project root: index.html + 3 pages, 3 stylesheets, 3 scripts. */
async function writeTenFiles(target) {
  await mkdir(target, { recursive: true });
  const names = [];
  const css = (i) =>
    Array.from(
      { length: 150 },
      (_, n) => `.c${i}-${n} { margin: ${n % 9}px; color: rgb(${n % 255}, 90, 140); }\n`,
    ).join('');
  const js = (i) =>
    Array.from(
      { length: 120 },
      (_, n) =>
        `function f${i}_${n}(a, b) {\n  const total = a + b * ${n};\n  return total > 10 ? total : -total;\n}\n`,
    ).join('');
  const html = (i) =>
    `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>页面 ${i}</title>\n` +
    `<link rel="stylesheet" href="style-0.css">\n<link rel="stylesheet" href="style-1.css">\n<link rel="stylesheet" href="style-2.css">\n</head>\n<body>\n` +
    Array.from(
      { length: 60 },
      (_, n) => `<section class="c0-${n}"><h2>标题 ${n}</h2><p>段落 ${n}</p></section>\n`,
    ).join('') +
    `<script src="script-0.js"></script>\n<script src="script-1.js"></script>\n<script src="script-2.js"></script>\n</body>\n</html>\n`;
  for (let i = 0; i < 4; i += 1) {
    const name = i === 0 ? 'index.html' : `page-${i}.html`;
    await writeFile(path.join(target, name), html(i));
    names.push(name);
  }
  for (let i = 0; i < 3; i += 1) {
    await writeFile(path.join(target, `style-${i}.css`), css(i));
    names.push(`style-${i}.css`);
  }
  for (let i = 0; i < 3; i += 1) {
    await writeFile(path.join(target, `script-${i}.js`), js(i));
    names.push(`script-${i}.js`);
  }
  return names;
}

function packagedExecutable() {
  const out = path.join(root, 'out');
  const dir =
    existsSync(out) && readdirSync(out).find((d) => d.startsWith(`NoobIDE-${process.platform}-${process.arch}`));
  if (!dir) throw new Error('run npm run package first');
  const base = path.join(out, dir);
  if (process.platform === 'darwin') {
    const macos = path.join(base, 'NoobIDE.app', 'Contents', 'MacOS');
    return path.join(macos, readdirSync(macos)[0]);
  }
  return path.join(base, 'noobide.exe');
}

/** Packaged binary, welcome screen, no automation attached: all descendant pids' footprints after the idle period. */
async function packagedIdle(userData) {
  const child = spawn(packagedExecutable(), [...sandboxArgs, `--user-data-dir=${userData}`], { stdio: 'ignore' });
  await sleep(IDLE_MS);
  const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' });
  const rows = ps
    .trim()
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), cmd: m[4] }));
  const tree = new Set([child.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows)
      if (!tree.has(r.pid) && tree.has(r.ppid)) {
        tree.add(r.pid);
        changed = true;
      }
  }
  const procs = rows.filter((r) => tree.has(r.pid));
  const fp = footprints(procs.map((p) => p.pid));
  const result = procs.map((p) => {
    const type = p.cmd.match(/--type=(\S+)/)?.[1] ?? 'main';
    const svc = p.cmd.match(/--utility-sub-type=(\S+)/)?.[1]?.replace(/^.*\./, '');
    return {
      label: svc ? `utility:${svc}` : type === 'renderer' ? 'workbench' : type === 'gpu-process' ? 'gpu' : type,
      ws: Math.round(p.rssKb / 1024),
      fp: mb(fp.get(p.pid) ?? 0),
    };
  });
  child.kill();
  await new Promise((r) => child.once('exit', r));
  return result;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'noobide-mem-'));
const samples = {}; // scenario -> array of per-process rows
try {
  for (let run = 0; run < RUNS; run += 1) {
    if (PACKAGED) {
      const userData = mkdtempSync(path.join(tmp, 'ud-'));
      (samples.packagedIdle ??= []).push(await packagedIdle(userData));
      continue;
    }
    for (const scenario of SCENARIOS) {
      const userData = mkdtempSync(path.join(tmp, 'ud-'));
      const app = await launch(userData);
      try {
        const page = await app.firstWindow();
        await editorInteractive(page);
        if (scenario === 'preview') {
          const dir = path.join(tmp, `run${run}`, '个人介绍 练习');
          const tpl = await copyDefaultTemplate(dir);
          await openFolder(app, page, dir);
          await openFile(page, tpl.entry);
          await startPreview(page);
        } else if (scenario === 'files10') {
          const dir = path.join(tmp, `run${run}`, '十个 文件');
          const names = await writeTenFiles(dir);
          await openFolder(app, page, dir);
          for (const name of names) await openFile(page, name);
          await startPreview(page);
        }
        await sleep(IDLE_MS);
        (samples[scenario] ??= []).push(await sample(app));
      } finally {
        await app.close();
      }
      process.stderr.write(`run ${run + 1}/${RUNS} ${scenario}: done\n`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)];
};
const report = {};
for (const [scenario, runs] of Object.entries(samples)) {
  const totalsWs = runs.map((r) => r.reduce((s, p) => s + p.ws, 0));
  const totalsFp = runs.map((r) => r.reduce((s, p) => s + (p.fp ?? 0), 0));
  const labels = [...new Set(runs.flatMap((r) => r.map((p) => p.label)))];
  const perProcess = {};
  for (const label of labels) {
    const of = (key) =>
      median(runs.map((r) => r.filter((p) => p.label === label).reduce((s, p) => s + (p[key] ?? 0), 0)));
    perProcess[label] = { ws: of('ws'), fp: of('fp') };
  }
  report[scenario] = {
    totalWs: { median: median(totalsWs), samples: totalsWs },
    totalFp: { median: median(totalsFp), samples: totalsFp },
    perProcess,
    runs: runs.map((r) => r.map((p) => `${p.label}:${p.ws}/${p.fp}`).join(' ')),
  };
}
console.log(
  JSON.stringify({ platform: `${process.platform}-${process.arch}`, idleMs: IDLE_MS, runs: RUNS, report }, null, 2),
);
