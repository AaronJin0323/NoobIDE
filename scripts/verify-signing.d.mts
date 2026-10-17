// Types for scripts/verify-signing.mjs (used by tests/integration/verify-signing.test.ts).
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type Run = (cmd: string, args: string[]) => RunResult;
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface FileResult {
  file: string;
  ok: boolean;
  checks: Check[];
}
interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
}
export type Env = Record<string, string | undefined>;

export const DOC: string;
export const SECRET_ROUTES: {
  darwin: { certificate: string[]; notarize: Record<string, string[]> };
  win32: { routes: Record<string, string[]> };
};
export function defaultRun(cmd: string, args: string[]): RunResult;
export function verifyMacDmg(file: string, opts?: { run?: Run; teamId?: string }): FileResult;
export const SHARING_VIOLATION_BACKOFF_MS: readonly number[];
export function verifyWindowsFile(
  file: string,
  opts?: { run?: Run; signtool?: string; sleep?: (ms: number) => void; backoffMs?: readonly number[] },
): FileResult;
export function findSigntool(opts?: { env?: Env; fs?: FsLike }): string;
export function defaultArtifacts(platform: string, opts?: { root?: string; fs?: FsLike }): string[];
export function signingStatus(
  platform: string,
  env?: Env,
): { enabled: boolean; route: string | null; error: boolean; message: string };
export function main(argv?: string[], opts?: { env?: Env; run?: Run; log?: (line: string) => void }): number;
