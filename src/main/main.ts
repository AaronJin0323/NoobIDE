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
import { ProjectService } from '../workspace/project-service';
import { PreviewManager } from '../preview/preview-manager';
import { selfTestRequested, watchSelfTest, withSelfTestQuery } from './self-test';
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

  const projects = new ProjectService();
  const preview = new PreviewManager({ rootOf: (id) => projects.rootOf(id) });

  // Read-only hook for the Playwright e2e suite (tests/e2e). Holds request metadata only, never source code.
  (globalThis as { __noobideTestHooks?: unknown }).__noobideTestHooks = {
    blockedRequests,
    preview: () => preview.debugInfo(),
  };

  function createWorkbenchWindow(): BrowserWindow {
    const options = createWorkbenchWindowOptions(path.join(__dirname, 'preload.cjs'));
    const insecure = insecurePreferences(options.webPreferences ?? {});
    if (insecure.length > 0) throw new Error(`insecure workbench webPreferences: ${insecure.join(', ')}`);

    const win = new BrowserWindow(options);
    hardenWorkbenchContents(win.webContents, devOrigin ?? APP_ORIGIN);
    win.once('ready-to-show', () => win.show());
    if (selfTest) watchSelfTest(win.webContents, (code) => app.exit(code));

    const entry = devServerUrl ?? APP_ENTRY_URL;
    void win.loadURL(selfTest ? withSelfTestQuery(entry) : entry);
    return win;
  }

  void app.whenReady().then(() => {
    const ses = session.defaultSession;
    denyAllPermissions(ses);
    installNetworkGuard(ses, devOrigin);
    if (devOrigin) {
      installDevCsp(ses, devOrigin, buildCsp('development', devOrigin));
    } else {
      handleAppProtocol(protocol, path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME));
    }
    registerIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      projects,
      async chooseFolder(event) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = { properties: ['openDirectory' as const] };
        const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      revealFolder: (folder) => shell.showItemInFolder(folder),
      afterSave: (projectId) => preview.fileSaved(projectId),
    });
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
