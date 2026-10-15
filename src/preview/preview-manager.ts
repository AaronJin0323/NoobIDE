import {
  session as electronSession,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
} from 'electron';
import {
  PREVIEW_EVENT_CHANNEL,
  type PreviewBounds,
  type PreviewEvent,
  type PreviewLogEntry,
  type PreviewStartError,
  type PreviewStatus,
  type RefreshMode,
} from '../shared/ipc/preview-contract';
import { err, ok, type Result } from '../shared/result';
import { DEFAULT_LOG_BUFFER, LogBuffer } from './log-buffer';
import { createPreviewWebPreferences, insecurePreviewPreferences, partitionForProject } from './preview-options';
import { decidePreviewRequest, isAllowedNavigation } from './request-policy';
import { PreviewServer, TOKEN_HEADER } from './static-server';
import { NotOwnerError, ServerRegistry, type ServerOwner } from './server-registry';
import { DEFAULT_TYPING_PAUSE_MS, RefreshScheduler } from './refresh-scheduler';
import { INITIAL_MACHINE, transition, type PreviewMachine, type PreviewMachineEvent } from './state-machine';

/**
 * Owns the one live preview: its loopback server, its isolated WebContentsView and its state (S04.3, S05.1–S05.4,
 * PLAN §8). Main process only; main.ts creates one instance and ipc wiring calls into it.
 *
 * Isolation: the view has no preload (no IDE IPC), sandbox + context isolation, and a persistent session partition
 * per project folder. It runs in its own renderer process: different sessions never share a renderer process, so a
 * `while (true)` page cannot block the workbench. Stop crashes and destroys the view, which is the only reliable way
 * to interrupt a hung page (PLAN §8: stopping network loading does not interrupt an infinite loop).
 */

export interface WatchdogOptions {
  /** How often main pings the page. */
  readonly intervalMs: number;
  /** A ping unanswered for this long marks the page unresponsive. */
  readonly timeoutMs: number;
}

export interface PreviewManagerDeps {
  /** Real root of an open project, or undefined (ProjectService.rootOf). */
  rootOf(projectId: string): string | undefined;
  /** S13.2: URL path of the configured entry page ('' for index.html), from `.noobide/project.json`. */
  entryPathOf?(projectId: string): Promise<string>;
  readonly watchdog?: WatchdogOptions;
  /** How often buffered log records are sent to the workbench. */
  readonly logFlushMs?: number;
  /** S14.2: typing pause before an automatic refresh may run. */
  readonly typingPauseMs?: number;
  /** S15.4: opens a URL in the user's default browser (shell.openExternal). */
  openExternal?(url: string): Promise<void>;
}

interface LivePreview {
  readonly projectId: string;
  /** S14.6: webContents id of the workbench window that started it (the owner). */
  readonly windowId: number;
  readonly server: PreviewServer;
  readonly view: WebContentsView;
  readonly partition: string;
  readonly window: BrowserWindow;
  readonly onWindowClosed: () => void;
  readonly timers: ReturnType<typeof setInterval>[];
  ping: { readonly id: number; readonly startedAt: number } | null;
  pingCounter: number;
}

const RECENT_RECORDS = 100;
/** Console flood guard: more than FLOOD_LIMIT messages within FLOOD_WINDOW_MS pauses capture for FLOOD_PAUSE_MS. */
const FLOOD_WINDOW_MS = 100;
const FLOOD_LIMIT = 500;
const FLOOD_PAUSE_MS = 1_000;
const DEFAULT_WATCHDOG: WatchdogOptions = { intervalMs: 1_000, timeoutMs: 3_000 };

export class PreviewManager {
  private live: LivePreview | null = null;
  private status: PreviewStatus = { state: 'stopped', projectId: null, generation: 0 };
  /** S14.1: the pure state machine; `status` is its published form. */
  private machine: PreviewMachine = INITIAL_MACHINE;
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private readonly logs = new LogBuffer(DEFAULT_LOG_BUFFER);
  /** Incremented on every start/stop so late async results of an older preview are ignored. */
  private generation = 0;
  private readonly configuredSessions = new WeakSet<Session>();
  /** Metadata of blocked requests for tests and diagnostics: scheme + host only, never paths or contents. */
  readonly blockedRequests: { readonly scheme: string; readonly host: string }[] = [];
  /** The most recent raw records (S05.4) for diagnostics and tests; bounded, cleared with the preview. */
  private recent: PreviewLogEntry[] = [];
  /** Window of a start that is still waiting for its server (no view yet). */
  private startingWindow: BrowserWindow | null = null;
  /** S14.6: owner (project + window) of a start that is still waiting for its server. */
  private startingOwner: ServerOwner | null = null;
  /** S14.6: at most one loopback server per open project, owned by the project and window that started it. */
  private readonly servers = new ServerRegistry<PreviewServer>((root, options) => PreviewServer.start(root, options));
  /** A save arrived while the page was loading; reload when the load finishes. */
  private reloadPending = false;

