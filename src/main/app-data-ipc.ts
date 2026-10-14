import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseNoPayload, type IpcResult } from '../shared/ipc/contract';
import { APP_DATA_CHANNELS } from '../shared/ipc/app-data-contract';
import { parseSettingsPatch } from '../shared/settings';
import { isTrustedSender, senderInfo } from './ipc';
import type { SettingsStore } from './settings-store';

/**
 * IPC handlers of the S13 app-data channels (app-data-contract.ts). Same checks as ipc.ts, in the same order: the
 * sender is the workbench's top-level frame on the app origin, at most one argument, and it passes the channel's
 * parser — before any store is touched.
 */
export interface AppDataIpcDeps {
  readonly allowedOrigin: string;
  readonly settings: Pick<SettingsStore, 'snapshot' | 'update'>;
  /** S13.6: shows the log folder in the file manager; resolves to an error text ('' on success, like shell.openPath). */
  openLogsFolder(): Promise<string>;
}

type Run<P> = (payload: P, event: IpcMainInvokeEvent) => Promise<IpcResult<unknown, string>>;

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerAppDataIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: AppDataIpcDeps): void {
  const handle = <P>(channel: string, parse: (payload: unknown) => P | null, run: Run<P>) => {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  };

  // ── S13.1 settings ──
  handle(APP_DATA_CHANNELS.settingsGet, parseNoPayload, async () => ({
    ok: true,
    value: await deps.settings.snapshot(),
  }));
  handle(APP_DATA_CHANNELS.settingsUpdate, parseSettingsPatch, async (patch) => ({
    ok: true,
    value: await deps.settings.update(patch),
  }));

  // ── S13.6 local logs ──
  handle(APP_DATA_CHANNELS.openLogsFolder, parseNoPayload, async () => {
    const error = await deps.openLogsFolder();
    return error === '' ? { ok: true, value: null } : { ok: false, code: 'open-failed', message: 'could not open' };
  });
}
