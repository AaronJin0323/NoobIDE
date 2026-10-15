import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import {
  session as electronSession,
  WebContentsView,
  webContents,
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
import { DEFAULT_LOG_BUFFER, LogBuffer, sanitizeLogUrl } from './log-buffer';
import { CONSOLE_LIMIT, pageGuardSource, parseLimiterSummary } from './page-guard';
import { createPreviewWebPreferences, insecurePreviewPreferences, partitionForProject } from './preview-options';
import { decidePreviewRequest, isAllowedNavigation } from './request-policy';
import { PreviewProxy } from './preview-proxy';
import { PreviewServer, TOKEN_HEADER } from './static-server';
import { NotOwnerError, ServerRegistry, type ServerOwner } from './server-registry';
import { DEFAULT_TYPING_PAUSE_MS, RefreshScheduler } from './refresh-scheduler';
import { PermissionNotices } from './permission-policy';
import { INITIAL_MACHINE, transition, type PreviewMachine, type PreviewMachineEvent } from './state-machine';
// S15.5/S15.6: DPI-safe bounds and the F6 focus handoff out of the page.
import { COMMAND_EVENTS } from '../shared/ipc/commands-contract';
import { FocusGuard, focusHandoffStep, toViewBounds } from './view-sync';

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
  /** A main-frame page load began; `generation` is its `PreviewStatus.generation` (the one load counter). */
  navigationStarted(generation: number): void;
  /** The document of page load `generation` committed. */
  navigationCommitted(generation: number): void;
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
  /** S14.2: typing pause before an automatic refresh may run. */
  readonly typingPauseMs?: number;
  /** S15.4: opens a URL in the user's default browser (shell.openExternal). */
  openExternal?(url: string): Promise<void>;
  /**
   * S16.2: runtime capture adapter. Receives every raw record admitted from the page — after the in-page console
   * rate limit (docs/decisions/0016) and with its URLs sanitised (decision 0015).
   */
  readonly capture?: PreviewCaptureHook;
}

interface LivePreview {
  readonly projectId: string;
  /** S14.6: webContents id of the workbench window that started it (the owner). */
  readonly windowId: number;
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
  /** S16.3: generation (PreviewStatus.generation) of the main-frame load in flight or last started. */
  loadGeneration: number | null;
  /** Decision 0016 amendment: the flood guard stopped a script of this page load (explained once per load). */
  floodStopped: boolean;
}

const RECENT_RECORDS = 100;
/**
 * Console flood guard: more than FLOOD_LIMIT messages within FLOOD_WINDOW_MS stop the page's running scripts and
 * skip capture for the rest of the window. The in-page rate limit (page-guard.ts) normally keeps a page far below
 * this; the guard is the backstop for a page that bypasses it (decision 0016 + amendment), so it allows the
 * limiter's budget with room for two windows back to back.
 */
