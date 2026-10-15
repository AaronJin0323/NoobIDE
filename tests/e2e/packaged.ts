import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { electronArgs, repoRoot, tempRoot } from './launch';

/** The packaged executable in out/ (npm run test:e2e runs `electron-forge package` first). */
export function packagedExecutable(): string | undefined {
  const out = path.join(repoRoot, 'out');
  if (!existsSync(out)) return undefined;
  const platform = process.platform;
  const dir = readdirSync(out).find((d) => d.startsWith(`NoobIDE-${platform}-${process.arch}`));
  if (!dir) return undefined;
  const base = path.join(out, dir);
  if (platform === 'darwin') {
    const macos = path.join(base, 'NoobIDE.app', 'Contents', 'MacOS');
    const bin = existsSync(macos) ? readdirSync(macos)[0] : undefined;
    return bin ? path.join(macos, bin) : undefined;
  }
  return path.join(base, platform === 'win32' ? 'noobide.exe' : 'noobide');
}

/**
 * Runs the self-test (NOOBIDE_SELF_TEST=1) of an executable and returns its parsed result line plus the exit code. It runs on its own
 * temporary app data (never the developer's real ~/Library/Application Support/NoobIDE, which a running NoobIDE or a
 * parallel run may be using), and a probe that has not exited after `killAfterMs` is killed so no process outlives
 * the test.
 */
export async function runSelfTest(
  executable: string,
  env: Record<string, string>,
  options: {
    /** Arguments after the switches: ['.'] runs the development build with the stock Electron. */ appArgs?: string[];
    killAfterMs?: number;
  } = {},
): Promise<{ code: number | null; result: Record<string, unknown> | undefined }> {
  // electronArgs() ends with '.', the app path for the development binary; the packaged binary needs no path.
  const userData = mkdtempSync(path.join(tempRoot(), 'noobide-e2e-selftest-'));
  const args = [`--user-data-dir=${userData}`, ...electronArgs().filter((a) => a !== '.'), ...(options.appArgs ?? [])];
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: repoRoot,
        env: { ...process.env, NOOBIDE_SELF_TEST: '1', ...env },
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), options.killAfterMs ?? 150_000);
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('error', (e) => {
        clearTimeout(killer);
        reject(e);
      });
      child.on('exit', (code) => {
        clearTimeout(killer);
        const line = out.split('\n').find((l) => l.startsWith('NOOBIDE_SELFTEST '));
        resolve({
          code,
          result: line ? (JSON.parse(line.slice('NOOBIDE_SELFTEST '.length)) as Record<string, unknown>) : undefined,
        });
      });
    });
  } finally {
    rmSync(userData, { recursive: true, force: true, maxRetries: 3 });
  }
}
