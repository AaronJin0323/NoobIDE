// S27.1: the PLAN §11 "update after saving" project — exactly 50 files, each ≤ 200 KB, local resources only.
// Generated (deterministically) instead of committed, so the repository does not carry ~1.5 MB of filler.
//
//   import { writePerfFixture } from './perf-fixture.mjs';
//   const summary = await writePerfFixture('/tmp/x/性能 50 文件');   // { files, totalBytes, largestBytes }
//
// Layout (50 files): index.html (the page the measurement edits) loads 10 stylesheets, 10 classic scripts,
// 5 ES modules, 10 SVG images and fetches 4 JSON files, so one refresh requests 40 local resources (main.js + 5 modules); 10 more pages
// link back to it. Four files are near the 200 KB limit (2 CSS, 1 script, 1 JSON) so the big-file case is covered.
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PERF_FIXTURE_FILES = 50;
export const PERF_FIXTURE_MAX_BYTES = 200 * 1024;
const NEAR_LIMIT = 190 * 1024;

function pad(text, bytes, line) {
  let out = text;
  let i = 0;
  while (Buffer.byteLength(out) + Buffer.byteLength(line(i)) < bytes) {
    out += line(i);
    i += 1;
  }
  return out;
}

/** Returns a map of relative path ('/'-separated) → file content for the fixture. */
export function perfFixtureFiles(title = 'T0') {
  const files = new Map();
  const css = [];
  const scripts = [];
  for (let i = 0; i < 10; i += 1) {
    const name = `css/part-${i}.css`;
    const base = `.box-${i} { color: rgb(${i * 20}, 80, 120); margin: ${i}px; }\n`;
    files.set(
      name,
      i < 2 ? pad(base, NEAR_LIMIT, (n) => `.filler-${i}-${n} { padding: ${n % 13}px; }\n`) : base.repeat(20),
    );
    css.push(name);
  }
  for (let i = 0; i < 10; i += 1) {
    const name = `js/classic-${i}.js`;
    const base = `window.loaded${i} = true;\n`;
    files.set(
      name,
      i === 0 ? pad(base, NEAR_LIMIT, (n) => `function filler${n}(x) { return x * ${n % 97} + 1; }\n`) : base,
    );
    scripts.push(name);
  }
  for (let i = 0; i < 5; i += 1) {
    const next = i < 4 ? `import './mod-${i + 1}.mjs';\n` : '';
    files.set(`js/mod-${i}.mjs`, `${next}export const value${i} = ${i};\n`);
  }
  files.set('js/main.js', `import './mod-0.mjs';\ndocument.body.dataset.module = 'ok';\n`);
  for (let i = 0; i < 10; i += 1) {
    files.set(
      `images/icon-${i}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#${(i * 111111).toString(16).padStart(6, '0').slice(0, 6)}"/></svg>\n`,
    );
  }
  for (let i = 0; i < 4; i += 1) {
    const rows = i === 0 ? 2600 : 20;
    files.set(
      `data/data-${i}.json`,
      JSON.stringify(
        Array.from({ length: rows }, (_, n) => ({ id: n, name: `item ${n}`, value: n * 3 })),
        null,
        1,
      ),
    );
  }
  for (let i = 0; i < 9; i += 1) {
    files.set(
      `pages/page-${i}.html`,
      `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8" /><title>页面 ${i}</title>` +
        `<link rel="stylesheet" href="../css/part-${i}.css" /></head>` +
        `<body><p class="box-${i}">页面 ${i}</p><a href="../index.html">返回</a></body></html>\n`,
    );
  }
  const head = [
    ...css.map((c) => `    <link rel="stylesheet" href="${c}" />`),
    `    <script type="module" src="js/main.js"></script>`,
  ].join('\n');
  const body = [
    ...Array.from(
      { length: 10 },
      (_, i) => `    <img src="images/icon-${i}.svg" alt="图标 ${i}" width="16" height="16" />`,
    ),
    ...Array.from({ length: 9 }, (_, i) => `    <a href="pages/page-${i}.html">页面 ${i}</a>`),
    ...scripts.map((s) => `    <script src="${s}"></script>`),
    `    <script>`,
    `      Promise.all([0, 1, 2, 3].map((i) => fetch('data/data-' + i + '.json').then((r) => r.json())))`,
    `        .then(() => { document.body.dataset.data = 'ok'; });`,
    `    </script>`,
  ].join('\n');
  files.set(
    'index.html',
    `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>性能测试</title>\n${head}\n  </head>\n  <body>\n    <h1 id="title">${title}</h1>\n${body}\n  </body>\n</html>\n`,
  );
  // 10 css + 10 classic + 5 modules + main.js + 10 svg + 4 json + 9 pages + index = 50
  return files;
}

/** The index.html text with a different heading (what the measurement types into the editor). */
export function perfFixtureIndex(title) {
  return perfFixtureFiles(title).get('index.html');
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

/** Writes the fixture into `root` (created) and checks the PLAN §11 conditions on what is actually on disk. */
export async function writePerfFixture(root) {
  for (const [rel, content] of perfFixtureFiles()) {
    const target = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const written = await listFiles(root);
  const sizes = await Promise.all(written.map(async (f) => (await stat(f)).size));
  const largest = Math.max(...sizes);
  if (written.length !== PERF_FIXTURE_FILES) throw new Error(`perf fixture has ${written.length} files, not 50`);
  if (largest > PERF_FIXTURE_MAX_BYTES) throw new Error(`perf fixture has a file of ${largest} bytes (> 200 KB)`);
  for (const [rel, content] of perfFixtureFiles()) {
    if (/(?:https?:)?\/\/(?!www\.w3\.org\/2000\/svg)/.test(content)) throw new Error(`${rel} references the network`);
  }
  return { files: written.length, totalBytes: sizes.reduce((a, b) => a + b, 0), largestBytes: largest };
}