const FLOOD_WINDOW_MS = 1_000;
const FLOOD_LIMIT = 4 * CONSOLE_LIMIT;
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
  /** Metadata of blocked requests for tests and diagnostics: scheme + host only, never paths or contents.
   * `scheme: 'proxy'` marks connections the network proxy refused (docs/decisions/0015). */
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
  /** S15.5/S15.6: a start or refresh must not take the keyboard focus away from the workbench. */
  private readonly focusGuard = new FocusGuard();
  private startQueue: Promise<unknown> = Promise.resolve();

  /** S14.2: automatic refresh after a confirmed save and a typing pause. */
  private readonly refresher: RefreshScheduler;
  /** S25.4: one console notice per denied permission kind and page load. */
  private readonly permissionNotices = new PermissionNotices();

  constructor(private readonly deps: PreviewManagerDeps) {
    this.refresher = new RefreshScheduler({
      quietMs: deps.typingPauseMs ?? DEFAULT_TYPING_PAUSE_MS,
      refresh: () => void this.reload(),
    });
  }

  getStatus(): PreviewStatus {
    return this.status;
  }

  /**
   * Starts are serialised: each one reconfigures the per-project session (proxy, webRequest handlers), so a stale
   * start must never interleave with a newer one. A newer start (or Stop) invalidates an older one through
   * `generation`; the older one then cleans up at its next check.
   */
  start(projectId: string, window: BrowserWindow): Promise<Result<PreviewStatus, PreviewStartError>> {
    this.generation += 1; // invalidate a start that is still in progress
    // A Stop (or a newer Start) while this one waits in the queue cancels it before it begins.
    const ticket = this.generation;
    const run = this.startQueue.then(() =>
      this.generation === ticket ? this.startNow(projectId, window, ticket) : ok(this.status),
    );
    this.startQueue = run.catch(() => undefined);
    return run;
  }

  private async startNow(
    projectId: string,
    window: BrowserWindow,
    ticket: number,
  ): Promise<Result<PreviewStatus, PreviewStartError>> {
    const root = this.deps.rootOf(projectId);
    if (root === undefined) return err('unknown-project', 'project is not open');
    if (window.isDestroyed()) return err('no-window', 'window is gone');
    await this.stop({ announce: false }); // bumps generation once
    // Another Start or a Stop arrived while the old preview was stopping: this start is no longer wanted.
    if (this.generation !== ticket + 1) return ok(this.status);
    const generation = this.generation;
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
    // Bounded: starts are serialised, so one that never settles would block every later Start.
    const entryPath = await withTimeout(
      this.deps.entryPathOf?.(projectId).catch(() => '') ?? Promise.resolve(''),
      5_000,
      '',
    );
    if (generation !== this.generation || window.isDestroyed()) {
      await this.servers.release(projectId, owner);
      return ok(this.status);
    }

    const partition = partitionForProject(server.root);
    const ses = electronSession.fromPartition(partition);
    const webPreferences = createPreviewWebPreferences(partition);
    const insecure = insecurePreviewPreferences(webPreferences);
    if (insecure.length > 0) {
      await this.servers.release(projectId, owner);
      if (this.startingOwner === owner) this.startingOwner = null;
      this.startingWindow = null;
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
      await this.servers.release(projectId, owner);
      if (this.startingOwner === owner) this.startingOwner = null;
      if (generation === this.generation) this.apply(window, projectId, { type: 'server-failed' });
      return err('server-failed', e instanceof Error ? e.message : 'proxy failed', e);
    }
    if (generation !== this.generation || window.isDestroyed()) {
      await proxy.close();
      await this.servers.release(projectId, owner);
      return ok(this.status);
    }
    try {
      const view = { generation, proxy, partition, webPreferences, entryPath };
      return await this.attachView(projectId, window, owner, server, view);
    } catch (e) {
      const current = generation === this.generation; // a Stop/Start meanwhile owns the status
      // S14.6: nothing may keep listening without a view (e.g. the window went away mid-start).
      if (this.live?.projectId === projectId) await this.stop({ announce: false });
      else {
        await proxy.close();
        await this.servers.release(projectId);
      }
      if (this.startingOwner === owner) this.startingOwner = null;
      this.startingWindow = null;
      if (!window.isDestroyed() && current) {
        this.apply(window, projectId, { type: 'server-failed' });
      }
      return err('server-failed', e instanceof Error ? e.message : 'preview view failed', e);
    }
  }

  private async attachView(
    projectId: string,
    window: BrowserWindow,
    owner: ServerOwner,
    server: PreviewServer,
    options: {
      readonly generation: number;
      readonly proxy: PreviewProxy;
      readonly partition: string;
      readonly webPreferences: Electron.WebPreferences;
      readonly entryPath: string;
    },
  ): Promise<Result<PreviewStatus, PreviewStartError>> {
    const { proxy, partition, webPreferences, entryPath } = options;
    const view = new WebContentsView({ webPreferences });
    const guardNonce = randomBytes(8).toString('hex');
    let pageGuarded: boolean;
    try {
      view.setBackgroundColor('#ffffff');
      // No UDP outside the proxy: WebRTC cannot reach local or LAN addresses directly.
      view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      // S05.7: the console rate limit must be in place before the first page script runs.
      pageGuarded = await installPageGuard(view.webContents, { source: pageGuardSource(guardNonce) });
    } catch (e) {
      if (!view.webContents.isDestroyed()) view.webContents.close(); // no orphaned renderer
      throw e;
    }
    if (options.generation !== this.generation || window.isDestroyed()) {
      view.webContents.close();
      await proxy.close();
      await this.servers.release(projectId, owner);
      return ok(this.status);
    }
    const onWindowClosed = () => {
      void this.stop({ announce: false });
      void this.servers.releaseWindow(owner.windowId); // S14.6: defence in depth
    };
    window.once('closed', onWindowClosed);
    const live: LivePreview = {
      projectId,
      windowId: owner.windowId,
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
      loadGeneration: null,
      floodStopped: false,
    };
    this.live = live;
    this.startingWindow = null;
    this.startingOwner = null;
    this.logs.clear();
    this.recent = [];
    this.deps.capture?.sessionStarted({ projectId, origin: server.origin }, window.webContents);
    this.wireContents(live, view.webContents);
    this.focusGuard.loadStarted(window.webContents.isFocused(), Date.now());
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
    this.focusGuard.loadStarted(!live.window.isDestroyed() && live.window.webContents.isFocused(), Date.now());
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
  async openExternal(): Promise<Result<null, 'not-running' | 'open-failed'>> {
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
    try {
      await this.deps.openExternal(live.server.grantExternal(target));
    } catch (e) {
      // No default browser, or the OS refused: report it; the grant URL itself is never logged.
      return err('open-failed', 'the system browser could not be opened', e);
    }
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
      pageGuarded: live?.pageGuarded ?? null,
      recentRecords: [...this.recent],
    };
  }

  private applyBounds(): void {
    const live = this.live;
    if (!live || live.window.isDestroyed()) return;
    const { x, y, width, height, visible } = this.bounds;
    const show = visible && width >= 1 && height >= 1;
    // A hidden page must not keep the keyboard focus (a dialog drawn where it was would get no key presses).
    if (!show && live.view.getVisible() && live.view.webContents.isFocused()) live.window.webContents.focus();
    live.view.setVisible(show);
    if (!show) return;
    // Bounds arrive in workbench CSS pixels; the view is positioned in window DIPs (edges rounded, S15.5/S15.6).
    live.view.setBounds(toViewBounds({ x, y, width, height }, live.window.webContents.getZoomFactor()));
  }

  /** S15.5/S15.6: the workbench hands the keyboard focus to the page (its stage element was focused). */
  focusPage(): void {
    const live = this.live;
    if (!live || live.view.webContents.isDestroyed() || !live.view.getVisible()) return;
    this.focusGuard.userFocused();
    live.view.webContents.focus();
  }

  private configureSession(ses: Session, server: PreviewServer): void {
    if (!this.configuredSessions.has(ses)) {
      this.configuredSessions.add(ses);
      // S25.4: no camera, microphone, location, notifications, clipboard, MIDI, screen capture, USB/HID/serial/
      // Bluetooth devices, fullscreen…: the page is untrusted. Every request is answered here, in main, before
      // Chromium would ask the OS, so no system prompt appears. The first request of each kind per page load is
      // explained in the console (permission-policy.ts), never in a dialog.
      ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        callback(false);
        const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
        this.permissionDenied(wc, permission, { mediaTypes });
      });
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      // Device choosers (navigator.hid / serial / usb .requestDevice): cancel, never pick a device.
      ses.on('select-hid-device', (event, details, callback) => {
        event.preventDefault();
        callback('');
        this.permissionDenied(details.frame ? webContentsOfFrame(details.frame) : null, 'hid');
      });
      ses.on('select-serial-port', (event, _ports, wc, callback) => {
        event.preventDefault();
        callback('');
        this.permissionDenied(wc, 'serial');
      });
      ses.on('select-usb-device', (event, details, callback) => {
        event.preventDefault();
        callback();
        this.permissionDenied(details.frame ? webContentsOfFrame(details.frame) : null, 'usb');
      });
      ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
      // getDisplayMedia: no screen or window is ever shared.
      ses.setDisplayMediaRequestHandler((request, callback) => {
        callback({});
        this.permissionDenied(webContentsOfFrame(request.frame), 'display-capture');
      });
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
    // An HTTP error is recorded when its response starts, not when it completes: Chromium often stops reading the
    // body of a failed image or module (the request then ends with net::ERR_ABORTED and onCompleted never fires),
    // which lost e.g. a missing module's 404 in about one load out of three.
    ses.webRequest.onResponseStarted((details) => {
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

  /** S25.4: a request of the current preview page was denied; explain it once per kind and page load. */
  private permissionDenied(
    contents: WebContents | null | undefined,
    permission: string,
    details?: { readonly mediaTypes?: readonly string[] | undefined },
  ): void {
    const live = this.live;
    if (!live || !contents || live.view.webContents.isDestroyed() || contents.id !== live.view.webContents.id) return;
    const notice = this.permissionNotices.denied(permission, details);
    if (notice) this.pushLog(notice);
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
    // S15.5/S15.6: F6 / Shift+F6 in the page give the focus back to the workbench (DOM focus there is still on the
    // preview stage, so its region order continues from the preview). Also stops the menu accelerator (macOS).
    contents.on('before-input-event', (event, input) => {
      const step = focusHandoffStep(input);
      if (step === null || live.window.isDestroyed()) return;
      event.preventDefault();
      live.window.webContents.focus();
      live.window.webContents.send(COMMAND_EVENTS.run, step === 1 ? 'focus-next-region' : 'focus-previous-region');
    });
    // A load gives the view the focus by itself; hand it back when the workbench had it (FocusGuard).
    contents.on('did-stop-loading', () => {
      if (isCurrent()) this.focusGuard.loadFinished(Date.now());
    });
    contents.on('focus', () => {
      if (!isCurrent() || !this.focusGuard.shouldReturnFocus(Date.now())) return;
      // Not from inside the focus notification (the view is still becoming the first responder), and late enough
      // for a click's input event to arrive first: a click into the page is the user's choice and keeps the focus.
      setTimeout(() => {
        if (!isCurrent() || live.window.isDestroyed() || !this.focusGuard.shouldReturnFocus(Date.now())) return;
        live.window.webContents.focus();
      }, 50);
    });
    contents.on('input-event', (_event, input) => {
      if (isCurrent() && ['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart'].includes(input.type))
        this.focusGuard.userFocused();
    });
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

    // Console flood guard (S05.3, decision 0016 + amendment). Chromium sends every console message of the page to
    // main and Electron turns each into an event there, listener or not; the in-page limiter normally keeps a page
    // far below FLOOD_LIMIT. A page that bypasses it (a native console method saved before the limit, then called in
    // a loop) would keep main — and all keyboard and mouse input of the IDE — busy for seconds. Above FLOOD_LIMIT
    // messages per FLOOD_WINDOW_MS the scripts that are running in the page and its workers are terminated over the
    // DevTools protocol (Runtime.terminateExecution, like DevTools' "stop" for a runaway script): the flood stops at
    // its source within milliseconds instead of queueing in main. Further messages of the window are only counted.
    let windowStart = 0;
    let inWindow = 0;
    // A stop request is in flight; messages over the limit since the last stop finished (the backlog main still
    // had queued arrives before the answer, so anything after it is new output). A further stop needs another
    // CONSOLE_LIMIT of them: a page that went quiet is not stopped again (its next script would be ended instead).
    let stopping = false;
    let sinceStop = Number.POSITIVE_INFINITY;
    const onConsole = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      const now = Date.now();
      if (now - windowStart > FLOOD_WINDOW_MS) {
        windowStart = now;
        inWindow = 0;
        sinceStop = Number.POSITIVE_INFINITY;
      }
      inWindow += 1;
      if (inWindow > FLOOD_LIMIT) {
        if (inWindow === FLOOD_LIMIT + 1) this.logs.markThrottled();
        if (!isCurrent() || contents.isDestroyed()) return;
        sinceStop += 1;
        if (!stopping && sinceStop > CONSOLE_LIMIT) {
          stopping = true;
          void stopRunawayScripts(contents).finally(() => {
            stopping = false;
            sinceStop = 0;
          });
        }
        if (!live.floodStopped) {
          live.floodStopped = true;
          this.pushLog({
            source: 'page-load',
            level: 'warning',
            message: 'console flood: the running script was stopped',
            notice: { kind: 'console-flood-stopped' },
            at: now,
          });
        }
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
      live.ping = null; // A ping sent to the previous document may never be answered.
      this.update(live, { type: 'navigate' });
      // S16.3: a new page load is on its way. Its generation is the state machine's (a Start or refresh already
      // counted it; a navigation the page makes by itself was counted just now), so problem records, the status and
      // the one-click fix's load counting share one counter.
      live.loadGeneration = this.machine.generation;
      this.deps.capture?.navigationStarted(live.loadGeneration);
    });
    // S16.3: the new document committed; from now on the page's records belong to its generation.
    contents.on('did-navigate', () => {
      if (!isCurrent()) return;
      this.permissionNotices.pageLoaded(); // S25.4: a new page explains its own requests again
      live.floodStopped = false;
      this.deps.capture?.navigationCommitted(live.loadGeneration ?? this.machine.generation);
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

  private pushLog(raw: PreviewLogEntry): void {
    if (!this.live) return;
    // S05.5: URLs can be long or carry content (data: URLs, credentials); records only keep a sanitised form.
    const entry: PreviewLogEntry = {
      ...raw,
      ...(raw.url === undefined ? {} : { url: sanitizeLogUrl(raw.url) }),
      ...(raw.initiator === undefined ? {} : { initiator: sanitizeLogUrl(raw.initiator) }),
    };
    this.deps.capture?.entry(entry);
    if (entry.notice) this.logs.pushNotice(entry);
    else this.logs.push(entry);
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
/** Auto-attached child targets (dedicated workers, out-of-process iframes) of each preview, by protocol session. */
const guardChildren = new WeakMap<WebContents, Map<string, string>>();
const TERMINATE_TIMEOUT_MS = 250;
/** Previews with a terminate request in flight (at most one at a time). */
const terminating = new WeakSet<WebContents>();

function childSessions(contents: WebContents): Map<string, string> {
  let children = guardChildren.get(contents);
  if (!children) {
    children = new Map();
    guardChildren.set(contents, children);
  }
  return children;
}

/**
 * Decision 0016 amendment: ends the JavaScript that is running right now in the page (its main thread, which also
 * runs its same-process iframes), its dedicated workers and out-of-process iframes — the console flood's source.
 * `Runtime.terminateExecution` interrupts a busy loop like DevTools' stop button; the page stays loaded, timers and
 * events keep working. A target that is idle at that moment has its next script run ended instead (accepted: only a
 * page that bypassed the console limit gets here). Bounded: one request at a time, each waited for at most 250 ms.
 */
async function stopRunawayScripts(contents: WebContents): Promise<void> {
  if (terminating.has(contents) || contents.isDestroyed()) return;
  const dbg = contents.debugger;
  if (!dbg.isAttached()) return;
  terminating.add(contents);
  try {
    const sessions: (string | undefined)[] = [undefined, ...childSessions(contents).keys()];
    await withTimeout(
      Promise.all(sessions.map((s) => dbg.sendCommand('Runtime.terminateExecution', {}, s).catch(() => undefined))),
      TERMINATE_TIMEOUT_MS,
      [],
    );
  } finally {
    terminating.delete(contents);
  }
}
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
          childSessions(contents).set(params.sessionId, params.targetInfo.type);
          void guardChildTarget(dbg, params.sessionId, params.targetInfo.type, guardSources.get(contents) ?? '');
        } else if (method === 'Target.detachedFromTarget' && params.sessionId) {
          childSessions(contents).delete(params.sessionId);
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

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The WebContents a frame belongs to (null when the frame is gone). */
function webContentsOfFrame(frame: Electron.WebFrameMain | null | undefined): WebContents | null {
  if (!frame) return null;
  try {
    return webContents.fromFrame(frame) ?? null;
  } catch {
    return null;
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
