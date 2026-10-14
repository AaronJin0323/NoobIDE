/**
 * Typed contract of the S13 app-data features: settings (S13.1), recent projects and closing a project (S13.3),
 * session restore (S13.4), project configuration (S13.2), portability check (S13.5) and local logs (S13.6).
 * Same rules as contract.ts: pure TypeScript, the renderer never sends an absolute path, main validates every
 * payload with the parsers here and checks the sender before any store is touched.
 */
import type { AppSettings, SettingsNotice, SettingsPatch } from '../settings';
import { isEntryPath, type ProjectConfig } from '../project-config';
import { isPortableRelPath, isProjectId, type IpcResult, type OpenedProject } from './contract';

export const APP_DATA_CHANNELS = {
  // S13.1
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  // S13.6
  openLogsFolder: 'app:open-logs-folder',
  // S13.2
  projectConfig: 'project:config',
  projectSetEntry: 'project:set-entry',
  // S13.3
  recentList: 'projects:recent',
  recentOpen: 'projects:open-recent',
  recentRemove: 'projects:remove-recent',
  closeProject: 'workspace:close-project',
} as const;

// ── S13.1 settings ──
export interface SettingsSnapshot {
  readonly settings: AppSettings;
  /** The settings file was unusable and was backed up; shown once to the user. */
  readonly notice: SettingsNotice;
  /** Absolute path of the backup, for the notice (app data, never inside a project). */
  readonly backupPath: string | null;
}

export interface SettingsApi {
  get(): Promise<IpcResult<SettingsSnapshot, never>>;
  update(patch: SettingsPatch): Promise<IpcResult<AppSettings, never>>;
}

// ── S13.6 local logs ──
export interface LogsApi {
  /** Shows the log folder (in app data) in Explorer / Finder. */
  openFolder(): Promise<IpcResult<null, 'open-failed'>>;
}

// ── S13.2 .noobide/project.json ──
export interface ProjectConfigInfo {
  /** The configuration in effect (defaults when the file is missing, invalid or unreadable). */
  readonly config: ProjectConfig;
  /** What was found on disk. An invalid file is left as it is and never overwritten. */
  readonly state: 'missing' | 'ok' | 'invalid' | 'unreadable';
}

export type SetEntryError = 'unknown-project' | 'invalid' | 'invalid-existing' | 'outside-project' | 'write-failed';

export interface SetEntryRequest {
  readonly projectId: string;
  /** Portable relative path of an .html page, or null to go back to index.html. */
  readonly entry: string | null;
}

export interface ProjectConfigApi {
  get(request: { readonly projectId: string }): Promise<IpcResult<ProjectConfigInfo, 'unknown-project'>>;
  setEntry(request: SetEntryRequest): Promise<IpcResult<ProjectConfig, SetEntryError>>;
}

export function parseSetEntryRequest(payload: unknown): SetEntryRequest | null {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['projectId', 'entry'])) return null;
  const { projectId, entry } = payload;
  if (!isProjectId(projectId)) return null;
  return entry === null || isEntryPath(entry) ? { projectId, entry } : null;
}

// ── S13.3 recent projects and project lifecycle ──
/** One recent project (the shape src/renderer/welcome/welcome-model.ts RecentProject consumes). */
export interface RecentProject {
  /** Opaque id; main keeps the real path. */
  readonly id: string;
  readonly name: string;
  /** Absolute path, for display only (Chinese characters and spaces shown as they are). */
  readonly path: string;
  /** False when the folder no longer exists: shown as unavailable, only removable. */
  readonly available: boolean;
  /** When it was last opened (ms since the epoch). */
  readonly lastOpened: number;
}

/** `window.noobide.recentProjects` — exactly the welcome screen's RecentProjectsSource. */
export interface RecentProjectsApi {
  list(): Promise<readonly RecentProject[]>;
  /** Opens the project by id (main looks up its path); `null` when it cannot be opened (e.g. the folder is gone). */
  open(id: string): Promise<OpenedProject | null>;
  /** Removes the entry from the list only. Never touches anything on disk. */
  remove(id: string): Promise<void>;
}

export interface ProjectLifecycleApi {
  /** Closes the project: its watcher, preview and preview server stop and its projectId stops working. */
  closeProject(request: { readonly projectId: string }): Promise<IpcResult<null, 'unknown-project'>>;
}

const RECENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRecentRequest(payload: unknown): { id: string } | null {
  if (!isRecord(payload) || !hasOnlyKeys(payload, ['id'])) return null;
  return typeof payload.id === 'string' && RECENT_ID.test(payload.id) ? { id: payload.id } : null;
}

// Re-exported for the renderer and main.
export type { AppSettings, SettingsPatch, OpenedProject, ProjectConfig };

/** Shared helpers for the parsers below. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const keys = Object.keys(value);
  return (
    required.every((k) => Object.hasOwn(value, k)) && keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

export { isPortableRelPath, isProjectId };
