import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseNoPayload, toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  PREVIEW_CHANNELS,
  parseNoteRequest,
  parseOwnerRequest,
  parsePreviewBounds,
  parsePreviewStart,
  parseProjectOnly,
  parseSetRefreshMode,
  type PreviewBounds,
  type PreviewNoteId,
  type PreviewProjectOptions,
  type PreviewStartError,
  type PreviewStatus,
  type RefreshMode,
  type SetRefreshModeError,
} from '../shared/ipc/preview-contract';
import type { Result } from '../shared/result';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers for the preview channels (S04.3). Same checks as ipc.ts, in the same order: trusted workbench sender,
 * at most one argument, payload parser — before the preview manager is touched.
 */
export interface PreviewIpcDeps {
  readonly allowedOrigin: string;
  /** The workbench window that sent the request. */
  windowOf(event: IpcMainInvokeEvent): BrowserWindow | null;
  readonly preview: {
    start(projectId: string, window: BrowserWindow): Promise<Result<PreviewStatus, PreviewStartError>>;
    stop(): Promise<PreviewStatus>;
    reload(): PreviewStatus;
    setBounds(bounds: PreviewBounds): void;
    /** S14.6: the requesting window (webContents id) started the preview, and it is of the named project. */
    isOwner(requester: { readonly windowId: number; readonly projectId?: string | undefined }): boolean;
    // S14.2 / S14.5 / S15.4 (optional so older fakes stay valid; main.ts passes the real manager)
    typing?(): void;
    clearData?(projectId: string): Promise<Result<null, 'unknown-project'>>;
    openExternal?(): Promise<Result<null, 'not-running'>>;
    openDevTools?(): Result<null, 'not-running'>;
  };
  /** S14.2/S14.3: project preview settings (.noobide/project.json) and one-time notes (app data). */
  readonly settings?: {
    options(projectId: string): Promise<Result<PreviewProjectOptions, 'unknown-project'>>;
    setRefreshMode(projectId: string, mode: RefreshMode): Promise<Result<RefreshMode, SetRefreshModeError>>;
    notesSeen(): Promise<readonly PreviewNoteId[]>;
    markNoteSeen(note: PreviewNoteId): Promise<void>;
  };
  /**
   * S14.4 start-preview consent (trust in app data, keyed by the project's real root, which only main knows).
   * Without it every start is allowed (tests, tools).
   */
  readonly trust?: {
    isTrusted(projectId: string): Promise<boolean>;
    trust(projectId: string): Promise<void>;
  };
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const NOT_OWNER = {
  ok: false,
  code: 'not-owner',
  message: 'the preview belongs to another window or project',
} as const;
const UNAVAILABLE = { ok: false, code: 'unavailable', message: 'not available in this build' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerPreviewIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: PreviewIpcDeps): void {
  function handle<P>(
    channel: string,
    parse: (payload: unknown) => P | null,
    run: (payload: P, event: IpcMainInvokeEvent) => Promise<IpcResult<unknown, string>>,
  ): void {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  }

  handle(PREVIEW_CHANNELS.start, parsePreviewStart, async ({ projectId, trigger }, event) => {
    const window = deps.windowOf(event);
    if (!window) return { ok: false, code: 'no-window', message: 'no workbench window' };
    // S14.4: an automatic start runs only a trusted folder; the user's "Start preview" is the consent and is kept.
    if (deps.trust) {
      if (trigger === 'auto' && !(await deps.trust.isTrusted(projectId))) {
        return { ok: false, code: 'not-trusted', message: 'press Start preview once to run this folder' };
      }
      if (trigger === 'user') await deps.trust.trust(projectId);
    }
    return toIpcResult(await deps.preview.start(projectId, window));
  });
  // S14.6 ownership: stop, reload and bounds act only for the window that started the preview (and the named project).
  const owns = (event: IpcMainInvokeEvent, projectId?: string) =>
    deps.preview.isOwner({ windowId: event.sender.id, projectId });
  handle(PREVIEW_CHANNELS.stop, parseOwnerRequest, async ({ projectId }, event) =>
    owns(event, projectId) ? { ok: true, value: await deps.preview.stop() } : NOT_OWNER,
  );
  handle(PREVIEW_CHANNELS.reload, parseOwnerRequest, async ({ projectId }, event) =>
    owns(event, projectId) ? { ok: true, value: deps.preview.reload() } : NOT_OWNER,
  );
  // --- S14.2 refresh mode, typing pause and one-time notes ---
  handle(PREVIEW_CHANNELS.typing, parseNoPayload, async () => {
    deps.preview.typing?.();
    return { ok: true, value: null };
  });
  handle(PREVIEW_CHANNELS.setRefreshMode, parseSetRefreshMode, async ({ projectId, mode }) =>
    deps.settings ? toIpcResult(await deps.settings.setRefreshMode(projectId, mode)) : UNAVAILABLE,
  );
  handle(PREVIEW_CHANNELS.notes, parseNoPayload, async () => ({
    ok: true,
    value: deps.settings ? await deps.settings.notesSeen() : [],
  }));
  handle(PREVIEW_CHANNELS.noteSeen, parseNoteRequest, async ({ note }) => {
    await deps.settings?.markNoteSeen(note);
    return { ok: true, value: null };
  });
  // --- S14.3 entry page picker ---
  handle(PREVIEW_CHANNELS.options, parseProjectOnly, async ({ projectId }) =>
    deps.settings ? toIpcResult(await deps.settings.options(projectId)) : UNAVAILABLE,
  );
  // --- S14.5 / S15.4 toolbar actions: only for the window that owns the preview (S14.6) ---
  handle(PREVIEW_CHANNELS.clearData, parseProjectOnly, async ({ projectId }, event) => {
    if (!owns(event, projectId)) return NOT_OWNER;
    return deps.preview.clearData ? toIpcResult(await deps.preview.clearData(projectId)) : UNAVAILABLE;
  });
  handle(PREVIEW_CHANNELS.openExternal, parseProjectOnly, async ({ projectId }, event) => {
    if (!owns(event, projectId)) return NOT_OWNER;
    return deps.preview.openExternal ? toIpcResult(await deps.preview.openExternal()) : UNAVAILABLE;
  });
  handle(PREVIEW_CHANNELS.devTools, parseProjectOnly, async ({ projectId }, event) => {
    if (!owns(event, projectId)) return NOT_OWNER;
    return deps.preview.openDevTools ? toIpcResult(deps.preview.openDevTools()) : UNAVAILABLE;
  });
  handle(PREVIEW_CHANNELS.setBounds, parsePreviewBounds, async (bounds, event) => {
    if (!owns(event)) return NOT_OWNER;
    deps.preview.setBounds(bounds);
    return { ok: true, value: null };
  });
}