  /** S14.2: automatic refresh after a confirmed save and a typing pause. */
  private readonly refresher: RefreshScheduler;

  constructor(private readonly deps: PreviewManagerDeps) {
    this.refresher = new RefreshScheduler({
      quietMs: deps.typingPauseMs ?? DEFAULT_TYPING_PAUSE_MS,
      refresh: () => void this.reload(),
    });
  }

  getStatus(): PreviewStatus {
    return this.status;
  }

  async start(projectId: string, window: BrowserWindow): Promise<Result<PreviewStatus, PreviewStartError>> {
    const root = this.deps.rootOf(projectId);
    if (root === undefined) return err('unknown-project', 'project is not open');
    if (window.isDestroyed()) return err('no-window', 'window is gone');
    await this.stop({ announce: false });
    const generation = ++this.generation;
    this.startingWindow = window;
    const owner: ServerOwner = { projectId, windowId: window.webContents.id };
    this.startingOwner = owner;
    this.reloadPending = false;
    this.refresher.cancel();
    this.apply(window, projectId, { type: 'start' });

    let server: PreviewServer;
    try {
      // S14.6: the project's one server (the registry reuses the previous port when free: storage is per origin, so
      // a stable port keeps localStorage).
      server = await this.servers.acquire(owner, root);
    } catch (e) {
      if (this.startingOwner === owner) this.startingOwner = null;
      if (e instanceof NotOwnerError) {
        if (generation === this.generation) this.apply(window, null, { type: 'stop' });
        return err('not-owner', e.message);
      }
      if (generation === this.generation) this.apply(window, projectId, { type: 'server-failed' });
      return err('server-failed', e instanceof Error ? e.message : 'server failed', e);
    }
    // S13.2: the configured entry page ('' = the server's index.html); a broken config never blocks the preview.
    // Read while this start is current; the generation check below catches a Stop that arrived meanwhile.
    const entryPath = (await this.deps.entryPathOf?.(projectId).catch(() => '')) ?? '';
    if (generation !== this.generation || window.isDestroyed()) {
      await this.servers.release(projectId, owner);
      return ok(this.status);
    }

    const partition = partitionForProject(server.root);
    const webPreferences = createPreviewWebPreferences(partition);
    const insecure = insecurePreviewPreferences(webPreferences);
    if (insecure.length > 0) {
      await this.servers.release(projectId);
      throw new Error(`insecure preview webPreferences: ${insecure.join(', ')}`);
    }
    try {
      return this.attachView(projectId, window, owner, server, partition, webPreferences, entryPath);
    } catch (e) {
      // S14.6: nothing may keep listening without a view (e.g. the window went away mid-start).
      if (this.live?.projectId === projectId) await this.stop({ announce: false });
      else await this.servers.release(projectId);
      if (this.startingOwner === owner) this.startingOwner = null;
      this.startingWindow = null;
      if (!window.isDestroyed()) this.apply(window, projectId, { type: 'server-failed' });
      return err('server-failed', e instanceof Error ? e.message : 'preview view failed', e);
    }
  }

