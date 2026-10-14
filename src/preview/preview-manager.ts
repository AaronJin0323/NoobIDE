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
  type PreviewFailure,
  type PreviewLogEntry,
  type PreviewStartError,
  type PreviewState,
  type PreviewStatus,
} from '../shared/ipc/preview-contract';
import { err, ok, type Result } from '../shared/result';
import { DEFAULT_LOG_BUFFER, LogBuffer } from './log-buffer';
import { createPreviewWebPreferences, insecurePreviewPreferences, partitionForProject } from './preview-options';
import { decidePreviewRequest, isAllowedNavigation } from './request-policy';
import { PreviewServer, TOKEN_HEADER } from './static-server';

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
  readonly watchdog?: WatchdogOptions;
  /** How often buffered log records are sent to the workbench. */
  readonly logFlushMs?: number;
}

interface LivePreview {
  readonly projectId: string;
  readonly server: PreviewServer;
  readonly view: WebContentsView;
  readonly partition: string;
  readonly window: BrowserWindow;
  readonly onWindowClosed: () => void;
  readonly timers: ReturnType<typeof setInterval>[];
  ping: { readonly id: number; readonly startedAt: number } | null;
  pingCounter: number;
  /** State to return to when the page answers again after being unresponsive. */
  beforeUnresponsive: PreviewState;
}

const DEFAULT_WATCHDOG: WatchdogOptions = { intervalMs: 1_000, timeoutMs: 3_000 };

export class PreviewManager {
  private live: LivePreview | null = null;
  private status: PreviewStatus = { state: 'stopped', projectId: null };
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private readonly logs = new LogBuffer(DEFAULT_LOG_BUFFER);
  /** Incremented on every start/stop so late async results of an older preview are ignored. */
  private generation = 0;
  private readonly configuredSessions = new WeakSet<Session>();
  /** Metadata of blocked requests for tests and diagnostics: scheme + host only, never paths or contents. */
  readonly blockedRequests: { readonly scheme: string; readonly host: string }[] = [];

  constructor(private readonly deps: PreviewManagerDeps) {}

  getStatus(): PreviewStatus {
    return this.status;
  }

  async start(projectId: string, window: BrowserWindow): Promise<Result<PreviewStatus, PreviewStartError>> {
    const root = this.deps.rootOf(projectId);
    if (root === undefined) return err('unknown-project', 'project is not open');
    if (window.isDestroyed()) return err('no-window', 'window is gone');
    await this.stop({ announce: false });
    const generation = ++this.generation;
    this.setStatus(window, { state: 'starting', projectId });

    let server: PreviewServer;
    try {
      server = await PreviewServer.start(root);
    } catch (e) {
      if (generation === this.generation)
        this.setStatus(window, { state: 'failed', projectId, failure: 'server-failed' });
      return err('server-failed', e instanceof Error ? e.message : 'server failed', e);
    }
    if (generation !== this.generation || window.isDestroyed()) {
      await server.close();
      return ok(this.status);
    }

    const partition = partitionForProject(server.root);
    const ses = electronSession.fromPartition(partition);
    this.configureSession(ses, server);
    const webPreferences = createPreviewWebPreferences(partition);
    const insecure = insecurePreviewPreferences(webPreferences);
    if (insecure.length > 0) throw new Error(`insecure preview webPreferences: ${insecure.join(', ')}`);

    const view = new WebContentsView({ webPreferences });
    view.setBackgroundColor('#ffffff');
    const onWindowClosed = () => void this.stop({ announce: false });
    window.once('closed', onWindowClosed);
    const live: LivePreview = {
      projectId,
      server,
      view,
      partition,
      window,
      onWindowClosed,
      timers: [],
      ping: null,
      pingCounter: 0,
      beforeUnresponsive: 'starting',
    };
    this.live = live;
    this.logs.clear();
    this.wireContents(live, view.webContents);
    window.contentView.addChildView(view);
    this.applyBounds();
    live.timers.push(setInterval(() => this.flushLogs(), this.deps.logFlushMs ?? 250));
    const watchdog = this.deps.watchdog ?? DEFAULT_WATCHDOG;
    live.timers.push(setInterval(() => this.checkResponsive(live, watchdog), watchdog.intervalMs));

    const url = `${server.origin}/`;
    this.setStatus(window, { state: 'starting', projectId, url });
    view.webContents.loadURL(url).catch(() => undefined); // Failures arrive as did-fail-load.
    return ok(this.status);
  }

