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
import {
  CONSOLE_LIMIT,
  LIMITER_SOURCE_URL,
  MAX_GUARDED_SCOPES,
  WORKER_CONSOLE_BURST,
  WORKER_CONSOLE_LIMIT,
  pageGuardSource,
  parseLimiterSummary,
} from './page-guard';
import { captureScreenshot, pagePathOf, takeSnapshot, type PageSnapshot } from './page-snapshot';
import { ElementPicker } from './element-pick';
import { clampRegion, parseTarget } from './element-target';
import type {
  AnnotationCandidates,
  AnnotationPickError,
  AnnotationRegionShot,
  AnnotationResolveHow,
  AnnotationTarget,
} from '../shared/ipc/annotations-contract';
import { createPreviewWebPreferences, insecurePreviewPreferences, partitionForProject } from './preview-options';
import { decidePreviewRequest, isAllowedNavigation } from './request-policy';
import { PreviewProxy } from './preview-proxy';
import { PreviewServer, TOKEN_HEADER } from './static-server';
import { parseRequestTarget, resolveInRoot } from './request-path';
import type { Locale } from '../renderer/i18n/index';
import { NotOwnerError, ServerRegistry, type ServerOwner } from './server-registry';
import { DEFAULT_TYPING_PAUSE_MS, RefreshScheduler } from './refresh-scheduler';
import { PermissionNotices } from './permission-policy';
import { ResourceFailureTracker, type RequestOutcome } from './resource-failures';
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
  /** The interface language, for the page the server shows when a page is missing (not-found-page.ts). */
  locale?(): Locale;
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
  /** The flood guard's last decisions, newest last (counts and timings only, never content; for the e2e suite). */
  readonly floodTrace: FloodTraceEntry[];
  /** S41.3: element picking, finding and highlighting for annotations (decision 0030). */
  readonly picker: ElementPicker;
  /** The URL the preview started with (the entry page). */
  readonly entryUrl: string;
  /** The page showing is the server's 404 (a link to a page that does not exist). */
  pageMissing: boolean;
  /** Counts loads the manager asks for; a load decided before an await is dropped when a newer one was asked for. */
  navSeq: number;
}

/** One flood guard decision: a stop sent, or its answer. `ms` is main's time since the counting window began. */
interface FloodTraceEntry {
  readonly kind: 'stop-sent' | 'stop-answered';
  readonly ms: number;
  readonly inWindow: number;
  readonly limit: number;
  readonly stopped?: boolean;
}
const FLOOD_TRACE = 20;

const RECENT_RECORDS = 100;
/**
 * Console flood guard: more than FLOOD_LIMIT messages within FLOOD_WINDOW_MS stop the page's running scripts and
 * skip capture for the rest of the window. The in-page rate limit (page-guard.ts) normally keeps a page far below
 * this; the guard is the backstop for output the limiter does not see (decision 0016 + amendments), so it allows
 * the limiter's budget with room for two windows back to back. Being after the fact, its stall bound depends on
 * main's per-message cost; the limiter's does not.
 */
const FLOOD_WINDOW_MS = 1_000;
const FLOOD_LIMIT = 4 * CONSOLE_LIMIT;
/**
 * The flood limit for this page within one FLOOD_WINDOW_MS. All documents of the page share one in-page budget
 * (page-guard.ts: CONSOLE_BURST at once, CONSOLE_LIMIT per second, at least one message per document), and each
 * running dedicated worker or worklet has its own small one (at most MAX_GUARDED_SCOPES of them run). A page that
 * stays within its budget never trips the guard; the limit does not grow with anything a page can create freely.
 * Computed once per window, not per message.
 */
function floodLimitFor(contents: WebContents): number {
  let documents = 1;
  try {
    documents = Math.max(1, contents.mainFrame.framesInSubtree.length);
  } catch {
    // frame gone: keep 1
  }
  const scopes = guardedScopes(contents).size;
  return FLOOD_LIMIT + Math.min(documents, 1_000) + scopes * 2 * (WORKER_CONSOLE_BURST + WORKER_CONSOLE_LIMIT);
}
const DEFAULT_WATCHDOG: WatchdogOptions = { intervalMs: 1_000, timeoutMs: 3_000 };
/** S38.1: a watchdog ping unanswered this long means the page is busy; no snapshot is attempted. */
const SNAPSHOT_BUSY_MS = 500;

