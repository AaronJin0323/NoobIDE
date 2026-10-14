import os from 'node:os';

/**
 * Operating system facts for the log header (S13.6). Main process only — kept out of index.ts, which the sandboxed
 * preload also imports and which therefore must not pull in Node modules.
 */
export function osInfo(): { readonly platform: string; readonly arch: string; readonly osRelease: string } {
  return { platform: process.platform, arch: process.arch, osRelease: os.release() };
}