  private attachView(
    projectId: string,
    window: BrowserWindow,
    owner: ServerOwner,
    server: PreviewServer,
    partition: string,
    webPreferences: Electron.WebPreferences,
    entryPath: string,
  ): Result<PreviewStatus, PreviewStartError> {
    const ses = electronSession.fromPartition(partition);
    this.configureSession(ses, server);
    const view = new WebContentsView({ webPreferences });
    view.setBackgroundColor('#ffffff');
    const onWindowClosed = () => {
      void this.stop({ announce: false });
      void this.servers.releaseWindow(owner.windowId); // S14.6: defence in depth
    };
    window.once('closed', onWindowClosed);
    const live: LivePreview = {
      projectId,
      windowId: owner.windowId,
      server,
      view,
      partition,
      window,
      onWindowClosed,
      timers: [],
      ping: null,
      pingCounter: 0,
    };
    this.live = live;
    this.startingWindow = null;
    this.startingOwner = null;
    this.logs.clear();
    this.recent = [];
    this.wireContents(live, view.webContents);
    window.contentView.addChildView(view);
    this.applyBounds();
    live.timers.push(setInterval(() => this.flushLogs(), this.deps.logFlushMs ?? 250));
    const watchdog = this.deps.watchdog ?? DEFAULT_WATCHDOG;
    live.timers.push(setInterval(() => this.checkResponsive(live, watchdog), watchdog.intervalMs));

    const url = `${server.origin}/${entryPath}`;
    this.setStatus(window, { ...this.status, url });
    view.webContents.loadURL(url).catch(() => undefined); // Failures arrive as did-fail-load.
    return ok(this.status);
  }

  /** Destroys the view (crashing a hung page first) and shuts the server down. */
  async stop(options: { announce?: boolean } = {}): Promise<PreviewStatus> {
    const live = this.live;
    // Always invalidate a start that is still waiting for its server, so Stop during startup is never lost.
    this.generation += 1;
    this.reloadPending = false;
    this.refresher.cancel();
    if (!live) {
      const starting = this.startingWindow;
      this.startingWindow = null;
      this.startingOwner = null;
      if (this.status.state !== 'stopped') {
        if (starting && !starting.isDestroyed() && (options.announce ?? true)) {
          this.apply(starting, null, { type: 'stop' });
        } else this.apply(null, null, { type: 'stop' });
      }
      return this.status;
    }
    this.live = null;
    for (const timer of live.timers) clearInterval(timer);
    live.window.removeListener('closed', live.onWindowClosed);
    const contents = live.view.webContents;
    if (!contents.isDestroyed()) {
      // A page in an endless loop never runs unload handlers or answers a polite close; end its process first.
      contents.forcefullyCrashRenderer();
      if (!live.window.isDestroyed()) live.window.contentView.removeChildView(live.view);
      contents.close();
    }
    this.logs.clear();
    await this.servers.release(live.projectId);
    this.apply((options.announce ?? true) ? live.window : null, null, { type: 'stop' });
    return this.status;
  }

  reload(): PreviewStatus {
    const live = this.live;
    if (!live || live.view.webContents.isDestroyed()) return this.status;
    // Still loading: refresh once the load has finished, so a save during startup is not lost.
    if (this.status.state === 'starting' || this.status.state === 'refreshing') {
      this.reloadPending = true;
      return this.status;
    }
    // A hung page cannot reload itself (the user has to Stop, which recreates the view on the next Start); a
    // crashed page has nothing to reload. The state machine refuses both.
    const before = this.machine;
    this.update(live, { type: 'refresh' });
    if (this.machine === before) return this.status;
    live.view.webContents.reloadIgnoringCache();
    return this.status;
  }

  /**
   * A file of the project was saved (confirmed write). S14.2: in automatic mode the page refreshes once the user
   * pauses typing (PLAN §3); in manual mode it only notes that the page may be older than the files.
   */
  fileSaved(projectId: string, mode: RefreshMode = 'auto'): void {
    const live = this.live;
    if (live?.projectId !== projectId) return;
    if (mode === 'auto') {
      this.refresher.saved();
      return;
    }
    if (!this.status.outdated && this.status.state !== 'stopped') {
      this.setStatus(live.window, { ...this.status, outdated: true });
    }
  }

  /** S14.2: a key was typed in the code editor; a pending automatic refresh waits for the pause. */
  typing(): void {
    this.refresher.typing();
  }

  // --- S14.5 / S15.4: toolbar actions (owner checks are done by the IPC layer) ---

  /**
   * S14.5: clears the project's preview storage — its own partition only (localStorage, IndexedDB, cookies, cache
   * storage, service workers, HTTP cache). A page of that project that is showing reloads, so it starts empty.
   */
  async clearData(projectId: string): Promise<Result<null, 'unknown-project'>> {
    const root = this.deps.rootOf(projectId);
    if (root === undefined) return err('unknown-project', 'project is not open');
    const ses = electronSession.fromPartition(partitionForProject(root));
    await ses.clearStorageData();
    await ses.clearCache();
    if (this.live?.projectId === projectId) this.reload();
    return ok(null);
  }

