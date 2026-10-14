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
  readonly at: number;
}

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

export type PreviewStartError = 'unknown-project' | 'no-window' | 'server-failed';

export interface PreviewApi {
  /** Starts the loopback server and the isolated view for the project, replacing any other preview. */
  start(request: { readonly projectId: string }): Promise<IpcResult<PreviewStatus, PreviewStartError>>;
  /** Destroys the preview view (also when the page is hung) and shuts the server down. */
  stop(): Promise<IpcResult<PreviewStatus, never>>;
  reload(): Promise<IpcResult<PreviewStatus, never>>;
  /** Where the view sits over the preview pane, in workbench CSS pixels. */
  setBounds(bounds: PreviewBounds): Promise<IpcResult<null, never>>;
  /** Subscribes to status and log events; returns the unsubscribe function. */
  onEvent(listener: (event: PreviewEvent) => void): () => void;
}

const MAX_COORDINATE = 100_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parsePreviewStart(payload: unknown): { projectId: string } | null {
  if (!isRecord(payload) || Object.keys(payload).length !== 1) return null;
  return isProjectId(payload.projectId) ? { projectId: payload.projectId } : null;
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
