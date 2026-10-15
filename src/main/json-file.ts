import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from '../recovery/atomic-file';

/**
 * Small JSON files in the app-data directory (settings, recent projects, session state — S13). Writes go through
 * recovery/atomic-file's writeFileAtomic (temp file + rename), so a crash leaves the old or the new file, never half.
 * A file that cannot be parsed is never silently overwritten: it is moved aside to a timestamped backup first.
 */
// (Schema versions across app upgrades and downgrades: schemaVersionOf below.)
export type JsonRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'corrupt' }
  /** Exists but cannot be read (permissions, a folder in its place…). */
  | { readonly kind: 'unreadable'; readonly code: string };

export async function readJsonFile(file: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    const code = errorCode(e);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', code };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text.replace(/^\uFEFF/, '')) as unknown };
  } catch {
    return { kind: 'corrupt' };
  }
}

/**
 * Moves an unusable file aside as `<name>.<reason>-<timestamp>.json` next to it and returns the backup path, or null
 * when even that failed (the caller then keeps working from defaults in memory and does not write the file).
 */
export async function backupFile(file: string, reason: string, now: Date = new Date()): Promise<string | null> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const parsed = path.parse(file);
  const backup = path.join(parsed.dir, `${parsed.name}.${reason}-${stamp}${parsed.ext || '.json'}`);
  try {
    await rename(file, backup);
    return backup;
  } catch {
    return null;
  }
}

/**
 * S28.4 upgrade / downgrade policy for app-data files (docs/decisions/0023-upgrade-and-uninstall.md). Every store
 * file carries a schema `version`. A file without one is version 0 (written before it was versioned). A file of an
 * older version is read field by field (and migrated where a chain exists) and written back in the current version
 * on the next change; a file written by a newer NoobIDE (after a downgrade) is read as far as this version
 * understands it but never written, moved or deleted, so the newer version finds it intact after the next upgrade.
 */
export type SchemaVersion =
  | { readonly kind: 'current' }
  | { readonly kind: 'older'; readonly version: number }
  | { readonly kind: 'newer'; readonly version: number }
  /** Not an object, or a version that is not a non-negative integer. */
  | { readonly kind: 'invalid' };

export function schemaVersionOf(value: unknown, current: number, field = 'version'): SchemaVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { kind: 'invalid' };
  const declared = (value as Record<string, unknown>)[field];
  const version = declared === undefined ? 0 : declared;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return { kind: 'invalid' };
  if (version === current) return { kind: 'current' };
  return version < current ? { kind: 'older', version } : { kind: 'newer', version };
}
