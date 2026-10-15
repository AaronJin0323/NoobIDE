/**
 * Typed contract for the preview (S04.3, S05). Same rules as contract.ts: the renderer sends only an opaque
 * projectId and plain numbers; main validates every payload with the parsers below and checks the sender.
 * The preview page itself has no preload and never reaches these channels.
 * Pure TypeScript: no Electron, Node or DOM imports.
 */
import { isProjectId, type IpcResult } from './contract';

export const PREVIEW_CHANNELS = {
  start: 'preview:start',
  stop: 'preview:stop',
  reload: 'preview:reload',
  setBounds: 'preview:set-bounds',
  // S14.2 refresh mode, typing pause, one-time notes
  typing: 'preview:typing',
  setRefreshMode: 'preview:set-refresh-mode',
  notes: 'preview:notes',
  noteSeen: 'preview:note-seen',
  // S14.3 entry page picker
  options: 'preview:options',
  // S14.5 per-project storage
  clearData: 'preview:clear-data',
  // S15.4 toolbar
  openExternal: 'preview:open-external',
  devTools: 'preview:devtools',
  /** S15.5/S15.6: move the keyboard focus into the page. */
  focus: 'preview:focus',
  /** Open the entry page again (e.g. after a link led to a page that does not exist). */
  goToEntry: 'preview:go-to-entry',
} as const;

/** Main → workbench notifications (webContents.send). */
export const PREVIEW_EVENT_CHANNEL = 'preview:event';

/** PLAN §8: every preview instance is in exactly one of these states. */
export type PreviewState = 'stopped' | 'starting' | 'running' | 'refreshing' | 'unresponsive' | 'failed';

export type PreviewFailure = 'server-failed' | 'load-failed' | 'crashed';

export interface PreviewStatus {
  readonly state: PreviewState;
  /** Project the preview belongs to; null when stopped. */
  readonly projectId: string | null;
  /** Only when state is 'failed'. */
  readonly failure?: PreviewFailure;
  /** Address of the page, for display and "open in browser" later. */
  readonly url?: string;
  /**
   * S14.1 page-load generation (src/preview/state-machine.ts): +1 on every Start, refresh and page-initiated
   * navigation; never decreases, not reset by Stop. Records of a lower generation are stale (S16.3). Main always
   * sets it; optional only so older literals (renderer fallbacks, tests) stay valid.
   */
  readonly generation?: number;
  /**
   * S14.2 manual refresh mode: a file was saved after this page loaded, so the page may be older than the files.
   * Cleared by the next refresh, navigation, start or stop.
   */
  readonly outdated?: boolean;
  /**
   * The page showing (`url`) does not exist: the server answered 404 (e.g. a link to a missing page). Cleared by the
   * next page that loads.
   */
  readonly notFound?: boolean;
}

/** S14.2: stored in `.noobide/project.json` (preview.autoRefresh) by the S13.2 module; auto is the default. */
export type RefreshMode = 'auto' | 'manual';

/** S14.2: notes shown once and then remembered in app data. */
export type PreviewNoteId = 'reload-clears-state';
export const PREVIEW_NOTE_IDS: readonly PreviewNoteId[] = ['reload-clears-state'];

/** S14.3: what the preview toolbar needs to know about the open project. */
export interface PreviewProjectOptions {
  /** Pages the entry picker offers (portable relative paths, index.html first). */
  readonly pages: readonly string[];
  /** The listing stopped at a limit. */
  readonly truncated: boolean;
  /** The configured entry page (`.noobide/project.json`), or null for the default index.html. */
  readonly entry: string | null;
  readonly refresh: RefreshMode;
  /** `.noobide/project.json` could not be read; settings cannot be changed until the user fixes or deletes it. */
  readonly configLocked: boolean;
  /**
   * Only when the project has no page: files that start like an HTML document but whose name does not end in
   * `.html` (`html/home`, `page.hmtl`), with the name a rename would give them. Never renamed without the user.
   */
  readonly misnamed?: readonly { readonly path: string; readonly suggested: string }[];
}

