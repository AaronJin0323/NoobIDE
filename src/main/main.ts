/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import { quitsWhenLastWindowCloses, recreatesWindowOnActivate } from '../platform/index';
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
import { createWorkbenchWindowOptions, insecurePreferences } from './window-options';

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
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // --- end S12 ---

  // --- S04 preview: the project service is created when the app is ready; the preview asks it for roots. ---
  let projects: ProjectService | undefined;
  const preview = new PreviewManager({ rootOf: (id) => projects?.rootOf(id) });
  // --- end S04 ---

  // Read-only hook for the Playwright e2e suite (tests/e2e). Holds request metadata only, never source code.
  (globalThis as { __noobideTestHooks?: unknown }).__noobideTestHooks = {
    blockedRequests,
    preview: () => preview.debugInfo(),
  };

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
    const journal = new RecoveryJournal({ dir: path.join(appData, 'recovery'), log: consoleLogger });
    // --- end S12 ---
    // --- S21: local history (snapshots around saves) in app data ---
    const history = new SnapshotStore({ dir: path.join(appData, 'history'), log: consoleLogger });
    const historyTriggers = new HistoryTriggers(history, consoleLogger);
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
      projectOpened: (projectId, root, sender) => watchHub.watch(projectId, root, sender),
      trashItem: (fullPath) => shell.trashItem(fullPath),
      revealItem: (fullPath) => shell.showItemInFolder(fullPath),
    });
    // S10.5: refresh the preview only after a confirmed write (fires after the rename, never on a failed save).
    projects.onSaved((file) => preview.fileSaved(file.projectId));
    registerPreviewIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      windowOf: (event) => BrowserWindow.fromWebContents(event.sender),
      preview,
    });
    createWorkbenchWindow();

    app.on('activate', () => {
      if (recreatesWindowOnActivate() && BrowserWindow.getAllWindows().length === 0) createWorkbenchWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (quitsWhenLastWindowCloses()) app.quit();
  });
}
