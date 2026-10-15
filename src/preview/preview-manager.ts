import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
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
import { DEFAULT_LOG_BUFFER, LogBuffer, sanitizeLogUrl } from './log-buffer';
import { CONSOLE_LIMIT, pageGuardSource, parseLimiterSummary } from './page-guard';
import { createPreviewWebPreferences, insecurePreviewPreferences, partitionForProject } from './preview-options';
import { decidePreviewRequest, isAllowedNavigation } from './request-policy';
import { PreviewProxy } from './preview-proxy';
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

/**
 * S16.2: hook for the runtime capture adapter (src/main/problems-bridge.ts → src/diagnostics/runtime-capture.ts).
 * Gets every raw record the page produces (after the console flood guard), the session (project + server origin)
 * and the main-frame navigations that define refresh generations (S16.3).
 */
export interface PreviewCaptureHook {
  sessionStarted(
    session: { readonly projectId: string; readonly origin: string },
    /** The workbench that started the preview (receives change notifications). */
    target: { isDestroyed(): boolean; send(channel: string, ...args: never[]): void },
  ): void;
  navigationStarted(): void;
  navigationCommitted(): void;
  entry(entry: PreviewLogEntry): void;
  sessionEnded(): void;
}

export interface PreviewManagerDeps {
  /** Real root of an open project, or undefined (ProjectService.rootOf). */
  rootOf(projectId: string): string | undefined;
  /** S13.2: URL path of the configured entry page ('' for index.html), from `.noobide/project.json`. */
  entryPathOf?(projectId: string): Promise<string>;
  readonly watchdog?: WatchdogOptions;
  /** How often buffered log records are sent to the workbench. */
  readonly logFlushMs?: number;
  /**
   * S16.2: runtime capture adapter. Receives every raw record admitted from the page — after the in-page console
   * rate limit (docs/decisions/0016) and with its URLs sanitised (decision 0015).
   */
  readonly capture?: PreviewCaptureHook;
}

interface LivePreview {
  readonly projectId: string;
  readonly server: PreviewServer;
  /** The session's only route onto the network (docs/decisions/0015). */
  readonly proxy: PreviewProxy;
  readonly view: WebContentsView;
  readonly partition: string;
  readonly window: BrowserWindow;
  readonly onWindowClosed: () => void;
  readonly timers: ReturnType<typeof setInterval>[];
  /** Per-preview secret in the page guard's summary messages, so a page cannot forge them (decision 0016). */
  readonly guardNonce: string;
  /** Whether the page guard (console limit) was installed; false only if installing timed out or failed. */
  pageGuarded: boolean;
  ping: { readonly id: number; readonly startedAt: number } | null;
  pingCounter: number;
  /** State to return to when the page answers again after being unresponsive. */
  beforeUnresponsive: PreviewState;
}

const RECENT_RECORDS = 100;
/**
 * Console flood guard: more than FLOOD_LIMIT messages within FLOOD_WINDOW_MS pauses capture for FLOOD_PAUSE_MS.
 * The in-page rate limit (page-guard.ts) normally keeps a page far below this; the guard is the backstop for a page
 * that bypasses it (decision 0016), so it allows the limiter's budget with room for two windows back to back.
 */
const FLOOD_WINDOW_MS = 1_000;
const FLOOD_LIMIT = 3 * CONSOLE_LIMIT;
const FLOOD_PAUSE_MS = 1_000;
const DEFAULT_WATCHDOG: WatchdogOptions = { intervalMs: 1_000, timeoutMs: 3_000 };

