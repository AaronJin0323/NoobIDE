// Types for scripts/e2e-shards.mjs (used by tests/integration/e2e-shards.test.ts).
export interface ShardManifest {
  shards: number;
  generated_from?: string;
  files: Record<string, number>;
}
export interface PlaywrightReport {
  suites?: PlaywrightSuite[];
  [key: string]: unknown;
}
export interface PlaywrightSuite {
  title?: string;
  file?: string;
  specs?: { file?: string; tests?: { results?: { duration?: number }[] }[] }[];
  suites?: PlaywrightSuite[];
}
export interface BalanceResult {
  manifest: ShardManifest;
  totals: number[];
  unmeasured: string[];
  dropped: string[];
}
export interface Selection {
  files: string[];
  unlisted: string[];
  stale: string[];
  fallbackShard: number;
}

export const ROOT: string;
export const E2E_DIR: string;
export const MANIFEST_PATH: string;
export const MANIFEST_RELATIVE: string;
export function listSpecFiles(dir?: string): string[];
export function parseShard(spec: string): { current: number; total: number };
export function validateManifest(manifest: unknown): ShardManifest;
export function loadManifest(file?: string): ShardManifest;
export function fileDurations(report: PlaywrightReport): Map<string, number>;
export function balance(
  reports: PlaywrightReport[],
  specFiles?: string[],
  opts?: { shards?: number; generatedFrom?: string },
): BalanceResult;
export function select(manifest: ShardManifest, shard: number, allSpecFiles: string[]): Selection;
export function playwrightFilters(files: string[], dir?: string): string[];
export function main(argv?: string[], opts?: { log?: (line: string) => void; error?: (line: string) => void }): number;