  /**
   * S15.4: opens the page that is showing (same path and query) in the default browser through a one-time grant;
   * the grant URL goes straight to the OS and never to the renderer or a log.
   */
  async openExternal(): Promise<Result<null, 'not-running'>> {
    const live = this.live;
    if (!live || !this.deps.openExternal) return err('not-running', 'no preview');
    let target = '/';
    const contents = live.view.webContents;
    const shown = !contents.isDestroyed() ? contents.getURL() : (this.status.url ?? '');
    try {
      const url = new URL(shown || (this.status.url ?? ''));
      if (url.origin === live.server.origin) target = `${url.pathname}${url.search}`;
    } catch {
      // keep '/'
    }
    await this.deps.openExternal(live.server.grantExternal(target));
    return ok(null);
  }

  /** S15.4 (advanced): Chromium's developer tools for the preview page, in their own window. */
  openDevTools(): Result<null, 'not-running'> {
    const contents = this.live?.view.webContents;
    if (!contents || contents.isDestroyed()) return err('not-running', 'no preview');
    contents.openDevTools({ mode: 'detach', activate: true });
    return ok(null);
  }

  // --- S14.6: ownership and project lifecycle ---

  /**
   * Whether `requester` (a workbench window, optionally naming a project) owns the current preview: the window
   * that started it, and the same project when one is named. With no view and no start in flight there is nothing
   * to protect (at most a failed status to clear), so the answer is true. Toolbar actions from another window, or for a project that is no longer the
   * previewed one (a late click after a project switch), are refused by the IPC layer with `not-owner`.
   */
  isOwner(requester: { readonly windowId: number; readonly projectId?: string | undefined }): boolean {
    const current = this.live ? { windowId: this.live.windowId, projectId: this.live.projectId } : this.startingOwner;
    if (!current) return true;
    return current.windowId === requester.windowId && (requester.projectId ?? current.projectId) === current.projectId;
  }

  /** A project was opened (or switched to) in a window: another project's preview and servers shut down. */
  async projectSwitched(projectId: string): Promise<void> {
    const previewed = this.live?.projectId ?? this.startingOwner?.projectId ?? this.status.projectId;
    if (previewed !== null && previewed !== projectId) await this.stop();
    await this.servers.releaseAllExcept(projectId);
  }

  /** A project was closed: its preview stops and its server shuts down. */
  async projectClosed(projectId: string): Promise<void> {
    const previewed = this.live?.projectId ?? this.startingOwner?.projectId ?? this.status.projectId;
    if (previewed === null || previewed === projectId) await this.stop();
    await this.servers.release(projectId);
  }

  /** Projects with a running (or starting) server — for tests and diagnostics. */
  serverProjects(): string[] {
    return this.servers.projects;
  }
  // --- end S14.6 ---

  setBounds(bounds: PreviewBounds): void {
    this.bounds = bounds;
    this.applyBounds();
  }

