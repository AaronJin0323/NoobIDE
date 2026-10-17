export const CODE: 'code';
export const DOCS_ONLY: 'docs-only';
export function isCodePath(file: string): boolean;
export function classify(files: readonly string[]): 'code' | 'docs-only';
export function changedFiles(base: string | undefined, cwd: string): string[] | null;
export function baseSha(env: Record<string, string | undefined>): string;
