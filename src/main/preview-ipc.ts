import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseNoPayload, toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  PREVIEW_CHANNELS,
  parsePreviewBounds,
  parsePreviewStart,
  type PreviewBounds,
  type PreviewStartError,
  type PreviewStatus,
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
    focusPage(): void;
  };
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
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

  handle(PREVIEW_CHANNELS.start, parsePreviewStart, async ({ projectId }, event) => {
    const window = deps.windowOf(event);
    if (!window) return { ok: false, code: 'no-window', message: 'no workbench window' };
    return toIpcResult(await deps.preview.start(projectId, window));
  });
  handle(PREVIEW_CHANNELS.stop, parseNoPayload, async () => ({ ok: true, value: await deps.preview.stop() }));
  handle(PREVIEW_CHANNELS.reload, parseNoPayload, async () => ({ ok: true, value: deps.preview.reload() }));
  handle(PREVIEW_CHANNELS.setBounds, parsePreviewBounds, async (bounds) => {
    deps.preview.setBounds(bounds);
    return { ok: true, value: null };
  });
  handle(PREVIEW_CHANNELS.focus, parseNoPayload, async () => {
    deps.preview.focusPage();
    return { ok: true, value: null };
  });
}
