import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { electronArgs, repoRoot } from './launch';

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

/** Runs the self-test of an executable and returns its parsed result line plus the exit code. */
export async function runSelfTest(
  executable: string,
  env: Record<string, string>,
): Promise<{ code: number | null; result: Record<string, unknown> | undefined }> {
  // electronArgs() ends with '.', the app path for the development binary; the packaged binary needs no path.
  const args = electronArgs().filter((a) => a !== '.');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repoRoot, env: { ...process.env, NOOBIDE_SELF_TEST: '1', ...env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('NOOBIDE_SELFTEST '));
      resolve({
        code,
        result: line ? (JSON.parse(line.slice('NOOBIDE_SELFTEST '.length)) as Record<string, unknown>) : undefined,
      });
    });
  });
}
