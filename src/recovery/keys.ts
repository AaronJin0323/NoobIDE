import { createHash } from 'node:crypto';

/**
 * Stable, filesystem-safe keys for app-data storage. A project is identified by its real root path (the opaque
 * `projectId` changes on every open), a file by its portable relative path. Keys are hashes, so app-data file names
 * never contain user paths and are safe to log; the real paths are stored inside the JSON records.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function projectKey(rootPath: string): string {
  return sha256Hex(`project\0${rootPath}`).slice(0, 32);
}

export function fileKey(relPath: string): string {
  return sha256Hex(`file\0${relPath}`).slice(0, 24);
}

export const PROJECT_KEY = /^[0-9a-f]{32}$/;
export const BUFFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