/** A raw record from the preview page (console, uncaught error, failed request). Diagnostics rules interpret it. */
export interface PreviewLogEntry {
  readonly source: 'console' | 'exception' | 'network' | 'page-load';
  readonly level: 'debug' | 'info' | 'warning' | 'error';
  /** The page's own message, truncated. Shown in the IDE only, never written to logs. */
  readonly message: string;
  /** Script or resource URL the record is about, when known. */
  readonly url?: string;
  /** 1-based line in `url`, when the engine reports it. */
  readonly line?: number;
  /** HTTP status for network records. */
  readonly status?: number;
  /** Electron webRequest resource type for network records ('script', 'image', 'xhr', …). */
  readonly resourceType?: string;
  /**
   * S16.4: network records — the URL of the document, stylesheet or module that asked for the resource (the
   * request's referrer, which Chromium sets to the requesting stylesheet / importing module, else the page).
   */
  readonly initiator?: string;
  /**
   * An IDE notice about the page rather than the page's own output (`source: 'page-load'`); the workbench shows it
   * localised instead of `message` (an English fallback).
   */
  readonly notice?: PreviewNotice;
  readonly at: number;
}

/** S25.4: what a denied permission request asked for (src/preview/permission-policy.ts). */
export type PreviewPermissionKind =
  | 'camera'
  | 'microphone'
  | 'camera-microphone'
  | 'location'
  | 'notifications'
  | 'midi'
  | 'clipboard'
  | 'screen'
  | 'devices'
  | 'fullscreen'
  | 'other';

export type PreviewNotice =
  /** S25.4: the page asked for a permission; the preview denies every permission. */
  | { readonly kind: 'permission-denied'; readonly permission: PreviewPermissionKind }
  /** Decision 0016 amendment: the page bypassed the console limit; its running script was stopped. */
  | { readonly kind: 'console-flood-stopped' }
  /** S25.1/S25.2: after sleep the preview was restarted because its server or its page had stopped answering. */
  | { readonly kind: 'restarted-after-sleep'; readonly reason: 'server' | 'page' };

export type PreviewEvent =
  | { readonly kind: 'status'; readonly status: PreviewStatus }
  | {
      readonly kind: 'log';
      readonly entries: readonly PreviewLogEntry[];
      /** Entries dropped since the previous batch because the page logged faster than the cap. */
      readonly dropped: number;
      /** Capture was paused by the flood guard: even more messages were skipped than `dropped` counts. */
      readonly throttled: boolean;
    };

export interface PreviewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
}

export type PreviewStartError = 'unknown-project' | 'no-window' | 'server-failed' | 'not-owner' | 'not-trusted';

/**
 * S14.4 (PLAN §8): who asked for the start. `user` — the user pressed "Start preview" (consent: the folder is
 * remembered as trusted in app data). `auto` — the workbench starts the preview by itself after opening a project;
 * main refuses it with `not-trusted` unless the folder is trusted (Start pressed once before, or created from a
 * built-in template). Absent means `user`.
 */
export type PreviewStartTrigger = 'user' | 'auto';

export interface PreviewStartRequest {
  readonly projectId: string;
  readonly trigger?: PreviewStartTrigger;
}