  /** Read-only snapshot for the e2e suite. No page content, no file paths. */
  debugInfo() {
    const live = this.live;
    const contents = live && !live.view.webContents.isDestroyed() ? live.view.webContents : null;
    return {
      status: this.status,
      origin: live?.server.origin ?? null,
      partition: live?.partition ?? null,
      serverProjects: this.servers.projects, // S14.6
      generation: this.status.generation ?? 0, // S14.1
      previewPid: contents ? contents.getOSProcessId() : null,
      previewWebContentsId: contents ? contents.id : null,
      viewBounds: live ? live.view.getBounds() : null,
      viewVisible: live ? live.view.getVisible() : null,
      // getLastWebPreferences() exists at runtime but is missing from electron.d.ts; it reports the live values.
      webPreferences: contents
        ? (contents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }).getLastWebPreferences()
        : null,
      blockedRequests: [...this.blockedRequests],
      recentRecords: [...this.recent],
    };
  }

  private applyBounds(): void {
    const live = this.live;
    if (!live || live.window.isDestroyed()) return;
    const { x, y, width, height, visible } = this.bounds;
    const show = visible && width >= 1 && height >= 1;
    live.view.setVisible(show);
    if (!show) return;
    // Bounds arrive in workbench CSS pixels; the view is positioned in window DIPs.
    const zoom = live.window.webContents.getZoomFactor();
    live.view.setBounds({
      x: Math.round(x * zoom),
      y: Math.round(y * zoom),
      width: Math.round(width * zoom),
      height: Math.round(height * zoom),
    });
  }

  private configureSession(ses: Session, server: PreviewServer): void {
    if (!this.configuredSessions.has(ses)) {
      this.configuredSessions.add(ses);
      // No camera, microphone, location, notifications, clipboard reads, MIDI, USB…: the page is untrusted.
      ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      // A page must not drop files into the user's Downloads folder.
      ses.on('will-download', (event) => event.preventDefault());
    }
    // webRequest keeps one listener per event and session: re-registering replaces the previous server's.
    const origin = server.origin;
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (decidePreviewRequest(details.url, origin) === 'allow') {
        callback({});
        return;
      }
      if (this.blockedRequests.length < 500) this.blockedRequests.push(requestMeta(details.url));
      callback({ cancel: true });
    });
    ses.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: server.token } });
    });
    ses.webRequest.onCompleted((details) => {
      if (details.statusCode < 400) return;
      this.pushLog({
        source: 'network',
        level: 'error',
        message: `${details.statusCode} ${details.method} ${details.resourceType}`,
        url: details.url,
        status: details.statusCode,
        resourceType: details.resourceType,
        at: Date.now(),
      });
    });
    ses.webRequest.onErrorOccurred((details) => {
      if (details.error === 'net::ERR_ABORTED') return; // Navigation away or reload, not a failure.
      this.pushLog({
        source: 'network',
        level: 'error',
        message: `${details.error} ${details.method} ${details.resourceType}`,
        url: details.url,
        resourceType: details.resourceType,
        at: Date.now(),
      });
    });
  }

  private wireContents(live: LivePreview, contents: WebContents): void {
    const origin = live.server.origin;
    const isCurrent = () => this.live === live;
    contents.setWindowOpenHandler(({ url }) => {
      this.pushLog({ source: 'page-load', level: 'warning', message: 'window.open blocked', url, at: Date.now() });
      return { action: 'deny' };
    });
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (isAllowedNavigation(url, origin)) return;
      event.preventDefault();
      this.pushLog({ source: 'page-load', level: 'warning', message: 'navigation blocked', url, at: Date.now() });
    };
    contents.on('will-navigate', (event) => guard(event, event.url));
    contents.on('will-redirect', (event) => guard(event, event.url));
    contents.on('will-attach-webview', (event) => event.preventDefault());

    // Console flood guard (S05.3). Electron builds an event object in the main process for every console message
    // while a listener is attached; a page logging ~400k messages/s would keep main (and with it all keyboard and
    // mouse input) busy. Above FLOOD_LIMIT messages per FLOOD_WINDOW_MS the listener is detached for
    // FLOOD_PAUSE_MS: those messages are skipped without counting, and the batch says so ("at least N dropped").
    let windowStart = 0;
    let inWindow = 0;
    const onConsole = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      const now = Date.now();
      if (now - windowStart > FLOOD_WINDOW_MS) {
        windowStart = now;
        inWindow = 0;
      }
      inWindow += 1;
      if (inWindow > FLOOD_LIMIT) {
        contents.off('console-message', onConsole);
        this.logs.markThrottled();
        live.timers.push(
          setTimeout(() => {
            if (this.live !== live || contents.isDestroyed()) return;
            windowStart = Date.now();
            inWindow = 0;
            contents.on('console-message', onConsole);
          }, FLOOD_PAUSE_MS),
        );
        return;
      }
      const { message, level, lineNumber, sourceId } = event;
      // Electron's own development-only warnings ("Electron Security Warning…") are not the user's output.
      if (sourceId.startsWith('node:electron/')) return;
      this.pushLog({
        source: /^Uncaught\b/.test(message) ? 'exception' : 'console',
        level,
        message,
        ...(sourceId ? { url: sourceId } : {}),
        ...(lineNumber > 0 ? { line: lineNumber } : {}),
        at: now,
      });
    };
    contents.on('console-message', onConsole);

    contents.on('did-start-navigation', (event) => {
      if (!isCurrent() || !event.isMainFrame || event.isSameDocument) return;
      live.ping = null; // A ping sent to the previous document may never be answered.
      this.update(live, { type: 'navigate' });
    });
    contents.on('did-stop-loading', () => {
      if (!isCurrent()) return;
      this.update(live, { type: 'load-finished' });
      if (this.reloadPending && this.status.state === 'running') {
        this.reloadPending = false;
        this.reload();
      }
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isCurrent() || !isMainFrame || errorCode === -3) return; // -3: aborted by a newer navigation.
      this.pushLog({
        source: 'page-load',
        level: 'error',
        message: errorDescription,
        url: validatedURL,
        at: Date.now(),
      });
      this.update(live, { type: 'load-failed' });
    });
    contents.on('unresponsive', () => {
      if (isCurrent()) this.markUnresponsive(live);
    });
    contents.on('responsive', () => {
      if (isCurrent()) this.markResponsive(live);
    });
    contents.on('render-process-gone', () => {
      if (isCurrent()) this.update(live, { type: 'crashed' });
    });
  }

  /** Pings the page's main thread. Chromium's own 'unresponsive' event needs pending input; this does not. */
  private checkResponsive(live: LivePreview, options: WatchdogOptions): void {
    if (this.live !== live) return;
    const contents = live.view.webContents;
    if (contents.isDestroyed() || this.status.state === 'failed') return;
    if (live.ping) {
      if (Date.now() - live.ping.startedAt >= options.timeoutMs) this.markUnresponsive(live);
      return;
    }
    const ping = { id: ++live.pingCounter, startedAt: Date.now() };
    live.ping = ping;
    let frame;
    try {
      frame = contents.mainFrame;
    } catch {
      live.ping = null;
      return;
    }
    frame.executeJavaScript('0').then(
      () => {
        if (this.live !== live || live.ping?.id !== ping.id) return;
        live.ping = null;
        this.markResponsive(live);
      },
      () => {
        if (live.ping?.id === ping.id) live.ping = null;
      },
    );
  }

  private markUnresponsive(live: LivePreview): void {
    this.update(live, { type: 'unresponsive' });
  }

  private markResponsive(live: LivePreview): void {
    if (this.status.state !== 'unresponsive') return;
    const contents = live.view.webContents;
    this.update(live, { type: 'responsive', loading: !contents.isDestroyed() && contents.isLoadingMainFrame() });
  }

  private update(live: LivePreview, event: PreviewMachineEvent): void {
    this.apply(live.window, live.projectId, event);
  }

  /**
   * S14.1: feeds an event to the state machine and publishes the result. Nothing is sent when the event does not
   * apply (the machine returns the same object). `window` null: update silently (no workbench to tell).
   */
  private apply(window: BrowserWindow | null, projectId: string | null, event: PreviewMachineEvent): void {
    const next = transition(this.machine, event);
    if (next === this.machine) return;
    this.machine = next;
    const url = next.state === 'stopped' || event.type === 'start' ? undefined : this.status.url;
    // S14.2: a new page load (or Stop) shows the saved files again; other changes keep the "outdated" note.
    const fresh = event.type === 'start' || event.type === 'refresh' || event.type === 'navigate';
    const outdated = !fresh && next.state !== 'stopped' && this.status.outdated === true;
    const status: PreviewStatus = {
      state: next.state,
      projectId: next.state === 'stopped' ? null : projectId,
      ...(next.failure ? { failure: next.failure } : {}),
      ...(url ? { url } : {}),
      generation: next.generation,
      ...(outdated ? { outdated } : {}),
    };
    if (window) this.setStatus(window, status);
    else this.status = status;
  }

  private setStatus(window: BrowserWindow, status: PreviewStatus): void {
    this.status = status;
    this.send(window, { kind: 'status', status });
  }

  private pushLog(entry: PreviewLogEntry): void {
    if (!this.live) return;
    this.logs.push(entry);
    if (this.recent.length >= RECENT_RECORDS) this.recent.shift();
    const max = DEFAULT_LOG_BUFFER.maxMessageLength;
    this.recent.push(entry.message.length > max ? { ...entry, message: `${entry.message.slice(0, max)}…` } : entry);
  }

  private flushLogs(): void {
    const live = this.live;
    if (!live) return;
    const batch = this.logs.take();
    if (batch) {
      this.send(live.window, {
        kind: 'log',
        entries: batch.entries,
        dropped: batch.dropped,
        throttled: batch.throttled,
      });
    }
  }

  private send(window: BrowserWindow, event: PreviewEvent): void {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(PREVIEW_EVENT_CHANNEL, event);
    }
  }
}

function requestMeta(url: string): { scheme: string; host: string } {
  try {
    const u = new URL(url);
    return { scheme: u.protocol.replace(/:$/, ''), host: u.host };
  } catch {
    return { scheme: 'invalid', host: '' };
  }
}
