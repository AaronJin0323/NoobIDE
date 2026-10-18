/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from 'electron';
import { memoryJsFlags, platformId } from '../platform/index';
import { isMac, isWindows } from '../platform/labels';
import { currentSquirrelAction, runSquirrelAction } from '../platform/squirrel';
import { APP_ENTRY_URL, APP_ORIGIN, APP_SCHEME } from './app-asset';
import { serveProjectImage } from './project-images'; // S52.6
import { IMAGE_DIALOG_EXTENSIONS } from '../shared/import-rules'; // S52.4
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
import { installCloseGuard, type CloseGuard, type CloseStep } from './close-guard';
import { ProjectWatchHub } from './project-watch';
import { ProjectService } from '../workspace/project-service';
import { PreviewManager } from '../preview/preview-manager';
import { formatOutline } from '../preview/page-snapshot'; // S38.1 test hook
import { defaultEntryPath } from '../preview/entry-pages';
import { CHROMIUM_SWITCHES, DISABLED_CHROMIUM_FEATURES } from '../preview/preview-options';
import { PreviewStore } from './preview-store'; // S14.4 trust, S14.2 one-time notes (app data)
import { readPreviewOptions, refreshModeOf, writeRefreshMode } from '../preview/project-options'; // S14.2/S14.3
import { err, ok } from '../shared/result';
import { ProblemsBridge, registerProblemsIpcHandlers } from './problems-bridge'; // S16.2
import { consoleLogger } from '../recovery/atomic-file';
import { RecoveryJournal } from '../recovery/journal';
import { SnapshotStore } from '../recovery/history';
import { HistoryTriggers } from '../recovery/history-triggers';
import { CheckpointStore } from '../recovery/checkpoints'; // S56.1
import { selfTestOffline, selfTestRequested, selfTestUserDataDir, watchSelfTest, withSelfTestQuery } from './self-test';
// S13 app data: settings, recent projects, session, logs
import { registerAppDataIpcHandlers, resolveThirdPartyNotices } from './app-data-ipc';
import { SettingsStore } from './settings-store';
import { localeFromOsLanguages } from '../shared/os-locale'; // S59.2
import { AppLog } from './app-log';
import { osInfo } from '../platform/os-info';
import { configureProtectedFolders } from '../platform/protected-folders';
import type { RecoveryLogger } from '../recovery/atomic-file';
import { effectiveProjectConfig, previewEntryPath } from '../workspace/project-config';
import { RecentProjects } from './recent-projects';
import { appDataPath } from './app-data-layout'; // S28.4: one list of app-data names
// S23 onboarding walkthrough progress (app data)
import { WalkthroughStore } from './walkthrough-store';
import { registerWalkthroughIpcHandlers } from './walkthrough-ipc';
import { SessionStore, blockingRecoveryCount } from './session-store';
import type { WebContents } from 'electron';
import { resolveTemplatesDir } from '../workspace/templates'; // S20.2
import {
  createWorkbenchWindowOptions,
  keepTrafficLightsCentred,
  insecurePreferences,
  titleBarOverlay,
  windowColorScheme,
} from './window-options';
import { THEMES } from '../renderer/theme/tokens';
import type { ThemeChoice } from '../shared/settings';
// S24.2: native menus from the command registry, and the platform's window lifecycle
import { AppMenuController } from './app-menu';
import { registerCommandIpcHandlers } from './commands-ipc';
import { registerSearchHandlers } from './search-ipc'; // S51.2
import { installWindowLifecycle } from './window-lifecycle';
import { setupAi } from './ai-main'; // S31 AI assistant (decision 0025)
import { secureStorageFor } from '../platform/secure-storage';
import { WakeRecovery } from './wake-recovery'; // S25.1/S25.2
import { wakeSignals } from '../platform/power-events';
import { AnnotationStore } from './annotation-store'; // S41.4 preview annotations (decision 0030)
import { registerAnnotationsIpcHandlers } from './annotations-ipc';
import { registerCheckpointsIpcHandlers } from './checkpoints-ipc'; // S56
import { registerFileOpsIpcHandlers } from './file-ops-ipc'; // S52