/** S41.3: a page path with the directory index spelled out ('' and 'dir/' are 'index.html', 'dir/index.html'). */
function samePage(pagePath: string): string {
  return pagePath === '' || pagePath.endsWith('/') ? `${pagePath}index.html` : pagePath;
}

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
  private readonly servers = new ServerRegistry<PreviewServer>((root, options) =>
    PreviewServer.start(root, { ...options, locale: () => this.deps.locale?.() ?? 'zh-CN' }),
  );
  /** A save arrived while the page was loading; reload when the load finishes. */
  private reloadPending = false;
  /** S15.5/S15.6: a start or refresh must not take the keyboard focus away from the workbench. */
  private readonly focusGuard = new FocusGuard();
  private startQueue: Promise<unknown> = Promise.resolve();
  /** S38.1: the page snapshot in flight (at most one; callers share it). */
  private snapshotting: {
    readonly live: LivePreview;
    readonly generation: number | null;
    readonly screenshot: boolean;
    readonly result: Promise<Result<PageSnapshot, 'not-running' | 'not-available'>>;
  } | null = null;

  /** S14.2: automatic refresh after a confirmed save and a typing pause. */
  private readonly refresher: RefreshScheduler;
  /** S25.4: one console notice per denied permission kind and page load. */
  private readonly permissionNotices = new PermissionNotices();

  constructor(private readonly deps: PreviewManagerDeps) {
    this.refresher = new RefreshScheduler({
      quietMs: deps.typingPauseMs ?? DEFAULT_TYPING_PAUSE_MS,
      refresh: () => void this.reload({ afterSave: true }),
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
      pageGuarded = await installPageGuard(view.webContents, {
        source: pageGuardSource(guardNonce),
        wanted: () => options.generation === this.generation && !window.isDestroyed(),
      });
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
      floodTrace: [],
      picker: new ElementPicker(view.webContents),
      entryUrl: `${server.origin}/${entryPath}`,
      pageMissing: false,
      navSeq: 0,
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

    const url = live.entryUrl;
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
    live.picker.dispose();
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

  /**
   * Refreshes the page. `afterSave`: the automatic refresh after a save — when the page showing is a missing page
   * (404, e.g. after following a broken link), reloading it would only show the 404 again, so the preview goes back
   * to the entry page instead, unless the missing file exists by now (then that page is loaded).
   */
  reload(options: { readonly afterSave?: boolean } = {}): PreviewStatus {
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
    const seq = ++live.navSeq;
    if (options.afterSave && live.pageMissing) void this.leaveMissingPage(live, seq);
    else live.view.webContents.reloadIgnoringCache();
    return this.status;
  }

  /** Opens the project's entry page in the running preview ("Back to entry page"). */
  async goToEntry(): Promise<Result<PreviewStatus, 'not-running'>> {
    const live = this.live;
    if (!live || live.view.webContents.isDestroyed()) return err('not-running', 'no preview');
    const loading = this.status.state === 'starting' || this.status.state === 'refreshing';
    if (!loading) {
      const before = this.machine;
      this.update(live, { type: 'refresh' });
      if (this.machine === before) return err('not-running', 'the page cannot load now');
    }
    this.reloadPending = false; // the entry page is loaded fresh anyway
    this.focusGuard.loadStarted(!live.window.isDestroyed() && live.window.webContents.isFocused(), Date.now());
    const seq = ++live.navSeq;
    const target = await this.entryUrlOf(live);
    if (this.live !== live || live.view.webContents.isDestroyed()) return err('not-running', 'stopped meanwhile');
    if (live.navSeq !== seq) return ok(this.status); // a newer load was asked for meanwhile
    live.view.webContents.loadURL(target).catch(() => undefined); // failures arrive as did-fail-load
    return ok(this.status);
  }

  /** The entry page now (the setting may have changed since the preview started). */
  private async entryUrlOf(live: LivePreview): Promise<string> {
    // Promise.resolve().then: a dependency that throws synchronously is a failed read too, never a stuck load.
    const read = Promise.resolve()
      .then(() => this.deps.entryPathOf?.(live.projectId) ?? null)
      .catch(() => null);
    const entryPath = await withTimeout(read, 2_000, null);
    return entryPath === null ? live.entryUrl : `${live.server.origin}/${entryPath}`;
  }

  /** After a save on a missing page: load that page if its file exists now, else the entry page. */
  private async leaveMissingPage(live: LivePreview, seq: number): Promise<void> {
    const contents = live.view.webContents;
    let target: string | null = null;
    try {
      const shown = new URL(contents.getURL());
      const request = parseRequestTarget(shown.pathname);
      if (shown.origin === live.server.origin && request.ok) {
        const found = await resolveInRoot(live.server.root, request.value);
        if (found.ok) target = shown.href;
      }
    } catch {
      // not a page of the server: go to the entry page
    }
    target ??= await this.entryUrlOf(live);
    if (this.live !== live || contents.isDestroyed() || live.navSeq !== seq) return;
    contents.loadURL(target).catch(() => undefined); // failures arrive as did-fail-load
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

  // --- S25.1/S25.2: probes for sleep/wake recovery (src/main/wake-recovery.ts decides, decision 0028) ---

  /** The preview showing now (null: none, or still waiting for its server). */
  wakeSubject(): { readonly projectId: string; readonly state: PreviewStatus['state'] } | null {
    const live = this.live;
    return live ? { projectId: live.projectId, state: this.status.state } : null;
  }

  /**
   * After sleep: a watchdog ping sent before the machine slept looks hours old, which would mark a healthy page
   * unresponsive. Forget it; the next tick pings afresh (a page that really hangs is caught again within seconds).
   */
  forgetStalePing(): void {
    if (this.live) this.live.ping = null;
  }

  /**
   * Whether the preview's loopback server still answers HTTP (static-server.ts `answers`) and the session's network
   * proxy still accepts connections (all page traffic goes through it, decision 0015).
   */
  async serverAnswers(timeoutMs: number): Promise<boolean> {
    const live = this.live;
    if (!live) return false;
    const [server, proxy] = await Promise.all([live.server.answers(timeoutMs), live.proxy.answers(timeoutMs)]);
    return server && proxy;
  }

  /** Whether the page's main thread runs a trivial script within `timeoutMs` (false when crashed or hung). */
  async pageAnswers(timeoutMs: number): Promise<boolean> {
    const contents = this.live?.view.webContents;
    if (!contents || contents.isDestroyed() || contents.isCrashed()) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([
        contents.mainFrame.executeJavaScript('0').then(
          () => true,
          () => false,
        ),
        timeout,
      ]);
    } catch {
      return false; // frame gone
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Restarts the preview of the same project in the same window: a new view (a hung or crashed page cannot reload
   * itself) and the project's server again (the registry tries the previous port first, so the page keeps its
   * origin and storage; otherwise the new URL is loaded). Then tells the user why, in their language, in the
   * console. Never touches project files or editor buffers. False when nothing was restarted.
   */
  async restartAfterWake(reason: 'server' | 'page'): Promise<boolean> {
    const live = this.live;
    if (!live || live.window.isDestroyed()) return false;
    const { projectId, window } = live;
    const stopping = this.stop({ announce: false });
    const ticket = this.generation; // stop() counted itself synchronously
    await stopping;
    // The user pressed Stop, or a project switch or another Start came in while stopping: theirs wins.
    if (this.generation !== ticket || this.live !== null || window.isDestroyed()) {
      // Our stop was silent: make sure the workbench does not keep showing the old page as running.
      if (this.status.state === 'stopped' && !window.isDestroyed()) this.setStatus(window, this.status);
      return false;
    }
    const result = await this.start(projectId, window);
    const started = this.live as LivePreview | null; // (TS narrowed `live` above; start() set it)
    if (!result.ok || started?.projectId !== projectId) return false;
    this.pushLog({
      source: 'page-load',
      level: 'info',
      message:
        reason === 'server'
          ? 'The preview restarted after the computer woke up: its local server had stopped.'
          : 'The preview restarted after the computer woke up: the page had stopped responding.',
      notice: { kind: 'restarted-after-sleep', reason },
      at: Date.now(),
    });
    return true;
  }

  /** Test hook (S25 e2e fault injection): the server's socket dies without the preview noticing. */
  async debugKillServerSocket(): Promise<boolean> {
    const live = this.live;
    if (!live) return false;
    await live.server.close();
    return true;
  }
  // --- end S25.1/S25.2 ---

  setBounds(bounds: PreviewBounds): void {
    this.bounds = bounds;
    this.applyBounds();
  }

  /** S34: the running preview's most recent page records (memory only), for the AI agent's get_console tool. */
  recentRecords(): readonly PreviewLogEntry[] {
    return [...this.recent];
  }

  /**
   * S38.1 (decision 0026): a bounded snapshot of the page this project's preview shows — path, title, outline and
   * optionally a screenshot — captured from main only (page-snapshot.ts). Not available while the preview is not
   * showing a page (stopped, starting, crashed, failed) or not answering (an endless loop): then nothing is asked of
   * the page at all. One snapshot runs at a time; a second caller shares it. Never logs page content.
   */
  async pageSnapshot(
    projectId: string,
    options: { readonly screenshot: boolean },
  ): Promise<Result<PageSnapshot, 'not-running' | 'not-available'>> {
    const live = this.live;
    if (!live || live.projectId !== projectId || live.view.webContents.isDestroyed()) {
      return err('not-running', 'no preview of this project');
    }
    const state = this.status.state;
    if (state !== 'running' && state !== 'refreshing') return err('not-available', `preview is ${state}`);
    // The watchdog's ping has been waiting for a while: the page's main thread is busy (a long or endless loop).
    // Nothing is asked of it then; the outline could not run anyway and a capture would only queue behind the loop.
    if (live.ping && Date.now() - live.ping.startedAt >= SNAPSHOT_BUSY_MS) return err('not-available', 'page is busy');
    const generation = live.loadGeneration;
    const pending = this.snapshotting;
    if (pending && pending.live === live && pending.generation === generation) {
      // The same page is being captured: share it, or (screenshot wanted, not being taken) take ours after it.
      if (pending.screenshot || !options.screenshot) return pending.result;
      await pending.result;
      if (this.live !== live || live.loadGeneration !== generation) return err('not-available', 'the page changed');
    }
    const visible = live.view.getVisible();
    const result = takeSnapshot(live.view.webContents, {
      origin: live.server.origin,
      screenshot: options.screenshot && visible,
    }).then((snapshot): Result<PageSnapshot, 'not-running' | 'not-available'> => {
      if (this.live !== live) return err('not-running', 'the preview stopped');
      // A navigation meanwhile: the snapshot would mix two pages.
      if (live.loadGeneration !== generation) return err('not-available', 'the page changed');
      if (options.screenshot && !visible) return ok({ ...snapshot, screenshotUnavailable: 'hidden' });
      return ok(snapshot);
    });
    const entry = { live, generation, screenshot: options.screenshot && visible, result };
    this.snapshotting = entry;
    void result.finally(() => {
      if (this.snapshotting === entry) this.snapshotting = null;
    });
    return result;
  }

  // --- S41.3: annotations (decision 0030) ---

  /** The running preview of `projectId` that can be asked about its page, or the reason it cannot. */
  private annotatable(projectId: string): Result<LivePreview, AnnotationPickError> {
    const live = this.live;
    if (!live || live.projectId !== projectId || live.view.webContents.isDestroyed()) {
      return err('not-running', 'no preview of this project');
    }
    const state = this.status.state;
    if (state !== 'running' && state !== 'refreshing') return err('not-available', `preview is ${state}`);
    if (live.ping && Date.now() - live.ping.startedAt >= SNAPSHOT_BUSY_MS) return err('not-available', 'page is busy');
    return ok(live);
  }

  private targetOf(
    live: LivePreview,
    raw: Result<unknown, AnnotationPickError>,
    generation: number | null,
    kind: 'element' | 'region',
  ): Result<AnnotationTarget, AnnotationPickError> {
    if (!raw.ok) return raw;
    if (this.live !== live) return err('not-running', 'the preview stopped');
    if (live.loadGeneration !== generation) return err('not-available', 'the page changed');
    const contents = live.view.webContents;
    const pagePath = contents.isDestroyed() ? null : pagePathOf(contents.getURL(), live.server.origin);
    if (pagePath === null) return err('not-available', 'not a page of the project');
    const target = parseTarget(raw.value, { origin: live.server.origin, pagePath, kind });
    return target ? ok(target) : err('not-available', 'unexpected description');
  }

  private picked<T>(
    result: { ok: true; value: T } | { ok: false; reason: 'cancelled' | 'not-available' | 'busy' },
  ): Result<T, AnnotationPickError> {
    return result.ok ? ok(result.value) : err(result.reason, `pick ${result.reason}`);
  }

  /** Inspect mode on the page until the user clicks an element (or cancels); its description. */
  async annotationPick(projectId: string): Promise<Result<AnnotationTarget, AnnotationPickError>> {
    const live = this.annotatable(projectId);
    if (!live.ok) return live;
    const generation = live.value.loadGeneration;
    const raw = this.picked(await live.value.picker.pick());
    return this.targetOf(live.value, raw, generation, 'element');
  }

  /** Pick mode is on in the page (for the e2e suite). */
  annotationPicking(): boolean {
    return this.live?.picker.isInspecting ?? false;
  }

  /** Ends pick mode (the toolbar's Cancel). */
  annotationCancelPick(projectId: string): void {
    if (this.live?.projectId === projectId) this.live.picker.cancel();
  }

  async annotationCandidates(projectId: string): Promise<Result<AnnotationCandidates, AnnotationPickError>> {
    const live = this.annotatable(projectId);
    if (!live.ok) return live;
    const generation = live.value.loadGeneration;
    const result = this.picked(await live.value.picker.candidates());
    if (result.ok && (this.live !== live.value || live.value.loadGeneration !== generation)) {
      return err('not-available', 'the page changed');
    }
    return result;
  }

  /** Finds an element by its child-index path (keyboard list) or by a drawn region (fractions of the viewport). */
  async annotationResolve(
    projectId: string,
    how: AnnotationResolveHow,
  ): Promise<Result<AnnotationTarget, AnnotationPickError>> {
    const live = this.annotatable(projectId);
    if (!live.ok) return live;
    const generation = live.value.loadGeneration;
    if (how.kind === 'path') {
      const raw = this.picked(await live.value.picker.describePath(how.path));
      return this.targetOf(live.value, raw, generation, 'element');
    }
    const region = clampRegion(how);
    if (!region) return err('not-available', 'empty region');
    const raw = this.picked(await live.value.picker.describeRegion(region));
    const target = this.targetOf(live.value, raw, generation, 'region');
    if (!target.ok) return target;
    // The region is kept in CSS pixels of the viewport the page reported.
    const { width, height } = target.value.viewport;
    const px = {
      x: Math.round(region.x * width),
      y: Math.round(region.y * height),
      width: Math.round(region.width * width),
      height: Math.round(region.height * height),
    };
    return ok({ ...target.value, region: px });
  }

  /** Shows the element at `path` on the page for a few seconds (`null` hides it). */
  async annotationHighlight(
    projectId: string,
    target: { readonly path: readonly number[]; readonly pagePath: string } | null,
  ): Promise<Result<null, AnnotationPickError>> {
    if (target === null) {
      if (this.live?.projectId === projectId) await this.live.picker.highlight(null);
      return ok(null);
    }
    const live = this.annotatable(projectId);
    if (!live.ok) return live;
    // The path only means something on the page it was taken on.
    const shown = pagePathOf(live.value.view.webContents.getURL(), live.value.server.origin);
    if (shown === null || samePage(shown) !== samePage(target.pagePath)) {
      return err('not-available', 'the annotation belongs to another page');
    }
    return this.picked(await live.value.picker.highlight(target.path));
  }

  /** A picture of the page to draw a region on (not taken while the view is hidden). */
  async annotationRegionShot(projectId: string): Promise<Result<AnnotationRegionShot, AnnotationPickError>> {
    const live = this.annotatable(projectId);
    if (!live.ok) return live;
    if (!live.value.view.getVisible()) return err('not-available', 'the preview is hidden');
    const shot = await captureScreenshot(live.value.view.webContents);
    if (!shot.ok) return err('not-available', `screenshot ${shot.reason}`);
    return ok({
      dataUrl: `data:image/png;base64,${shot.value.png.toString('base64')}`,
      width: shot.value.width,
      height: shot.value.height,
    });
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
      guardTrace: guardTraceOf(contents), // S05.8
      floodTrace: live ? [...live.floodTrace] : [],
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
    // S16.4: an error response whose body Chromium cancels ends as ERR_ABORTED, not onCompleted (resource-failures.ts).
    const failures = new ResourceFailureTracker();
    const pushFailure = (
      details: { url: string; method: string; resourceType: string; referrer: string },
      outcome: RequestOutcome,
    ) => {
      if (outcome.kind === 'ignore') return; // e.g. aborted by navigating away or reloading: not a failure
      this.pushLog({
        source: 'network',
        level: 'error',
        message: `${outcome.kind === 'status' ? outcome.status : outcome.error} ${details.method} ${details.resourceType}`,
        url: details.url,
        ...(outcome.kind === 'status' ? { status: outcome.status } : {}),
        resourceType: details.resourceType,
        ...(details.referrer ? { initiator: details.referrer } : {}),
        at: Date.now(),
      });
    };
    ses.webRequest.onResponseStarted((details) => failures.responseStarted(details.id, details.statusCode));
    ses.webRequest.onCompleted((details) => pushFailure(details, failures.completed(details.id, details.statusCode)));
    ses.webRequest.onErrorOccurred((details) => pushFailure(details, failures.errored(details.id, details.error)));
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
      // S41.3: Esc ends pick mode; the page never sees that key press.
      if (live.picker.isPicking && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        live.picker.cancel();
        return;
      }
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
      childSessions(contents).clear(); // their protocol sessions ended with the debugger
      guardedScopes(contents).clear();
      if (!isCurrent() || contents.isDestroyed()) return;
      void installPageGuard(contents, { source: pageGuardSource(live.guardNonce), navigateFirst: false }).then((ok) => {
        live.pageGuarded = ok;
      });
    });

    // Console flood guard (S05.3, decision 0016 + amendment). Chromium sends every console message of the page to
    // main and Electron turns each into an event there, listener or not; the in-page limiter normally keeps a page
    // far below FLOOD_LIMIT, and since its second amendment no page can call a native console method around it.
    // Output it cannot see (a Chromium warning it does not know about, a frame or worker the guard could not reach)
    // would keep main — and all keyboard and mouse input of the IDE — busy; this is the defence in depth. Above
    // FLOOD_LIMIT messages per FLOOD_WINDOW_MS the scripts that are running in the page and its workers are terminated
    // over the DevTools protocol (Runtime.terminateExecution, like DevTools' "stop" for a runaway script): the flood
    // stops at its source instead of queueing in main. Further messages of the window are only counted.
    let windowStart = 0;
    let inWindow = 0;
    // A stop request is in flight; messages over the limit since the last stop finished (the backlog main still
    // had queued arrives before the answer, so anything after it is new output). A further stop needs another
    // CONSOLE_LIMIT of them: a page that went quiet is not stopped again (its next script would be ended instead).
    let stopping = false;
    let sinceStop = Number.POSITIVE_INFINITY;
    let limit = FLOOD_LIMIT;
    const onConsole = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      const now = Date.now();
      if (now - windowStart > FLOOD_WINDOW_MS) {
        windowStart = now;
        inWindow = 0;
        sinceStop = Number.POSITIVE_INFINITY;
        limit = floodLimitFor(contents);
      }
      inWindow += 1;
      if (inWindow > limit) {
        if (inWindow === limit + 1) this.logs.markThrottled();
        if (!isCurrent() || contents.isDestroyed()) return;
        sinceStop += 1;
        if (stopping || sinceStop <= CONSOLE_LIMIT) return;
        stopping = true;
        const trace = (entry: FloodTraceEntry) => {
          if (live.floodTrace.length >= FLOOD_TRACE) live.floodTrace.shift();
          live.floodTrace.push(entry);
        };
        trace({ kind: 'stop-sent', ms: now - windowStart, inWindow, limit });
        void stopRunawayScripts(contents).then((stopped) => {
          trace({ kind: 'stop-answered', ms: Date.now() - windowStart, inWindow, limit, stopped });
          stopping = false;
          sinceStop = 0;
          if (!isCurrent() || contents.isDestroyed()) return;
          if (!stopped) {
            // No protocol session (the guard could not be installed): fall back to 0010's guard and stop listening
            // for the rest of the window, so at least our own handling costs nothing.
            contents.off('console-message', onConsole);
            live.timers.push(
              setTimeout(() => {
                if (this.live !== live || contents.isDestroyed()) return;
                windowStart = Date.now();
                inWindow = 0;
                contents.on('console-message', onConsole);
              }, FLOOD_WINDOW_MS),
            );
            return;
          }
          if (live.floodStopped) return;
          live.floodStopped = true; // explained once per page load, and only when a script was really stopped
          this.pushLog({
            source: 'page-load',
            level: 'warning',
            message: 'console flood: the running script was stopped',
            notice: { kind: 'console-flood-stopped' },
            at: Date.now(),
          });
        });
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
      // A message the guard had to send itself (the page's Content Security Policy forbids the call stubs that keep
      // the caller's location, page-guard.ts) has no file and line of the page.
      const url = sourceId === LIMITER_SOURCE_URL ? '' : sourceId;
      this.pushLog({
        source: /^Uncaught\b/.test(message) ? 'exception' : 'console',
        level,
        message,
        ...(url ? { url } : {}),
        ...(url && lineNumber > 0 ? { line: lineNumber } : {}),
        at: now,
      });
    };
    contents.on('console-message', onConsole);

    contents.on('did-start-navigation', (event) => {
      if (!isCurrent() || !event.isMainFrame || event.isSameDocument) return;
      live.ping = null; // A ping sent to the previous document may never be answered.
      live.picker.dispose(); // S41.3: a pick or highlight belongs to the page that was shown
      this.update(live, { type: 'navigate' });
      // S16.3: a new page load is on its way. Its generation is the state machine's (a Start or refresh already
      // counted it; a navigation the page makes by itself was counted just now), so problem records, the status and
      // the one-click fix's load counting share one counter.
      live.loadGeneration = this.machine.generation;
      this.deps.capture?.navigationStarted(live.loadGeneration);
    });
    // S16.3: the new document committed; from now on the page's records belong to its generation.
    contents.on('did-navigate', (_event, url, httpResponseCode) => {
      if (!isCurrent()) return;
      // Which page is showing, and whether it is the server's 404 (a link to a page that does not exist).
      live.pageMissing = httpResponseCode === 404;
      this.pageShown(live, url);
      this.permissionNotices.pageLoaded(); // S25.4: a new page explains its own requests again
      live.floodStopped = false;
      // A ping sent to the previous document after the navigation started is never answered (its frame is gone);
      // without this the watchdog would wait for it forever and keep a page that answers marked unresponsive.
      live.ping = null;
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
    // The missing-page mark belongs to the page showing (`url`); the next page that loads sets it again.
    const notFound = url !== undefined && this.status.notFound === true;
    const status: PreviewStatus = {
      state: next.state,
      projectId: next.state === 'stopped' ? null : projectId,
      ...(next.failure ? { failure: next.failure } : {}),
      ...(url ? { url } : {}),
      generation: next.generation,
      ...(outdated ? { outdated } : {}),
      ...(notFound ? { notFound } : {}),
    };
    if (window) this.setStatus(window, status);
    else this.status = status;
  }

  /** A document of the preview's own server committed: publish its address and whether it is a missing page. */
  private pageShown(live: LivePreview, url: string): void {
    if (urlOriginOf(url) !== live.server.origin) return;
    const notFound = live.pageMissing;
    if (this.status.url === url && (this.status.notFound === true) === notFound) return;
    const { notFound: _previous, ...rest } = this.status;
    this.setStatus(live.window, { ...rest, url, ...(notFound ? { notFound } : {}) });
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

/**
 * Longest the page guard's DevTools commands may take once the view has a document. They answer only once the view's
 * renderer process runs, which a loaded machine is slow to start (S05.8, Windows x64: 2–5 s with 1.5 busy threads per
 * core, more than 15 s with 2). Waiting keeps the page guarded; a Stop or a newer Start ends the wait at once.
 */
const GUARD_TIMEOUT_MS = 45_000;
/**
 * S05.8: a new view's first navigation (to about:blank, which needs no request) can stay pending for 30–45 s on a
 * loaded machine before it commits (measured on Windows x64, stock Electron 44 too), while a second load of the same
 * URL issued meanwhile commits at once. So the first document is asked for again every FIRST_DOCUMENT_RETRY_MS, for
 * at most FIRST_DOCUMENT_TIMEOUT_MS; a Stop or a newer Start ends the wait.
 */
const FIRST_DOCUMENT_RETRY_MS = 1_000;
const FIRST_DOCUMENT_TIMEOUT_MS = 30_000;
/** S05.8: how the last page guard install of a view went (timings and outcome only), for diagnostics and e2e. */
export interface GuardTrace {
  firstDocumentMs: number | null;
  firstDocumentAttempts: number;
  commandsMs: number | null;
  outcome: 'pending' | 'installed' | 'no-first-document' | 'commands-failed' | 'commands-timeout' | 'not-wanted';
}
const guardTraces = new WeakMap<WebContents, GuardTrace>();
const guardListening = new WeakSet<WebContents>();
const guardSources = new WeakMap<WebContents, string>();
/** Auto-attached child targets (dedicated workers, out-of-process iframes) of each preview, by protocol session. */
const guardChildren = new WeakMap<WebContents, Map<string, string>>();
const TERMINATE_TIMEOUT_MS = 250;
/** Previews with a terminate request in flight (at most one at a time). */
const terminating = new WeakSet<WebContents>();

/** Dedicated workers and worklets of each preview that run with the guard (at most MAX_GUARDED_SCOPES). */
const guardedScopeSets = new WeakMap<WebContents, Set<string>>();

/** When each preview's recent workers and worklets were started (for the start rate, scopeStartTurn). */
const scopeStartTimes = new WeakMap<WebContents, number[]>();

/** Workers/worklets of each preview waiting for their start turn (at most MAX_WAITING_SCOPES; others never start). */
const scopeWaitingCounts = new WeakMap<WebContents, { count: number }>();
const MAX_WAITING_SCOPES = 32;

function scopeWaiting(contents: WebContents): { count: number } {
  let waiting = scopeWaitingCounts.get(contents);
  if (!waiting) {
    waiting = { count: 0 };
    scopeWaitingCounts.set(contents, waiting);
  }
  return waiting;
}

function scopeStarts(contents: WebContents): number[] {
  let starts = scopeStartTimes.get(contents);
  if (!starts) {
    starts = [];
    scopeStartTimes.set(contents, starts);
  }
  return starts;
}

/** Waits until fewer than MAX_GUARDED_SCOPES workers/worklets were started in the last FLOOD_WINDOW_MS, then counts one. */
async function scopeStartTurn(starts: number[], waiting: { count: number }): Promise<boolean> {
  if (waiting.count >= MAX_WAITING_SCOPES) return false; // more are waiting already: this one never starts
  waiting.count += 1;
  try {
    return await nextScopeStart(starts);
  } finally {
    waiting.count -= 1;
  }
}

async function nextScopeStart(starts: number[]): Promise<boolean> {
  for (;;) {
    const now = Date.now();
    while (starts.length > 0 && now - (starts[0] ?? 0) >= FLOOD_WINDOW_MS) starts.shift();
    if (starts.length < MAX_GUARDED_SCOPES) {
      starts.push(now);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, FLOOD_WINDOW_MS - (now - (starts[0] ?? now)) + 1));
  }
}

function guardedScopes(contents: WebContents): Set<string> {
  let scopes = guardedScopeSets.get(contents);
  if (!scopes) {
    scopes = new Set();
    guardedScopeSets.set(contents, scopes);
  }
  return scopes;
}

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
 * events keep working. A target that is idle at that moment has its next script run ended instead (accepted: only
 * output the console limit did not see gets here). Bounded: one request at a time, each waited for at most 250 ms.
 */
async function stopRunawayScripts(contents: WebContents): Promise<boolean> {
  if (terminating.has(contents) || contents.isDestroyed()) return false;
  const dbg = contents.debugger;
  if (!dbg.isAttached()) return false;
  terminating.add(contents);
  try {
    const sessions: (string | undefined)[] = [undefined, ...childSessions(contents).keys()];
    const answers = await withTimeout(
      Promise.all(
        sessions.map((s) =>
          dbg.sendCommand('Runtime.terminateExecution', {}, s).then(
            () => true,
            () => false,
          ),
        ),
      ),
      TERMINATE_TIMEOUT_MS,
      null,
    );
    // A target that was idle keeps the termination pending until its next script run (the answer comes only then):
    // use it up with a harmless evaluation, so no later event handler, timer or the next document's page guard is
    // ended instead.
    await withTimeout(
      Promise.all(
        sessions.map((s) =>
          dbg.sendCommand('Runtime.evaluate', { expression: '0', silent: true }, s).catch(() => undefined),
        ),
      ),
      TERMINATE_TIMEOUT_MS,
      [],
    );
    // Stopped when at least one target answered (a busy one answers as soon as its script is ended).
    return answers === null || answers.some((a) => a);
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
 *
 * S05.8: the first document comes first and on its own (showFirstDocument), then the commands are bounded by
 * GUARD_TIMEOUT_MS. With one 5 s bound over both, a first navigation stuck on a loaded machine made the preview run
 * without its guard after 5 s of "Starting", the about:blank load still pending when the page's own load began.
 * The e2e suite never saw it with Playwright's DevTools connection to every view; tests/e2e/preview-restore.spec.ts
 * restarts the app without that connection.
 */
async function installPageGuard(
  contents: WebContents,
  options: {
    readonly source: string;
    readonly navigateFirst?: boolean;
    /** False once a Stop or a newer Start made this preview obsolete: stop waiting for the first document. */
    readonly wanted?: () => boolean;
  },
): Promise<boolean> {
  guardSources.set(contents, options.source);
  const trace: GuardTrace = { firstDocumentMs: null, firstDocumentAttempts: 0, commandsMs: null, outcome: 'pending' };
  guardTraces.set(contents, trace);
  const wanted = options.wanted ?? (() => true);
  if (options.navigateFirst ?? true) {
    const started = Date.now();
    const shown = await showFirstDocument(contents, wanted, trace);
    trace.firstDocumentMs = Date.now() - started;
    if (!shown) {
      trace.outcome = wanted() ? 'no-first-document' : 'not-wanted';
      return false;
    }
  }
  const install = async () => {
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
          void guardChildTarget(
            dbg,
            guardedScopes(contents),
            scopeStarts(contents),
            scopeWaiting(contents),
            params.sessionId,
            params.targetInfo.type,
            guardSources.get(contents) ?? '',
            params.waitingForDebugger !== false,
          );
        } else if (method === 'Target.detachedFromTarget' && params.sessionId) {
          childSessions(contents).delete(params.sessionId);
          guardedScopes(contents).delete(params.sessionId);
        }
      });
    }
    await dbg.sendCommand('Page.enable');
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: options.source });
    // Workers and out-of-process iframes start paused until the guard is in place (guardChildTarget).
    await dbg.sendCommand('Target.setAutoAttach', AUTO_ATTACH);
    return true;
  };
  if (!wanted()) {
    trace.outcome = 'not-wanted';
    return false;
  }
  // Bounded, and given up as soon as the preview is no longer wanted: starts are serialised, so a Stop or a newer
  // Start must not wait for these commands. A late install still guards the view's later documents.
  const commandsStarted = Date.now();
  const running = install().catch(() => false);
  const deadline = commandsStarted + GUARD_TIMEOUT_MS;
  let installed: boolean | null = null;
  void running.then((ok) => (installed = ok));
  while (installed === null && Date.now() < deadline && wanted() && !contents.isDestroyed()) {
    await withTimeout(running, 250, false);
  }
  trace.commandsMs = Date.now() - commandsStarted;
  trace.outcome =
    installed === true
      ? 'installed'
      : installed === false
        ? 'commands-failed'
        : wanted()
          ? 'commands-timeout'
          : 'not-wanted';
  return installed === true;
}

