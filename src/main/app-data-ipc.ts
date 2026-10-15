import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseNoPayload, parseProjectRequest, toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  APP_DATA_CHANNELS,
  parseRecentRequest,
  parseSaveTabsRequest,
  parseSessionLayout,
  parseSetEntryRequest,
  type SessionRestore,
} from '../shared/ipc/app-data-contract';
import { decideRestore, type SessionStore } from './session-store';
import type { RecentProjects } from './recent-projects';
import type { ProjectService } from '../workspace/project-service';
import {
  EMPTY_PROJECT_CONFIG,
  readProjectConfig,
  writeProjectConfig,
  type ProjectConfig,
} from '../workspace/project-config';
import { parseSettingsPatch } from '../shared/settings';
import { isTrustedSender, senderInfo } from './ipc';
import type { SettingsStore } from './settings-store';
import { scanPortability } from '../workspace/portability-scan';
import type { PortabilityReport } from '../shared/portability';

/**
 * IPC handlers of the S13 app-data channels (app-data-contract.ts). Same checks as ipc.ts, in the same order: the
 * sender is the workbench's top-level frame on the app origin, at most one argument, and it passes the channel's
 * parser — before any store is touched.
 */
export interface AppDataIpcDeps {
  readonly allowedOrigin: string;
  readonly settings: Pick<SettingsStore, 'snapshot' | 'update'>;
  /** S13.6: shows the log folder in the file manager; resolves to an error text ('' on success, like shell.openPath). */
  openLogsFolder(): Promise<string>;
  /** Open projects (S13.2 and later): only a projectId crosses IPC, main knows the root. */
  readonly projects: Pick<ProjectService, 'rootOf' | 'open' | 'close'>;
  /** S13.3: recent projects in app data. */
  readonly recent: Pick<RecentProjects, 'list' | 'rootOf' | 'remove'>;
  /** S13.3: a project was opened (watch it, remember it, stop another project's preview). */
  projectOpened(projectId: string, root: string, sender: IpcMainInvokeEvent['sender']): void;
  /** S13.3: a project was closed (stop its watcher, preview and server). */
  projectClosed(projectId: string, rootPath: string): Promise<void> | void;
  /** S13.4: session state in app data, and what decides whether the last project is reopened. */
  readonly session: Pick<SessionStore, 'lastProject' | 'layout' | 'tabsOf' | 'saveTabs' | 'saveLayout'>;
  /** Number of crash-recovery records waiting (crash recovery takes precedence over session restore). */
  pendingRecovery(): Promise<number>;
  restoreEnabled(): Promise<boolean>;
  /** S13.5: the read-only portability scan (tests inject one; default src/workspace/portability-scan). */
  scanPortability?(root: string): Promise<PortabilityReport>;
}

type Run<P> = (payload: P, event: IpcMainInvokeEvent) => Promise<IpcResult<unknown, string>>;