// Windows installer events: create/remove shortcuts and quit without opening a window (S02.7, S28.4: also quits
// when Update.exe is missing or hangs). App data and projects are never touched by these events.
const squirrel = currentSquirrelAction();
if (squirrel.kind !== 'none') {
  runSquirrelAction(squirrel, {
    spawn: (command, args) => spawn(command, [...args], { detached: true }),
    quit: () => app.quit(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
  });
} else {
  start();
}

function start(): void {
  registerAppSchemePrivileges(protocol);
  // Decision 0016: every frame of the preview must get the console limit before its scripts run.
  app.commandLine.appendSwitch('disable-features', DISABLED_CHROMIUM_FEATURES);
  // S05.8: a preview's renderer keeps its priority while its page guard is installed (preview-options.ts).
  for (const name of CHROMIUM_SWITCHES) app.commandLine.appendSwitch(name);
  // S59.5: Windows only — a smaller V8 young generation in every renderer keeps the typical project under the
  // ~700 MB memory budget (docs/perf/memory.md). Chromium hands --js-flags to each child process it starts.
  const jsFlags = memoryJsFlags();
  if (jsFlags.length > 0) app.commandLine.appendSwitch('js-flags', jsFlags.join(' '));

  const devServerUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER_URL : undefined;
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined;
  const selfTest = selfTestRequested();
  // The self-test probe never touches the user's app data: a fresh temporary folder unless --user-data-dir names one.
  const selfTestData = selfTestUserDataDir(process.env, app.commandLine.hasSwitch('user-data-dir'), () =>
    mkdtempSync(path.join(app.getPath('temp'), 'noobide-selftest-')),
  );
  if (selfTestData) app.setPath('userData', selfTestData);
  const exitSelfTest = (code: number) => {
    if (selfTestData) {
      try {
        rmSync(selfTestData, { recursive: true, force: true });
      } catch {
        // Chromium may still hold a file (Windows); the OS temp cleanup gets it later.
      }
    }
    app.exit(code);
  };

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
  const problems = new ProblemsBridge(); // S16.2: runtime capture adapter, fed by the preview
  // The interface language (settings), for the page the preview server shows when a page is missing.
  let uiLocale: 'zh-CN' | 'en' = 'zh-CN';
  const preview = new PreviewManager({
    capture: problems,
    rootOf: (id) => projects?.rootOf(id),
    // S13.2: the entry page from .noobide/project.json (when that file exists), else the project's index.html, else
    // its first page (a folder without index.html must not preview as 404).
    entryPathOf: async (id) => {
      const root = projects?.rootOf(id);
      if (root === undefined) return '';
      return (await previewEntryPath(root)) || defaultEntryPath(root);
    },
    // S15.4: "Open in external browser" (a one-time grant URL; never logged, never sent to the renderer).
    openExternal: (url) => shell.openExternal(url),
    locale: () => uiLocale,
  });
  // --- end S04 ---

  // Read-only hook for the Playwright e2e suite (tests/e2e). Holds request metadata only, never source code.
  (globalThis as { __noobideTestHooks?: unknown }).__noobideTestHooks = {
    blockedRequests,
    preview: () => preview.debugInfo(),
    problems: () => problems.debugInfo(), // S16.2–S16.6
    annotationPicking: () => preview.annotationPicking(), // S41.3: inspect mode is on
    failNextCssSwap: () => preview.debugFailNextCssSwap(), // S54.3: fault injection
    // S38.1: one page snapshot of the running preview (sizes and the outline of the test's own fixture page).
    previewSnapshot: async (screenshot: boolean) => {
      const projectId = preview.getStatus().projectId;
      if (projectId === null) return { ok: false, code: 'not-running' };
      const result = await preview.pageSnapshot(projectId, { screenshot });
      if (!result.ok) return { ok: false, code: result.code };
      const { outline, screenshot: image, ...rest } = result.value;
      return {
        ok: true,
        ...rest,
        outline: outline ? { ...formatOutline(outline), items: outline.items.length } : null,
        screenshot: image ? { width: image.width, height: image.height, bytes: image.png.length } : null,
      };
    },
  };

  // S24.2: the native menu bar, created when the app is ready (it needs the settings' interface language).
  let menu: AppMenuController | undefined;

  // S10.6: every workbench window saves before it closes; an interrupted quit resumes once all windows agreed.
  const closeGuards = new Map<number, CloseGuard>();
  let quitting = false;
  // The close handshake's steps go to the app log once it exists (it is created when the app is ready).
  let logCloseStep: (step: CloseStep) => void = () => undefined;
  app.on('before-quit', () => {
    quitting = true;
  });

  // S46: the saved theme choice (S24.4) for the native window background; set once the settings store exists.
  let savedTheme: () => ThemeChoice = () => 'system';

  /** The window frame follows a theme change (settings or, for 'system', the OS): background and caption buttons. */
  function applyFrameTheme(): void {
    const scheme = windowColorScheme(savedTheme(), nativeTheme.shouldUseDarkColors);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.setBackgroundColor(THEMES[scheme].bg);
      if (isWindows(platformId())) win.setTitleBarOverlay(titleBarOverlay(scheme));
    }
  }
  nativeTheme.on('updated', applyFrameTheme);

  function createWorkbenchWindow(): BrowserWindow {
    // A larger first window when the screen allows it (kept within the work area of the screen under the pointer).
    let workArea: Electron.Size | undefined;
    try {
      workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
    } catch {
      workArea = undefined; // no display information: the fallback size
    }
    const options = createWorkbenchWindowOptions(
      path.join(__dirname, 'preload.cjs'),
      workArea,
      // The saved theme choice (settings, S24.4) decides; 'system' follows the OS, as the renderer does.
      windowColorScheme(savedTheme(), nativeTheme.shouldUseDarkColors),
      platformId(),
    );
    const insecure = insecurePreferences(options.webPreferences ?? {});
    if (insecure.length > 0) throw new Error(`insecure workbench webPreferences: ${insecure.join(', ')}`);

    const win = new BrowserWindow(options);
    hardenWorkbenchContents(win.webContents, devOrigin ?? APP_ORIGIN);
    win.once('ready-to-show', () => win.show());
    // S50.5: the traffic lights stay centred in the top bar when the page zoom changes.
    if (isMac(platformId())) {
      keepTrafficLightsCentred({
        onZoomChanged: (listener) => win.webContents.on('zoom-changed', listener),
        onLoaded: (listener) => win.webContents.on('did-finish-load', listener),
        zoomFactor: () => win.webContents.getZoomFactor(),
        setPosition: (position) => win.setWindowButtonPosition(position),
        alive: () => !win.isDestroyed(),
      });
    }
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
        onStep: (step) => logCloseStep(step),
      }),
    );
    win.on('closed', () => closeGuards.delete(contentsId));
    // S24.2: the menu bar follows the focused workbench's command context.
    win.on('focus', () => menu?.windowFocused(contentsId));
    win.on('closed', () => menu?.windowClosed(contentsId));
    if (selfTest) {
      // S18.1: the result line also says whether the network was off and what the network guard refused.
      watchSelfTest(win.webContents, exitSelfTest, undefined, () => ({
        offline: selfTestOffline(),
        blockedRequests: blockedRequests.length,
      }));
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
    if (devOrigin) installDevCsp(ses, devOrigin, buildCsp('development', devOrigin));
    // S52.6: project images for the image viewer tab on the `project` host (development and production alike).
    handleAppProtocol(
      protocol,
      devOrigin ? null : path.join(__dirname, '..', 'renderer', MAIN_WINDOW_VITE_NAME),
      (request) => serveProjectImage(request, { scheme: APP_SCHEME, rootOf: (id) => projects?.rootOf(id) }),
    );
    // S25.3: the real known folders, also when Documents/Desktop are redirected (e.g. by OneDrive).
    configureProtectedFolders({
      known: {
        desktop: app.getPath('desktop'),
        documents: app.getPath('documents'),
        downloads: app.getPath('downloads'),
      },
    });
    const watchHub = new ProjectWatchHub();
    // --- S12: unsaved-buffer journal in the app-data directory (PLAN §6), never inside a project ---
    const appData = app.getPath('userData');
    // --- S13.6: rotating, content-free log in app data; recovery and history events go there too ---
    const appLog = new AppLog({ dir: appDataPath(appData, 'logs') });
    logCloseStep = (step) => appLog.write('info', 'window-close', { step, quitting });
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
    const journal = new RecoveryJournal({ dir: appDataPath(appData, 'recovery'), log: logger });
    // --- end S12 ---
    // --- S13.3: project lifecycle. Every opened project (folder dialog, recent list, wizard, crash recovery,
    // session restore) is watched and remembered; a preview of another project stops with its server. Closing a
    // project stops its watcher, preview and server. ---
    const recent = new RecentProjects({ file: appDataPath(appData, 'recentProjects'), log: logger });
    const sessionStore = new SessionStore({ file: appDataPath(appData, 'session'), log: logger }); // S13.4
    // A project opened (or a tab changed) right before quitting is still remembered: the quit waits briefly for the
    // recent list and session writes already queued. app.exit afterwards, as the quit events have already run once.
    let appDataFlushed = false;
    /** S48.7: the AI chat's unsent drafts (set up further below); the quit waits for their writes too. */
    let aiDrafts: { flush(): Promise<void> } | null = null;
    app.on('will-quit', (event) => {
      if (appDataFlushed) return;
      appDataFlushed = true;
      event.preventDefault();
      const cap = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      void Promise.race([Promise.allSettled([recent.flush(), sessionStore.flush(), aiDrafts?.flush()]), cap]).then(() =>
        app.exit(0),
      );
    });
    const projectOpened = (projectId: string, root: string, sender: WebContents) => {
      watchHub.watch(projectId, root, sender);
      void recent.touch(root);
      void sessionStore.projectOpened(root); // S13.4: reopened on the next normal start
      void preview.projectSwitched(projectId); // S14.6: another project's preview and server shut down
    };
    const projectClosed = async (projectId: string, root: string) => {
      watchHub.stop();
      await preview.projectClosed(projectId); // S14.6: its preview stops and its server shuts down
      // S13.4: the next start shows the welcome screen. Awaited, so a quit right after closing cannot lose it.
      await sessionStore.projectClosed(root);
    };
    Object.assign((globalThis as { __noobideTestHooks?: object }).__noobideTestHooks ?? {}, {
      watching: () => watchHub.active,
    });
    // --- end S13.3 ---
    // --- S25.1/S25.2: sleep/wake recovery (decision 0028): watcher rescan, server health check, hung page restart ---
    const wake = new WakeRecovery({
      power: powerMonitor,
      signals: wakeSignals(),
      watchers: watchHub,
      preview,
      log: (event, fields) => appLog.write('info', event, fields),
    });
    wake.install();
    app.on('will-quit', () => wake.dispose());
    Object.assign((globalThis as { __noobideTestHooks?: object }).__noobideTestHooks ?? {}, {
      wake: {
        last: () => wake.last,
        killServerSocket: () => preview.debugKillServerSocket(),
      },
    });
    // --- end S25.1/S25.2 ---
    // --- S21: local history (snapshots around saves) in app data ---
    const history = new SnapshotStore({ dir: appDataPath(appData, 'history'), log: logger });
    const historyTriggers = new HistoryTriggers(history, logger);
    // S56.1: project checkpoints share history's blobs; loading them lets history's clean-up delete blobs again.
    const checkpoints = new CheckpointStore({ dir: appDataPath(appData, 'checkpoints'), history, log: logger });
    void checkpoints.load();
    // --- end S21 ---
    projects = new ProjectService({ history: historyTriggers, journal }); // S52.1: history and copies follow moves
    // S14.4/S14.2: preview trust and one-time notes in app data (never inside a project).
    const previewStore = new PreviewStore({ file: appDataPath(appData, 'preview'), log: logger });
    const openProjects = projects;
    // S52.1 e2e: hold folder listings (a slow disk on demand) to prove Move to… acts on an Enter pressed before its
    // folder list arrived. Nothing is listed differently; the hook only delays.
    let listingHold: { promise: Promise<void>; release: () => void } | null = null;
    const listDirNow = projects.listDir.bind(projects);
    projects.listDir = async (request) => {
      if (listingHold) await listingHold.promise;
      return listDirNow(request);
    };
    Object.assign((globalThis as { __noobideTestHooks?: object }).__noobideTestHooks ?? {}, {
      holdListings: () => {
        if (listingHold) return;
        let release = () => {};
        const promise = new Promise<void>((resolve) => (release = resolve));
        listingHold = { promise, release };
      },
      releaseListings: () => {
        listingHold?.release();
        listingHold = null;
      },
    });
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
        // S14.4: a project made from a built-in template is trusted: its preview starts at once (PLAN §8).
        created: (root) => previewStore.trust(root),
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
      // S14.2: automatic mode refreshes after the typing pause; manual mode marks the page as outdated.
      // S58.10: registered before the save returns to the renderer, so a refresh hold's release waits for it.
      preview.saveArriving(
        effectiveProjectConfig(root).then((config) =>
          preview.fileSaved(file.projectId, refreshModeOf(config), file.relPath),
        ),
      );
    });
    registerPreviewIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      windowOf: (event) => BrowserWindow.fromWebContents(event.sender),
      preview,
      // S14.2/S14.3: preview settings in .noobide/project.json (S13.2 module) and one-time notes in app data.
      settings: {
        options: async (projectId) => {
          const root = openProjects.rootOf(projectId);
          if (root === undefined) return err('unknown-project', 'project is not open');
          return ok(await readPreviewOptions(root));
        },
        setRefreshMode: async (projectId, mode) => {
          const root = openProjects.rootOf(projectId);
          if (root === undefined) return err('unknown-project', 'project is not open');
          return writeRefreshMode(root, mode);
        },
        notesSeen: async () => ((await previewStore.noteSeen('reload-clears-state')) ? ['reload-clears-state'] : []),
        markNoteSeen: (note) => previewStore.markNoteSeen(note),
      },
      // S14.4: start-preview consent, by the project's real root (main only).
      trust: {
        isTrusted: async (projectId) => {
          const root = openProjects.rootOf(projectId);
          return root !== undefined && (await previewStore.isTrusted(root));
        },
        trust: async (projectId) => {
          const root = openProjects.rootOf(projectId);
          if (root !== undefined) await previewStore.trust(root);
        },
      },
    });
    registerProblemsIpcHandlers(ipcMain, { allowedOrigin: devOrigin ?? APP_ORIGIN, bridge: problems }); // S16.2
    // S56: project checkpoints (store created with local history above; restores write through the save path).
    registerCheckpointsIpcHandlers(ipcMain, { allowedOrigin: devOrigin ?? APP_ORIGIN, store: checkpoints, projects });
    // S52: move, copy/paste/duplicate, multi-select trash, import and the image viewer.
    registerFileOpsIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      projects: openProjects,
      trashItem: (fullPath) => shell.trashItem(fullPath), // S52.3: the OS trash, never a permanent delete
      rootOf: (projectId) => openProjects.rootOf(projectId), // S52.6
      // S52.5 e2e only (NOOBIDE_E2E_DROP=1, set by tests/e2e/file-drop.spec.ts): names the OS paths of a synthetic
      // test drop (see FileOpsIpcDeps.testDropPaths). Not wired in any other run.
      ...(process.env.NOOBIDE_E2E_DROP === '1'
        ? {
            testDropPaths: () =>
              (globalThis as { __noobideTestHooks?: { dropPaths?: readonly string[] } }).__noobideTestHooks?.dropPaths,
          }
        : {}),
      // S52.4: "Add files…" / "Add image…" (texts translated by the renderer; images filtered by ending)
      async chooseImportPaths(event, { kind, title, filterName }) {
        const owner = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title,
          properties: ['openFile' as const, 'multiSelections' as const],
          ...(kind === 'image' ? { filters: [{ name: filterName, extensions: [...IMAGE_DIALOG_EXTENSIONS] }] } : {}),
        };
        const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
        return result.canceled ? null : result.filePaths;
      },
    });
    // S41.4: preview annotations, kept per project in app data (never in the project folder).
    registerAnnotationsIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      store: new AnnotationStore({ dir: appDataPath(appData, 'annotations'), newId: randomUUID, log: logger }),
      preview,
      rootOf: (projectId) => openProjects.rootOf(projectId),
      newId: randomUUID,
    });
    // --- S13 app data (all in app.getPath('userData'), never inside a project) ---
    // S59.2: with no saved choice the interface starts in the OS language (zh* → zh-CN, else en). app.getLocale()
    // follows the OS language and the --lang switch, as the renderer's navigator.languages does.
    const firstRunLocale = localeFromOsLanguages([app.getLocale()]);
    uiLocale = firstRunLocale;
    const settings = new SettingsStore({
      file: appDataPath(appData, 'settings'),
      log: logger,
      defaultLocale: firstRunLocale,
    });
    savedTheme = () => settings.current.settings.theme;
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
    appMenu.setLocale(firstRunLocale); // builds the menu; the saved language replaces it once settings load
    // The first window waits for the settings (one small file): its native background follows the saved theme.
    const settingsLoaded = settings.load().then(
      (loaded) => {
        uiLocale = loaded.settings.locale;
        appMenu.setLocale(loaded.settings.locale);
      },
      () => undefined, // never rejects today; the window must open regardless
    );
    registerCommandIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      setContext: (senderId, context) => appMenu.setContext(senderId, context),
    });
    // --- end S24.2 ---
    // S51.2: project search (find / replace in files), one search per window, inside the open project's root.
    registerSearchHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      rootOf: (projectId) => projects?.rootOf(projectId),
    });
    registerAppDataIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      settings: {
        snapshot: () => settings.snapshot(),
        // S24.2: a language change re-translates the native menus. The language applies as soon as the request
        // arrives (the interface already shows it): main's uses of it — the preview's "page not found" page, the
        // menus — must not wait for the settings file to be written, which takes a while on a slow disk (S06.6).
        // Updates are served in arrival order, so the latest request is the current language.
        update: async (patch) => {
          if (patch.locale !== undefined) {
            uiLocale = patch.locale;
            appMenu.setLocale(patch.locale);
          }
          const next = await settings.update(patch);
          if (patch.theme !== undefined) applyFrameTheme();
          return next;
        },
      },
      openLogsFolder: () => shell.openPath(appLog.dir),
      openThirdPartyNotices: () =>
        shell.openPath(
          resolveThirdPartyNotices({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: app.getAppPath(),
          }),
        ),
      projects,
      recent,
      projectOpened,
      projectClosed,
      session: sessionStore,
      // Decision 0033: copies of a moved or missing project folder do not hold back the restore of another project.
      pendingRecovery: async () => blockingRecoveryCount(await journal.listPending()),
      restoreEnabled: async () => (await settings.snapshot()).settings.restoreSession,
    });
    // --- end S13 ---
    // --- S31: AI assistant (decision 0025). Keys in safeStorage, config/consent in app data, provider calls in main
    // only; NOOBIDE_AI_FAKE=<script.json> swaps in the scripted fake provider for tests (unpackaged builds only). ---
    const ai = setupAi({
      ipcMain,
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      userData: appData,
      projects,
      recent, // S39.1: removing a recent entry can offer to delete its saved chats
      // The keychain is touched only when a key is saved or read (never at startup): src/platform/secure-storage.ts.
      safeStorage: secureStorageFor(safeStorage, platformId()),
      logger,
      log: (level, event, fields) => appLog.write(level, event, fields),
      // Test-only switches, ignored in a packaged app (aiTestEnv, S36.1).
      isPackaged: app.isPackaged,
      fakeScript: process.env.NOOBIDE_AI_FAKE,
      fakeAgentScript: process.env.NOOBIDE_AI_FAKE_AGENT,
      problems: problems.capture, // S34: the agent's get_problems tool
      preview, // S34: console records and refresh for the agent
    });
    aiDrafts = ai.drafts; // S48.7
    Object.assign((globalThis as { __noobideTestHooks?: object }).__noobideTestHooks ?? {}, {
      // Fake provider only: what it was asked (purpose, model, provider). Never set in a normal run.
      aiRequests: () =>
        ai.fake?.requests.map((r) => ({
          provider: r.provider,
          purpose: r.purpose,
          model: r.model,
          // S38.2: how many images the request carried (counts only).
          images: r.messages.reduce((n, m) => n + (m.role === 'user' ? (m.images?.length ?? 0) : 0), 0),
        })) ?? null,
    });
    // --- end S31 ---
    // S23: onboarding walkthrough progress
    registerWalkthroughIpcHandlers(ipcMain, {
      allowedOrigin: devOrigin ?? APP_ORIGIN,
      store: new WalkthroughStore({ file: appDataPath(appData, 'walkthrough'), log: logger }),
    });
    void settingsLoaded.then(() => {
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
  });
}