export class PreviewManager {
  private live: LivePreview | null = null;
  private status: PreviewStatus = { state: 'stopped', projectId: null };
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
  private readonly logs = new LogBuffer(DEFAULT_LOG_BUFFER);
  /** Incremented on every start/stop so late async results of an older preview are ignored. */
  private generation = 0;
  private readonly configuredSessions = new WeakSet<Session>();
  /** Metadata of blocked requests for tests and diagnostics: scheme + host only, never paths or contents.
   * `scheme: 'proxy'` marks connections the network proxy refused (docs/decisions/0015). */
  readonly blockedRequests: { readonly scheme: string; readonly host: string }[] = [];
  /** The most recent raw records (S05.4) for diagnostics and tests; bounded, cleared with the preview. */
  private recent: PreviewLogEntry[] = [];
  /** Window of a start that is still waiting for its server (no view yet). */
  private startingWindow: BrowserWindow | null = null;
  /** A save arrived while the page was loading; reload when the load finishes. */
  private reloadPending = false;
  /** Last port per project root, reused so the page keeps its origin (and its storage) across starts. */
  private readonly lastPorts = new Map<string, number>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PreviewManagerDeps) {}

  getStatus(): PreviewStatus {
    return this.status;
  }

  /**
   * Starts are serialised: each one reconfigures the per-project session (proxy, webRequest handlers), so a stale
   * start must never interleave with a newer one. A newer start (or Stop) invalidates an older one through
   * `generation`; the older one then cleans up at its next check.
   */
  start(projectId: string, window: BrowserWindow): Promise<Result<PreviewStatus, PreviewStartError>> {
    const run = this.startQueue.then(() => this.startNow(projectId, window));
    this.startQueue = run.catch(() => undefined);
    this.generation += 1; // invalidate a start that is still in progress
    return run;
  }

  private async startNow(projectId: string, window: BrowserWindow): Promise<Result<PreviewStatus, PreviewStartError>> {
    const root = this.deps.rootOf(projectId);
    if (root === undefined) return err('unknown-project', 'project is not open');
    if (window.isDestroyed()) return err('no-window', 'window is gone');
    await this.stop({ announce: false });
    const generation = ++this.generation;
    this.startingWindow = window;
    this.reloadPending = false;
    this.setStatus(window, { state: 'starting', projectId });

    let server: PreviewServer;
    try {
      // Reuse the project's previous port when free: storage is per origin, so a stable port keeps localStorage.
      server = await PreviewServer.start(root, { preferredPort: this.lastPorts.get(root) });
      this.lastPorts.set(root, server.port);
    } catch (e) {
      if (generation === this.generation)
        this.setStatus(window, { state: 'failed', projectId, failure: 'server-failed' });
      return err('server-failed', e instanceof Error ? e.message : 'server failed', e);
    }
    // S13.2: the configured entry page ('' = the server's index.html); a broken config never blocks the preview.
    // Read while this start is current; the generation check below catches a Stop that arrived meanwhile.
    const entryPath = (await this.deps.entryPathOf?.(projectId).catch(() => '')) ?? '';
    if (generation !== this.generation || window.isDestroyed()) {
      await server.close();
      return ok(this.status);
    }

    const partition = partitionForProject(server.root);
    const ses = electronSession.fromPartition(partition);
    const webPreferences = createPreviewWebPreferences(partition);
    const insecure = insecurePreviewPreferences(webPreferences);
    if (insecure.length > 0) {
      await server.close();
      throw new Error(`insecure preview webPreferences: ${insecure.join(', ')}`);
    }
    // S05.5: every request of the session goes through the proxy, which decides on resolved addresses. Service
    // workers left by an earlier run are removed (new registrations are refused in configureSession).
    let proxy: PreviewProxy | undefined;
    try {
      proxy = await this.startProxy(ses, server);
      this.configureSession(ses, server);
      await ses.clearStorageData({ storages: ['serviceworkers'] });
    } catch (e) {
      await proxy?.close();
      await server.close();
      if (generation === this.generation)
        this.setStatus(window, { state: 'failed', projectId, failure: 'server-failed' });
      return err('server-failed', e instanceof Error ? e.message : 'proxy failed', e);
    }

    if (generation !== this.generation || window.isDestroyed()) {
      await proxy.close();
      await server.close();
      return ok(this.status);
    }

    const view = new WebContentsView({ webPreferences });
    view.setBackgroundColor('#ffffff');
    // No UDP outside the proxy: WebRTC cannot reach local or LAN addresses directly.
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    // S05.7: the console rate limit must be in place before the first page script runs.
    const guardNonce = randomBytes(8).toString('hex');
    const pageGuarded = await installPageGuard(view.webContents, { source: pageGuardSource(guardNonce) });
    if (generation !== this.generation || window.isDestroyed()) {
      view.webContents.close();
      await proxy.close();
      await server.close();
      return ok(this.status);
    }
    const onWindowClosed = () => void this.stop({ announce: false });
    window.once('closed', onWindowClosed);
    const live: LivePreview = {
      projectId,
      server,
      proxy,
      view,
      partition,
      window,
      onWindowClosed,
      timers: [],
      guardNonce,
      pageGuarded,
      ping: null,
      pingCounter: 0,
      beforeUnresponsive: 'starting',
    };
    this.live = live;
    this.startingWindow = null;
    this.logs.clear();
    this.recent = [];
    this.deps.capture?.sessionStarted({ projectId, origin: server.origin }, window.webContents);
    this.wireContents(live, view.webContents);
    window.contentView.addChildView(view);
    this.applyBounds();
    live.timers.push(setInterval(() => this.flushLogs(), this.deps.logFlushMs ?? 250));
    const watchdog = this.deps.watchdog ?? DEFAULT_WATCHDOG;
    live.timers.push(setInterval(() => this.checkResponsive(live, watchdog), watchdog.intervalMs));

    const url = `${server.origin}/${entryPath}`;
    this.setStatus(window, { state: 'starting', projectId, url });
    view.webContents.loadURL(url).catch(() => undefined); // Failures arrive as did-fail-load.
    return ok(this.status);
  }

  /** Destroys the view (crashing a hung page first) and shuts the server down. */
  async stop(options: { announce?: boolean } = {}): Promise<PreviewStatus> {
    const live = this.live;
    // Always invalidate a start that is still waiting for its server, so Stop during startup is never lost.
    this.generation += 1;
    this.reloadPending = false;
    if (!live) {
      const starting = this.startingWindow;
      this.startingWindow = null;
      if (this.status.state !== 'stopped') {
        const status: PreviewStatus = { state: 'stopped', projectId: null };
        if (starting && !starting.isDestroyed() && (options.announce ?? true)) this.setStatus(starting, status);
        else this.status = status;
      }
      return this.status;
    }
    this.live = null;
    this.deps.capture?.sessionEnded();
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
    await live.proxy.close();
    await live.server.close();
    const status: PreviewStatus = { state: 'stopped', projectId: null };
    if (options.announce ?? true) this.setStatus(live.window, status);
    else this.status = status;
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
    // A hung page cannot reload itself; the user has to Stop (which recreates the view on the next Start).
    if (this.status.state === 'unresponsive') return this.status;
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
      pageGuarded: live?.pageGuarded ?? null,
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
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      // S05.5: no service workers. A registration would outlive refreshes and restarts and could answer requests
      // in place of the project's files; Chromium marks the worker's script request with this header.
      if (Object.keys(details.requestHeaders).some((h) => h.toLowerCase() === 'service-worker')) {
        if (this.blockedRequests.length < 500) this.blockedRequests.push({ scheme: 'service-worker', host: '' });
        callback({ cancel: true });
        return;
      }
      if (urlOriginOf(details.url) !== origin) {
        callback({});
        return;
      }
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
        ...(details.referrer ? { initiator: details.referrer } : {}),
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
        ...(details.referrer ? { initiator: details.referrer } : {}),
        at: Date.now(),
      });
    });
  }

  /** Starts the session's network proxy and routes every request of the session through it (decision 0015). */
  private async startProxy(ses: Session, server: PreviewServer): Promise<PreviewProxy> {
    const proxy = await PreviewProxy.start({
      serverHost: '127.0.0.1',
      serverPort: server.port,
      // Chromium's own resolver (network service): same answers the page would get, no libuv threadpool use.
      resolve: async (host) => (await ses.resolveHost(host)).endpoints.map((e) => e.address),
      // This machine's addresses and the networks they sit in: with IPv6 (and public IPv4 LANs) the LAN's
      // devices have global addresses, so "not private" is not enough.
      localNetworks: () =>
        Object.values(networkInterfaces())
          .flat()
          .filter((i) => i !== undefined && !i.internal)
          .map((i) => i?.cidr ?? '')
          .filter((c) => c !== ''),
      localAddresses: () =>
        Object.values(networkInterfaces())
          .flat()
          .map((i) => i?.address ?? '')
          .filter((a) => a !== ''),
      onBlocked: ({ host, port }) => {
        if (this.blockedRequests.length < 500) this.blockedRequests.push({ scheme: 'proxy', host: `${host}:${port}` });
      },
    });
    try {
      // `<-loopback>` removes Chromium's implicit loopback bypass: even 127.0.0.1 goes through the proxy, so no
      // request type that webRequest does not see (e.g. WebTransport) can reach a loopback service directly.
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy.proxyRules, proxyBypassRules: '<-loopback>' });
      await ses.closeAllConnections();
    } catch (e) {
      await proxy.close();
      throw e;
    }
    return proxy;
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
    // S05.5: a beforeunload handler must never keep the page alive: refresh, Stop and closing the IDE always win.
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    // The page guard (docs/decisions/0016) stays installed for the view's lifetime; reinstall if it was detached.
    contents.debugger.on('detach', () => {
      if (!isCurrent() || contents.isDestroyed()) return;
      void installPageGuard(contents, { source: pageGuardSource(live.guardNonce), navigateFirst: false }).then((ok) => {
        live.pageGuarded = ok;
      });
    });

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
      // The in-page rate limit (S05.7) reports what it suppressed; the IDE shows it as dropped messages.
      const suppressed = parseLimiterSummary(message, sourceId, live.guardNonce);
      if (suppressed !== null) {
        this.logs.addDropped(suppressed);
        return;
      }
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
      this.deps.capture?.navigationStarted(); // S16.3: a new page load (generation) is on its way
      live.ping = null; // A ping sent to the previous document may never be answered.
      if (this.status.state === 'running') this.update(live, 'refreshing');
    });
    // S16.3: the new document committed; from now on the page's records belong to the new generation.
    contents.on('did-navigate', () => {
      if (isCurrent()) this.deps.capture?.navigationCommitted();
    });
    contents.on('did-stop-loading', () => {
      if (!isCurrent()) return;
      const state = this.status.state;
      if (state === 'starting' || state === 'refreshing') this.update(live, 'running');
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

  private pushLog(raw: PreviewLogEntry): void {
    if (!this.live) return;
    // S05.5: URLs can be long or carry content (data: URLs, credentials); records only keep a sanitised form.
    const entry: PreviewLogEntry = {
      ...raw,
      ...(raw.url === undefined ? {} : { url: sanitizeLogUrl(raw.url) }),
      ...(raw.initiator === undefined ? {} : { initiator: sanitizeLogUrl(raw.initiator) }),
    };
    this.deps.capture?.entry(entry);
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

const GUARD_TIMEOUT_MS = 5_000;
const guardListening = new WeakSet<WebContents>();
const guardSources = new WeakMap<WebContents, string>();
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } as const;

/**
 * Installs the page guard (console rate limit, alert reporting — page-guard.ts, decision 0016) through the DevTools
 * protocol, before any page script runs: into every future document of the view, every out-of-process iframe and
 * every dedicated worker (workers send their console messages to main too). Other DevTools clients (the user's
 * DevTools) coexist. `Page.addScriptToEvaluateOnNewDocument` needs the Page domain and an existing document: on a
 * view that never navigated the commands never answer, so a fresh view first loads about:blank. Best effort with a
 * timeout: without the guard the preview still works and main's flood guard still bounds the console.
 */
async function installPageGuard(
  contents: WebContents,
  options: { readonly source: string; readonly navigateFirst?: boolean },
): Promise<boolean> {
  guardSources.set(contents, options.source);
  const install = async () => {
    if (options.navigateFirst ?? true) await contents.loadURL('about:blank');
    const dbg = contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    if (!guardListening.has(contents)) {
      guardListening.add(contents);
      dbg.on('message', (_event, method, params: GuardEventParams, sessionId?: string) => {
        if (contents.isDestroyed()) return;
        const session = sessionId || undefined;
        if (method === 'Page.javascriptDialogOpening') {
          // With the Page domain enabled Chromium may wait for a protocol client to answer a JavaScript dialog.
          // Never wait: leave the page on beforeunload, dismiss everything else.
          dbg
            .sendCommand('Page.handleJavaScriptDialog', { accept: params.type === 'beforeunload' }, session)
            .catch(() => undefined);
        } else if (method === 'Target.attachedToTarget' && params.sessionId && params.targetInfo) {
          void guardChildTarget(dbg, params.sessionId, params.targetInfo.type, guardSources.get(contents) ?? '');
        }
      });
    }
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: options.source });
    // Workers and out-of-process iframes start paused until the guard is in place (guardChildTarget).
    await dbg.sendCommand('Target.setAutoAttach', AUTO_ATTACH);
    return true;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const installed = await Promise.race([
    install().catch(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), GUARD_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  return installed;
}

interface GuardEventParams {
  readonly type?: string;
  readonly sessionId?: string;
  readonly targetInfo?: { readonly type: string };
}

/** Puts the guard into an auto-attached child target, then always lets it run (it waits for us). */
async function guardChildTarget(dbg: Electron.Debugger, sessionId: string, type: string, source: string) {
  try {
    if (type === 'worker') {
      await dbg.sendCommand('Runtime.evaluate', { expression: source }, sessionId);
      await dbg.sendCommand('Target.setAutoAttach', AUTO_ATTACH, sessionId).catch(() => undefined); // nested workers
    } else if (type === 'iframe') {
      await dbg.sendCommand('Page.enable', {}, sessionId);
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
      await dbg.sendCommand('Target.setAutoAttach', AUTO_ATTACH, sessionId).catch(() => undefined);
    }
  } catch {
    // The target went away or refused; it must still not stay paused.
  } finally {
    await dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
  }
}

function urlOriginOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
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