const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;
const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerAppDataIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: AppDataIpcDeps): void {
  const handle = <P>(channel: string, parse: (payload: unknown) => P | null, run: Run<P>) => {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  };

  // ── S13.1 settings ──
  handle(APP_DATA_CHANNELS.settingsGet, parseNoPayload, async () => ({
    ok: true,
    value: await deps.settings.snapshot(),
  }));
  handle(APP_DATA_CHANNELS.settingsUpdate, parseSettingsPatch, async (patch) => ({
    ok: true,
    value: await deps.settings.update(patch),
  }));

  // ── S13.6 local logs ──
  handle(APP_DATA_CHANNELS.openLogsFolder, parseNoPayload, async () => {
    const error = await deps.openLogsFolder();
    return error === '' ? { ok: true, value: null } : { ok: false, code: 'open-failed', message: 'could not open' };
  });

  // ── S13.3 recent projects and project lifecycle ──
  handle(APP_DATA_CHANNELS.recentList, parseNoPayload, async () => ({ ok: true, value: await deps.recent.list() }));
  handle(APP_DATA_CHANNELS.recentOpen, parseRecentRequest, async ({ id }, event) => {
    const root = await deps.recent.rootOf(id);
    if (root === undefined) return { ok: false, code: 'not-found', message: 'not in the recent list' };
    const opened = await deps.projects.open(root);
    if (opened.ok) deps.projectOpened(opened.value.projectId, opened.value.rootPath, event.sender);
    return toIpcResult(opened);
  });
  handle(APP_DATA_CHANNELS.recentRemove, parseRecentRequest, async ({ id }) => {
    await deps.recent.remove(id); // the list only; the folder is never touched
    return { ok: true, value: null };
  });
  handle(APP_DATA_CHANNELS.closeProject, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined || !deps.projects.close(projectId)) return UNKNOWN_PROJECT;
    await deps.projectClosed(projectId, root);
    return { ok: true, value: null };
  });

  // ── S13.4 session restore ──
  let restoreRequested = false;
  handle(APP_DATA_CHANNELS.sessionRestore, parseNoPayload, async (_payload, event) => {
    // Never repeat startup side effects or return a capability from an earlier restore.
    if (restoreRequested) return { ok: true, value: { project: null, layout: null, reason: 'none' } };
    restoreRequested = true;
    const layout = await deps.session.layout();
    const decision = await decideRestore({
      enabled: await deps.restoreEnabled(),
      pendingRecovery: await deps.pendingRecovery(),
      lastProject: await deps.session.lastProject(),
    });
    let value: SessionRestore = {
      project: null,
      layout,
      reason: decision.kind === 'skip' ? decision.reason : 'restored',
    };
    if (decision.kind === 'open') {
      const opened = await deps.projects.open(decision.rootPath, { restore: true });
      if (opened.ok) {
        deps.projectOpened(opened.value.projectId, opened.value.rootPath, event.sender);
        value = { project: opened.value, layout, reason: 'restored' };
      } else value = { project: null, layout, reason: 'open-failed' };
    }
    return { ok: true, value };
  });
  handle(APP_DATA_CHANNELS.sessionTabs, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    return { ok: true, value: await deps.session.tabsOf(root) };
  });
  handle(APP_DATA_CHANNELS.sessionSaveTabs, parseSaveTabsRequest, async ({ projectId, tabs, active }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    await deps.session.saveTabs(root, { tabs, active });
    return { ok: true, value: null };
  });
  handle(APP_DATA_CHANNELS.sessionSaveLayout, parseSessionLayout, async (layout) => {
    await deps.session.saveLayout(layout);
    return { ok: true, value: null };
  });

  // ── S13.2 .noobide/project.json ──
  handle(APP_DATA_CHANNELS.projectConfig, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const read = await readProjectConfig(root);
    return {
      ok: true,
      value: { config: read.kind === 'ok' ? read.config : EMPTY_PROJECT_CONFIG, state: read.kind },
    };
  });
  handle(APP_DATA_CHANNELS.projectSetEntry, parseSetEntryRequest, async ({ projectId, entry }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const read = await readProjectConfig(root);
    const current: ProjectConfig = read.kind === 'ok' ? read.config : EMPTY_PROJECT_CONFIG;
    const { entry: _old, ...rest } = current;
    // writeProjectConfig refuses to replace a file it cannot read (invalid or newer), so nothing is lost.
    return toIpcResult(await writeProjectConfig(root, entry === null ? rest : { ...rest, entry }));
  });

  // ── S13.5 cross-platform project transfer: report only, nothing on disk changes ──
  handle(APP_DATA_CHANNELS.portabilityCheck, parseProjectRequest, async ({ projectId }) => {
    const root = deps.projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    try {
      return { ok: true, value: await (deps.scanPortability ?? scanPortability)(root) };
    } catch {
      return { ok: false, code: 'scan-failed', message: 'project folder could not be read' };
    }
  });
}
