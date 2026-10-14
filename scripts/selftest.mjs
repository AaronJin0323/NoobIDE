#!/usr/bin/env node
// Runs the app's Monaco worker self-test (src/main/self-test.ts) and reports pass/fail.
//
//   node scripts/selftest.mjs --packaged   the packaged app in out/ (run `npm run package` first)
//   node scripts/selftest.mjs --dev        the Vite dev server via `electron-forge start`
//
// Exit code 0 = workers loaded and answered, 1 = probe failed, 2 = timeout / no result, 3 = app not found.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--dev') ? 'dev' : 'packaged';
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const extraArgs = isRoot ? ['--no-sandbox'] : [];

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
  return path.join(base, isWin ? 'noobide.exe' : 'noobide');
}

let cmd;
let args;
if (mode === 'dev') {
  cmd = isWin ? 'npx.cmd' : 'npx';
  args = ['electron-forge', 'start', ...(extraArgs.length ? ['--', ...extraArgs] : [])];
} else {
  cmd = packagedExecutable();
  args = extraArgs;
  if (!cmd || !existsSync(cmd)) {
    console.error(`No packaged app for ${process.platform}-${process.arch} in out/. Run \`npm run package\` first.`);
    process.exit(3);
  }
}
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  args = ['-a', cmd, ...args];
  cmd = 'xvfb-run';
}

console.log(`self-test (${mode}): ${cmd} ${args.join(' ')}`);
const child = spawn(cmd, args, {
  cwd: root,
  env: { ...process.env, NOOBIDE_SELF_TEST: '1' },
  shell: isWin && mode === 'dev',
});
let result;
const timer = setTimeout(() => {
  console.error('self-test: no result within 120 s');
  child.kill();
  process.exit(2);
}, 120_000);
child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.startsWith('NOOBIDE_SELFTEST ')) {
      result = JSON.parse(line.slice('NOOBIDE_SELFTEST '.length));
      console.log(line);
      if (mode === 'dev') child.kill(); // forge start keeps its dev server alive
    }
  }
});
child.on('exit', () => {
  clearTimeout(timer);
  if (!result) {
    console.error('self-test: the app exited without a result');
    process.exit(2);
  }
  console.log(result.pass ? 'self-test PASSED' : 'self-test FAILED');
  process.exit(result.pass ? 0 : 1);
});