  /** Destroys the view (crashing a hung page first) and shuts the server down. */
  async stop(options: { announce?: boolean } = {}): Promise<PreviewStatus> {
    const live = this.live;
    if (!live) return this.status;
    this.live = null;
    this.generation += 1;
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
    await live.server.close();
    const status: PreviewStatus = { state: 'stopped', projectId: null };
    if (options.announce ?? true) this.setStatus(live.window, status);
    else this.status = status;
    return this.status;
  }

  reload(): PreviewStatus {
    const live = this.live;
    if (!live || live.view.webContents.isDestroyed()) return this.status;
    // A hung page cannot reload itself; the user has to Stop (which recreates the view on the next Start).
    if (this.status.state === 'unresponsive' || this.status.state === 'starting') return this.status;
    if (this.status.state === 'failed' && this.status.failure === 'crashed') return this.status;
    this.update(live, 'refreshing');
    live.view.webContents.reloadIgnoringCache();
    return this.status;
  }

  /** A file of the project was saved: refresh the page (PLAN §3 automatic refresh after a successful save). */
  fileSaved(projectId: string): void {
    if (this.live?.projectId === projectId) this.reload();
  }

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
      previewPid: contents ? contents.getOSProcessId() : null,
      previewWebContentsId: contents ? contents.id : null,
      viewBounds: live ? live.view.getBounds() : null,
      viewVisible: live ? live.view.getVisible() : null,
      // getLastWebPreferences() exists at runtime but is missing from electron.d.ts; it reports the live values.
      webPreferences: contents
        ? (contents as unknown as { getLastWebPreferences(): Record<string, unknown> | null }).getLastWebPreferences()
        : null,
      blockedRequests: [...this.blockedRequests],
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

    contents.on('console-message', (event) => {
      const { message, level, lineNumber, sourceId } = event;
      this.pushLog({
        source: /^Uncaught\b/.test(message) ? 'exception' : 'console',
        level,
        message,
        ...(sourceId ? { url: sourceId } : {}),
        ...(lineNumber > 0 ? { line: lineNumber } : {}),
        at: Date.now(),
      });
    });

    contents.on('did-start-navigation', (event) => {
      if (!isCurrent() || !event.isMainFrame || event.isSameDocument) return;
      live.ping = null; // A ping sent to the previous document may never be answered.
      if (this.status.state === 'running') this.update(live, 'refreshing');
    });
    contents.on('did-stop-loading', () => {
      if (!isCurrent()) return;
      const state = this.status.state;
      if (state === 'starting' || state === 'refreshing') this.update(live, 'running');
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
      this.update(live, 'failed', 'load-failed');
    });
    contents.on('unresponsive', () => {
      if (isCurrent()) this.markUnresponsive(live);
    });
    contents.on('responsive', () => {
      if (isCurrent()) this.markResponsive(live);
    });
    contents.on('render-process-gone', () => {
      if (isCurrent()) this.update(live, 'failed', 'crashed');
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
    if (this.status.state === 'unresponsive' || this.status.state === 'failed') return;
    live.beforeUnresponsive = this.status.state;
    this.update(live, 'unresponsive');
  }

  private markResponsive(live: LivePreview): void {
    if (this.status.state !== 'unresponsive') return;
    const back = live.beforeUnresponsive;
    const contents = live.view.webContents;
    // If the page finished loading while it was busy, it is running now.
    const loading = !contents.isDestroyed() && contents.isLoadingMainFrame();
    this.update(live, back === 'running' || !loading ? 'running' : back);
  }

  private update(live: LivePreview, state: PreviewState, failure?: PreviewFailure): void {
    this.setStatus(live.window, {
      state,
      projectId: live.projectId,
      ...(failure ? { failure } : {}),
      ...(this.status.url ? { url: this.status.url } : {}),
    });
  }

  private setStatus(window: BrowserWindow, status: PreviewStatus): void {
    this.status = status;
    this.send(window, { kind: 'status', status });
  }

  private pushLog(entry: PreviewLogEntry): void {
    if (this.live) this.logs.push(entry);
  }

  private flushLogs(): void {
    const live = this.live;
    if (!live) return;
    const batch = this.logs.take();
    if (batch) this.send(live.window, { kind: 'log', entries: batch.entries, dropped: batch.dropped });
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
