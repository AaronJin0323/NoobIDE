/**
 * S25.3: recognising "the operating system's privacy protection blocked this", as opposed to ordinary read-only files.
 *
 * - macOS TCC (Transparency, Consent and Control) guards Desktop, Documents, Downloads, iCloud Drive, other cloud
 *   storage and removable / network volumes. A denied app gets `EPERM` ("Operation not permitted") for reads and
 *   writes alike — POSIX permission bits give `EACCES` instead, so `EACCES` stays an ordinary permission problem.
 * - Windows Controlled Folder Access (Defender "ransomware protection") blocks *changes* by apps that are not
 *   allowed in Documents, Desktop, Pictures, Music, Videos and Favorites (also when OneDrive redirects them). Node
 *   reports the denied write as `EPERM` or `EACCES`. Reading is never blocked, so read failures are not attributed.
 *
 * Both are inferred from the error code and the location, confirmed by a cheap probe after a failed write so that
 * other causes in the same folders keep their own message: a macOS file locked in Finder (`uchg`, also EPERM) sits in
 * a folder that can still be listed — TCC would refuse that too; a Windows file with the read-only attribute fails
 * the same way as Controlled Folder Access, but its mode shows it. The platform, folders and probe are configuration,
 * so every case can be simulated on any OS.
 */
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProtectedFolderCause = 'macos-privacy' | 'windows-controlled-folder';

export interface ProtectedFolderEnv {
  readonly platform: NodeJS.Platform;
  /** The user's home folder. */
  readonly home: string;
  /** The real known folders (Electron's `app.getPath`), which may be redirected elsewhere, e.g. by OneDrive. */
  readonly known?: { readonly desktop?: string; readonly documents?: string; readonly downloads?: string };
  /** Checks after a failed write (see above). Absent: the code and location alone decide. */
  readonly probe?: DiskProbe;
}

export interface DiskProbe {
  /** The error code of listing `dir`, or `null` when it can be listed. */
  listError(dir: string): string | null;
  /** The file exists and has no write permission (on Windows: the read-only attribute). */
  isReadOnlyFile(file: string): boolean;
}

/** Synchronous on purpose: it only runs after a write already failed, and the error mappers are synchronous. */
export const nodeDiskProbe: DiskProbe = {
  listError(dir) {
    try {
      readdirSync(dir);
      return null;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return typeof code === 'string' ? code : 'unknown';
    }
  },
  isReadOnlyFile(file) {
    try {
      const info = statSync(file);
      return info.isFile() && (info.mode & 0o200) === 0;
    } catch {
      return false;
    }
  },
};

export type FileAccess = 'read' | 'write';

const MAC_HOME_FOLDERS = [
  'Desktop',
  'Documents',
  'Downloads',
  path.posix.join('Library', 'Mobile Documents'),
  path.posix.join('Library', 'CloudStorage'),
];
const WINDOWS_HOME_FOLDERS = ['Documents', 'Desktop', 'Pictures', 'Music', 'Videos', 'Favorites'];

let configured: ProtectedFolderEnv | null = null;

/**
 * Main calls this once with the real known folders (`folders` only); tests also set `platform` and `home` to simulate
 * another OS. Unset fields keep the real values; `null` resets everything.
 */
export function configureProtectedFolders(env: Partial<ProtectedFolderEnv> | null): void {
  configured = env === null ? null : { platform: process.platform, home: os.homedir(), probe: nodeDiskProbe, ...env };
}

function currentEnv(): ProtectedFolderEnv {
  return configured ?? { platform: process.platform, home: os.homedir(), probe: nodeDiskProbe };
}

/** The folders guarded by the OS privacy protection for this environment (absolute, platform path style). */
export function protectedFolders(env: ProtectedFolderEnv): string[] {
  if (env.platform === 'darwin') {
    const known = [env.known?.desktop, env.known?.documents, env.known?.downloads];
    return [...MAC_HOME_FOLDERS.map((name) => path.posix.join(env.home, name)), '/Volumes', ...defined(known)];
  }
  if (env.platform === 'win32') {
    const p = path.win32;
    const oneDrive = p.join(env.home, 'OneDrive');
    return [
      ...WINDOWS_HOME_FOLDERS.map((name) => p.join(env.home, name)),
      ...WINDOWS_HOME_FOLDERS.map((name) => p.join(oneDrive, name)),
      // Downloads is not protected by Controlled Folder Access by default.
      ...defined([env.known?.desktop, env.known?.documents]),
    ];
  }
  return [];
}

function defined(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => value !== undefined && value !== '');
}

function within(api: path.PlatformPath, folder: string, target: string): boolean {
  // path.win32.relative compares case-insensitively, as NTFS does; nothing is lowercased here.
  const rel = api.relative(folder, target);
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

/**
 * Why `code` happened at `target`, if it is most likely the OS privacy protection. `target` is the path the failing
 * call used (Node puts it on the error as `path`); without one nothing is attributed.
 */
export function protectedFolderCause(
  code: string,
  target: string | undefined,
  access: FileAccess,
  env: ProtectedFolderEnv = currentEnv(),
): ProtectedFolderCause | null {
  if (target === undefined || target === '') return null;
  if (env.platform === 'darwin') {
    if (code !== 'EPERM') return null;
    const folder = protectedFolders(env).find((f) => within(path.posix, f, target));
    if (folder === undefined) return null;
    // A refused read is TCC's (a Finder lock never blocks reading); a refused write only if the folder is unreadable.
    if (access === 'write' && env.probe && !folderUnreadable(env.probe, folder, target)) return null;
    return 'macos-privacy';
  }
  if (env.platform === 'win32') {
    if (access !== 'write' || (code !== 'EPERM' && code !== 'EACCES')) return null;
    if (!protectedFolders(env).some((folder) => within(path.win32, folder, target))) return null;
    if (env.probe?.isReadOnlyFile(target)) return null;
    return 'windows-controlled-folder';
  }
  return null;
}

/** The nearest existing folder containing `target` (not above the protected `root`) cannot be listed: EPERM. */
function folderUnreadable(probe: DiskProbe, root: string, target: string): boolean {
  let dir = path.posix.dirname(target);
  for (;;) {
    const code = probe.listError(dir);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return code === 'EPERM';
    if (dir === root || !within(path.posix, root, dir)) return false;
    dir = path.posix.dirname(dir);
  }
}

/** Same as protectedFolderCause, reading the code and path from a thrown Node fs error (`rename` also has `dest`). */
export function protectedFolderCauseOf(
  e: unknown,
  access: FileAccess,
  env?: ProtectedFolderEnv,
): ProtectedFolderCause | null {
  if (typeof e !== 'object' || e === null) return null;
  const { code, path: target, dest } = e as { code?: unknown; path?: unknown; dest?: unknown };
  if (typeof code !== 'string') return null;
  for (const candidate of [target, dest]) {
    if (typeof candidate !== 'string') continue;
    const cause = protectedFolderCause(code, candidate, access, env);
    if (cause) return cause;
  }
  return null;
}