export interface PreviewApi {
  /** Starts the loopback server and the isolated view for the project, replacing any other preview. */
  start(request: PreviewStartRequest): Promise<IpcResult<PreviewStatus, PreviewStartError>>;
  /**
   * Destroys the preview view (also when the page is hung) and shuts the server down. S14.6: only the window that
   * started the preview may stop it; naming a project that is not the previewed one is refused too (`not-owner`).
   */
  stop(request?: PreviewOwnerRequest): Promise<IpcResult<PreviewStatus, 'not-owner'>>;
  reload(request?: PreviewOwnerRequest): Promise<IpcResult<PreviewStatus, 'not-owner'>>;
  /** Opens the project's entry page in the running preview (`not-running` when there is no page to navigate). */
  goToEntry?(request?: PreviewOwnerRequest): Promise<IpcResult<PreviewStatus, 'not-owner' | 'not-running'>>;
  /** Where the view sits over the preview pane, in workbench CSS pixels. Ignored for a preview of another window. */
  setBounds(bounds: PreviewBounds): Promise<IpcResult<null, 'not-owner'>>;
  /** S15.5/S15.6: gives the page the keyboard focus (F6 / Shift+F6 in the page hand it back). */
  focus(): Promise<IpcResult<null, 'not-owner'>>;
  /** Subscribes to status and log events; returns the unsubscribe function. */
  onEvent(listener: (event: PreviewEvent) => void): () => void;
  // --- S14.2 ---
  /** A key was typed in the code editor (throttled by the workbench): delays an automatic refresh. */
  typing?(): Promise<IpcResult<null, never>>;
  /** Writes the refresh mode into `.noobide/project.json`. */
  setRefreshMode?(request: SetRefreshModeRequest): Promise<IpcResult<RefreshMode, SetRefreshModeError>>;
  /** Which one-time notes were already shown (app data). */
  notes?(): Promise<IpcResult<readonly PreviewNoteId[], never>>;
  noteSeen?(request: { readonly note: PreviewNoteId }): Promise<IpcResult<null, never>>;
  // --- S14.3 ---
  options?(request: { readonly projectId: string }): Promise<IpcResult<PreviewProjectOptions, 'unknown-project'>>;
  // --- S14.5 ---
  /** Clears the project's preview storage (localStorage, IndexedDB, cookies, cache); a running page reloads. */
  clearData?(request: { readonly projectId: string }): Promise<IpcResult<null, 'unknown-project' | 'not-owner'>>;
  // --- S15.4 ---
  /** Opens the current page in the default browser through a one-time grant (the URL never reaches the renderer). */
  openExternal?(request: {
    readonly projectId: string;
  }): Promise<IpcResult<null, 'not-running' | 'not-owner' | 'open-failed'>>;
  /** Opens Chromium's developer tools for the preview page (advanced). */
  devTools?(request: { readonly projectId: string }): Promise<IpcResult<null, 'not-running' | 'not-owner'>>;
}

export interface SetRefreshModeRequest {
  readonly projectId: string;
  readonly mode: RefreshMode;
}

export type SetRefreshModeError = 'unknown-project' | 'invalid-existing' | 'outside-project' | 'write-failed';

export function parseSetRefreshMode(payload: unknown): SetRefreshModeRequest | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'mode,projectId' || !isProjectId(payload.projectId)) return null;
  return payload.mode === 'auto' || payload.mode === 'manual'
    ? { projectId: payload.projectId, mode: payload.mode }
    : null;
}

export function parseNoteRequest(payload: unknown): { note: PreviewNoteId } | null {
  if (!isRecord(payload) || Object.keys(payload).length !== 1) return null;
  const note = PREVIEW_NOTE_IDS.find((id) => id === payload.note);
  return note ? { note } : null;
}

/** `{ projectId }` exactly. */
export function parseProjectOnly(payload: unknown): { projectId: string } | null {
  if (!isRecord(payload) || Object.keys(payload).length !== 1) return null;
  return isProjectId(payload.projectId) ? { projectId: payload.projectId } : null;
}

/** S14.6: the project an action is meant for; refused when it is not the previewed project. */
export interface PreviewOwnerRequest {
  readonly projectId: string;
}

const MAX_COORDINATE = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parsePreviewStart(payload: unknown): { projectId: string; trigger: PreviewStartTrigger } | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload);
  if (!keys.every((key) => key === 'projectId' || key === 'trigger') || !isProjectId(payload.projectId)) return null;
  const trigger = payload.trigger ?? 'user';
  if (trigger !== 'user' && trigger !== 'auto') return null;
  return { projectId: payload.projectId, trigger };
}

/** stop / reload: no payload (the current preview) or `{ projectId }` (only if that project is previewed). */
export function parseOwnerRequest(payload: unknown): { projectId?: string } | null {
  if (payload === undefined) return {};
  return parseProjectOnly(payload);
}

export function parsePreviewBounds(payload: unknown): PreviewBounds | null {
  if (!isRecord(payload)) return null;
  const keys = Object.keys(payload).sort().join(',');
  if (keys !== 'height,visible,width,x,y') return null;
  const { x, y, width, height, visible } = payload;
  const coordinate = (v: unknown, min: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= MAX_COORDINATE;
  if (!coordinate(x, -MAX_COORDINATE) || !coordinate(y, -MAX_COORDINATE)) return null;
  if (!coordinate(width, 0) || !coordinate(height, 0) || typeof visible !== 'boolean') return null;
  return { x, y, width, height, visible };
}
