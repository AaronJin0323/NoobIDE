/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { platformId } from '../platform/index';
import { currentSquirrelAction } from '../platform/squirrel';
import { APP_ENTRY_URL, APP_ORIGIN } from './app-asset';
import { handleAppProtocol, registerAppSchemePrivileges } from './app-protocol';
import { buildCsp } from './csp';
import {
  blockedRequests,
  denyAllPermissions,
  hardenWorkbenchContents,
  installDevCsp,
  installNetworkGuard,
} from './harden';
import { registerIpcHandlers } from './ipc';
import { registerPreviewIpcHandlers } from './preview-ipc';
import { installCloseGuard, type CloseGuard } from './close-guard';
import { ProjectWatchHub } from './project-watch';
import { ProjectService } from '../workspace/project-service';
import { PreviewManager } from '../preview/preview-manager';
import { consoleLogger } from '../recovery/atomic-file';
import { RecoveryJournal } from '../recovery/journal';
import { SnapshotStore } from '../recovery/history';
import { HistoryTriggers } from '../recovery/history-triggers';
import { selfTestOffline, selfTestRequested, watchSelfTest, withSelfTestQuery } from './self-test';
// S13 app data: settings, recent projects, session, logs
import { registerAppDataIpcHandlers } from './app-data-ipc';
import { SettingsStore } from './settings-store';
import { AppLog } from './app-log';
import { osInfo } from '../platform/os-info';
import type { RecoveryLogger } from '../recovery/atomic-file';
import { effectiveProjectConfig, previewEntryPath } from '../workspace/project-config';
import { RecentProjects } from './recent-projects';
import { SessionStore } from './session-store';
import type { WebContents } from 'electron';
import { resolveTemplatesDir } from '../workspace/templates'; // S20.2
import { createWorkbenchWindowOptions, insecurePreferences } from './window-options';
// S24.2: native menus from the command registry, and the platform's window lifecycle
import { AppMenuController } from './app-menu';
import { registerCommandIpcHandlers } from './commands-ipc';
import { installWindowLifecycle } from './window-lifecycle';

// Windows installer events: create/remove shortcuts and quit without opening a window.
const squirrel = currentSquirrelAction();
if (squirrel.kind !== 'none') {
  if (squirrel.kind === 'run-update-exe') {
    spawn(squirrel.updateExe, squirrel.args, { detached: true }).on('close', () => app.quit());
  } else {
    app.quit();
  }
} else {
  start();
}

