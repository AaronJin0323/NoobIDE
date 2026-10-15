// Types for scripts/third-party-notices.mjs (used by tests/integration/third-party-notices.test.ts).
export interface ProductionPackage {
  key: string;
  dir: string;
  name: string;
  version: string;
  license: string | null;
  optional: boolean;
}
export interface IncludedPackage extends Omit<ProductionPackage, 'license'> {
  license: string;
  files: string[];
}
export interface NoticesResult {
  text: string;
  included: IncludedPackage[];
  skipped: ProductionPackage[];
}
export interface AllowEntry {
  reason: string;
  source: string;
}
export const DEFAULT_OUTPUT: string;
export const ALLOW_NO_LICENSE_FILE: Record<string, AllowEntry>;
export function productionPackages(root: string): ProductionPackage[];
export function buildThirdPartyNotices(root: string, options?: { allow?: Record<string, AllowEntry> }): NoticesResult;
export function writeThirdPartyNotices(root: string, outFile: string): NoticesResult;