/** S05.8: the last page guard install's trace of a view (null before any). */
function guardTraceOf(contents: WebContents | null): GuardTrace | null {
  const trace = contents ? guardTraces.get(contents) : undefined;
  return trace ? { ...trace } : null;
}

/**
 * S05.8: loads about:blank into a new view and resolves true once a document is there; false when the view went
 * away, the preview is no longer wanted or FIRST_DOCUMENT_TIMEOUT_MS passed. A load still pending after
 * FIRST_DOCUMENT_RETRY_MS is replaced by a new one (the replaced load rejects as aborted; that is expected). When
 * either bound runs out the preview still opens, without the guard (decision 0016: best effort for the page itself,
 * fail-closed only for workers and frames) — measured: 7–8 s to a guarded page with 1.5 busy threads per core, 0.4 s
 * idle.
 */
async function showFirstDocument(contents: WebContents, wanted: () => boolean, trace: GuardTrace): Promise<boolean> {
  const deadline = Date.now() + FIRST_DOCUMENT_TIMEOUT_MS;
  let shown = false;
  while (!shown && !contents.isDestroyed() && Date.now() < deadline && wanted()) {
    trace.firstDocumentAttempts += 1;
    const attempt = contents.loadURL('about:blank').then(
      () => true,
      () => false,
    );
    const retryAt = Date.now() + FIRST_DOCUMENT_RETRY_MS;
    let settled = false;
    void attempt.then(() => (settled = true));
    while (!settled && Date.now() < retryAt && wanted() && !contents.isDestroyed()) {
      await withTimeout(attempt, 250, false);
    }
    shown = settled && (await attempt);
    // A load that failed by itself (not replaced by the next attempt) waits out its turn: no tight loop of loads.
    while (!shown && Date.now() < retryAt && wanted() && !contents.isDestroyed()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return shown;
}

interface GuardEventParams {
  readonly type?: string;
  readonly sessionId?: string;
  readonly waitingForDebugger?: boolean;
  readonly targetInfo?: { readonly type: string };
}

/**
 * Puts the guard into an auto-attached child target that waits for us, then lets it run. Out-of-process iframes
 * get it for every document; dedicated workers and worklets get it once, before their own script. Fails closed
 * (decision 0016, second amendment): a target the guard could not be installed in is not resumed, nor is a worker or
 * worklet beyond MAX_GUARDED_SCOPES running at once (each has its own console budget), nor a target type the guard
 * does not know. Only service workers (refused before their script loads, decision 0015; a guard evaluation there
 * would never answer) and shared workers (Chromium does not send their console to main) run without it.
 */
async function guardChildTarget(
  dbg: Electron.Debugger,
  scopes: Set<string>,
  starts: number[],
  queue: { count: number },
  sessionId: string,
  type: string,
  source: string,
  waiting: boolean,
) {
  let resume = false;
  try {
    if (type === 'iframe') {
      await dbg.sendCommand('Page.enable', {}, sessionId);
      // A frame that did not wait (should not happen, see DISABLED_CHROMIUM_FEATURES) gets it at once as well.
      await dbg.sendCommand(
        'Page.addScriptToEvaluateOnNewDocument',
        waiting ? { source } : { source, runImmediately: true },
        sessionId,
      );
      resume = true;
    } else if (type === 'worker' || type === 'worklet') {
      // Each one starts with its own small budget: at most MAX_GUARDED_SCOPES start per FLOOD_WINDOW_MS (the others
      // wait, paused, for their turn) and run at once (further ones never start).
      if (!(await scopeStartTurn(starts, queue))) return;
      if (scopes.size >= MAX_GUARDED_SCOPES) return;
      scopes.add(sessionId);
      // Their global scope exists and waits; the guard runs before their own script.
      const result = (await dbg.sendCommand('Runtime.evaluate', { expression: source }, sessionId)) as {
        exceptionDetails?: unknown;
      };
      if (result.exceptionDetails) throw new Error('page guard failed in a child target');
      resume = true;
    } else if (type === 'service_worker' || type === 'shared_worker') {
      resume = true;
    }
    if (resume && (type === 'iframe' || type === 'worker')) {
      await dbg.sendCommand('Target.setAutoAttach', AUTO_ATTACH, sessionId).catch(() => undefined); // nested targets
    }
  } catch {
    // The target went away or refused the guard: it stays paused (fails closed) and does not hold a slot.
    resume = false;
    scopes.delete(sessionId);
  }
  if (resume) await dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
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