function start(): void {
  registerAppSchemePrivileges(protocol);

  const devServerUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
  const selfTest = selfTestRequested();

  // --- S12: one running app per app-data directory, so two processes never share one recovery journal (a second
  // instance would see the first one's live buffers as crash leftovers). The self-test probe is exempt. ---
  if (!selfTest && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // (S24.2: a second launch focuses the window, or opens one on macOS — see installWindowLifecycle below.)
  // --- end S12 ---

  // --- S04 preview: the project service is created when the app is ready; the preview asks it for roots. ---
  let projects: ProjectService | undefined;
  const preview = new PreviewManager({
    rootOf: (id) => projects?.rootOf(id),
    // S13.2: the entry page from .noobide/project.json (when that file exists), else the project's index.html.
    entryPathOf: async (id) => {
      const root = projects?.rootOf(id);
      return root === undefined ? '' : previewEntryPath(root);
    },
  });
  // --- end S04 ---

  // Read-only hook for the Playwright e2e suite (tests/e2e). Holds request metadata only, never source code.
  (globalThis as { __noobideTestHooks?: unknown }).__noobideTestHooks = {
    blockedRequests,
    preview: () => preview.debugInfo(),
  };

  // S24.2: the native menu bar, created when the app is ready (it needs the settings' interface language).
  let menu: AppMenuController | undefined;

  // S10.6: every workbench window saves before it closes; an interrupted quit resumes once all windows agreed.
  const closeGuards = new Map<number, CloseGuard>();
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });

  function createWorkbenchWindow(): BrowserWindow {
    const options = createWorkbenchWindowOptions(path.join(__dirname, 'preload.cjs'));
    const insecure = insecurePreferences(options.webPreferences ?? {});
    if (insecure.length > 0) throw new Error(`insecure workbench webPreferences: ${insecure.join(', ')}`);

    const win = new BrowserWindow(options);
    hardenWorkbenchContents(win.webContents, devOrigin ?? APP_ORIGIN);
    win.once('ready-to-show', () => win.show());
    const contentsId = win.webContents.id;
    closeGuards.set(
      contentsId,
      installCloseGuard(win, {
        onAllowed: () => {
          if (quitting) app.quit();
        },
        onRefused: () => {
          quitting = false;
        },
      }),
    );
    win.on('closed', () => closeGuards.delete(contentsId));
    // S24.2: the menu bar follows the focused workbench's command context.
    win.on('focus', () => menu?.windowFocused(contentsId));
    win.on('closed', () => menu?.windowClosed(contentsId));
    if (selfTest) {
      // S18.1: the result line also says whether the network was off and what the network guard refused.
      watchSelfTest(
        win.webContents,
        (code) => app.exit(code),
        undefined,
        () => ({
          offline: selfTestOffline(),
          blockedRequests: blockedRequests.length,
        }),
      );
    }

    const entry = devServerUrl ?? APP_ENTRY_URL;
    void win.loadURL(selfTest ? withSelfTestQuery(entry) : entry);
    return win;
  }

  void app.whenReady().then(() => {
    const ses = session.defaultSession;
    denyAllPermissions(ses);
    installNetworkGuard(ses, devOrigin);
    // S18.1: the offline self-test proves the language services need no network.
    if (selfTestOffline()) ses.enableNetworkEmulation({ offline: true });
    if (devOrigin) {
      installDevCsp(ses, devOrigin, buildCsp('development', devOrigin));
    } else {
      handleAppProtocol(protocol, path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME));
    }
    const watchHub = new ProjectWatchHub();
    // --- S12: unsaved-buffer journal in the app-data directory (PLAN §6), never inside a project ---
    const appData = app.getPath('userData');
    // --- S13.6: rotating, content-free log in app data; recovery and history events go there too ---
    const appLog = new AppLog({ dir: path.join(appData, 'logs') });
    appLog.started({
      app: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      ...osInfo(),
    });
    const logger: RecoveryLogger = (event, fields) => {
      consoleLogger(event, fields);
      appLog.write('warn', event, fields);
    };
    app.on('render-process-gone', (_event, _contents, details) =>
      appLog.write('error', 'render-process-gone', { reason: details.reason, exitCode: details.exitCode }),
    );
    app.on('child-process-gone', (_event, details) =>
      appLog.write('error', 'child-process-gone', { type: details.type, reason: details.reason }),
    );
    app.on('will-quit', () => appLog.write('info', 'app-quit'));
    // --- end S13.6 ---
    const journal = new RecoveryJournal({ dir: path.join(appData, 'recovery'), log: logger });
    // --- end S12 ---
    // --- S13.3: project lifecycle. Every opened project (folder dialog, recent list, wizard, crash recovery,
    // session restore) is watched and remembered; a preview of another project stops with its server. Closing a
    // project stops its watcher, preview and server. ---
    const recent = new RecentProjects({ file: path.join(appData, 'recent-projects.json'), log: logger });
    const sessionStore = new SessionStore({ file: path.join(appData, 'session.json'), log: logger }); // S13.4
    const projectOpened = (projectId: string, root: string, sender: WebContents) => {
      watchHub.watch(projectId, root, sender);
      void recent.touch(root);
      void sessionStore.projectOpened(root); // S13.4: reopened on the next normal start
      const previewed = preview.getStatus().projectId;
      if (previewed !== null && previewed !== projectId) void preview.stop();
    };
    const projectClosed = async (projectId: string, root: string) => {
      watchHub.stop();
      const previewed = preview.getStatus().projectId;
      if (previewed === null || previewed === projectId) void preview.stop();
      // S13.4: the next start shows the welcome screen. Awaited, so a quit right after closing cannot lose it.
      await sessionStore.projectClosed(root);
    };
    Object.assign((globalThis as { __noobideTestHooks?: object }).__noobideTestHooks ?? {}, {
      watching: () => watchHub.active,
    });
    // --- end S13.3 ---
    // --- S21: local history (snapshots around saves) in app data ---
    const history = new SnapshotStore({ dir: path.join(appData, 'history'), log: logger });
    const historyTriggers = new HistoryTriggers(history, logger);
    // --- end S21 ---
    projects = new ProjectService({ history: historyTriggers });
    registerIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      projects,
      journal,
      async chooseFolder(event) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = { properties: ['openDirectory' as const] };
        const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      async chooseSaveFile(event, fileName) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = { defaultPath: path.join(app.getPath('documents'), fileName) };
        const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
        return result.canceled || !result.filePath ? null : result.filePath;
      },
      revealFolder: (folder) => shell.showItemInFolder(folder),
      closeAnswered: (event, answer) => closeGuards.get(event.sender.id)?.answer(answer),
      closeDiscarding: (event) => closeGuards.get(event.sender.id)?.discardAndClose(),
      // ── S07/S08: file tree, watcher and file operations ──
      projectOpened, // S13.3: watch + remember + stop another project's preview
      trashItem: (fullPath) => shell.trashItem(fullPath),
      revealItem: (fullPath) => shell.showItemInFolder(fullPath),
      // --- S20.2: create-project wizard (built-in templates, default location in Documents) ---
      create: {
        templatesDir: resolveTemplatesDir({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        }),
        documentsDir: () => app.getPath('documents'),
        async chooseFolder(event, defaultPath) {
          const owner = BrowserWindow.fromWebContents(event.sender);
          const options = {
            properties: ['openDirectory' as const, 'createDirectory' as const],
            ...(defaultPath ? { defaultPath } : {}),
          };
          const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
      },
      // --- end S20.2 ---
      // S21.3/S21.4: local history window (store and triggers created above).
      history: { store: history, triggers: historyTriggers, revealFolder: (folder) => void shell.openPath(folder) },
    });
    // S10.5: refresh the preview only after a confirmed write (fires after the rename, never on a failed save).
    // S13.2: unless the project's preview preferences turned automatic refresh off.
    const savedIn = projects;
    savedIn.onSaved((file) => {
      const root = savedIn.rootOf(file.projectId);
      if (root === undefined) return;
      void effectiveProjectConfig(root).then((config) => {
        if (config.preview?.autoRefresh !== false) preview.fileSaved(file.projectId);
      });
    });
    registerPreviewIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      windowOf: (event) => BrowserWindow.fromWebContents(event.sender),
      preview,
    });
    // --- S13 app data (all in app.getPath('userData'), never inside a project) ---
    const settings = new SettingsStore({ file: path.join(appData, 'settings.json'), log: logger });
    // --- S24.2: native menus, translated with the interface language and enabled from the command context ---
    const appMenu = new AppMenuController({
      platform: platformId(),
      devTools: devServerUrl !== undefined,
      apply: (template) => Menu.setApplicationMenu(Menu.buildFromTemplate(template)),
      targetOf: (window) => {
        const win =
          (window instanceof BrowserWindow ? window : undefined) ??
          BrowserWindow.getFocusedWindow() ??
          BrowserWindow.getAllWindows()[0];
        if (!win) return null;
        const contents = win.webContents;
        return {
          id: contents.id,
          isFocused: () => contents.isFocused(),
          send: (channel, id) => contents.send(channel, id),
        };
      },
      createWindow: () => void createWorkbenchWindow(),
    });
    menu = appMenu;
    appMenu.rebuild();
    void settings.load().then((loaded) => appMenu.setLocale(loaded.settings.locale));
    registerCommandIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      setContext: (senderId, context) => appMenu.setContext(senderId, context),
    });
    // --- end S24.2 ---
    registerAppDataIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      settings: {
        snapshot: () => settings.snapshot(),
        // S24.2: a language change re-translates the native menus.
        update: async (patch) => {
          const next = await settings.update(patch);
          appMenu.setLocale(next.locale);
          return next;
        },
      },
      openLogsFolder: () => shell.openPath(appLog.dir),
      projects,
      recent,
      projectOpened,
      projectClosed,
      session: sessionStore,
      pendingRecovery: async () => (await journal.listPending()).length,
      restoreEnabled: async () => (await settings.snapshot()).settings.restoreSession,
    });
    // --- end S13 ---
    createWorkbenchWindow();

    // S24.2: Windows exits with its last window; macOS stays in the dock and reopens a window on activation.
    installWindowLifecycle(app, {
      windowCount: () => BrowserWindow.getAllWindows().length,
      createWindow: () => void createWorkbenchWindow(),
      focusFirstWindow: () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
      },
    });
  });
}
