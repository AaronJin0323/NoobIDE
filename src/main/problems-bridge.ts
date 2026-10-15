import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { parseNoPayload, type IpcResult } from '../shared/ipc/contract';
import type { PreviewLogEntry } from '../shared/ipc/preview-contract';
import { PROBLEMS_CHANNELS, PROBLEMS_EVENT_CHANNEL } from '../shared/ipc/problems-contract';
import type { ProblemRecord } from '../shared/problem';
import { RuntimeCapture, type RuntimeCaptureOptions, type RuntimeSession } from '../diagnostics/runtime-capture';
import type { PreviewCaptureHook } from '../preview/preview-manager';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * Main-side bridge of the runtime capture adapter (S16.2): the PreviewManager reports into it (its `capture` hook),
 * it keeps the bounded problem store, and the workbench window that runs the preview reads it through
 * `window.noobide.problems` (src/shared/ipc/problems-contract.ts). Change notifications go to that window only.
 */

/** Where change notifications go: the workbench contents that started the preview. */
export interface ProblemsTarget {
  isDestroyed(): boolean;
  send(channel: string, records: readonly ProblemRecord[]): void;
}

export class ProblemsBridge implements PreviewCaptureHook {
  readonly capture: RuntimeCapture;
  private target: ProblemsTarget | null = null;

  constructor(options: Omit<RuntimeCaptureOptions, 'publish'> = {}) {
    this.capture = new RuntimeCapture({
      ...options,
      publish: (snapshot) => {
        const target = this.target;
        if (target && !target.isDestroyed()) target.send(PROBLEMS_EVENT_CHANNEL, snapshot.records);
      },
    });
  }

  sessionStarted(session: RuntimeSession, target: ProblemsTarget): void {
    this.target = target;
    this.capture.sessionStarted(session);
  }

  navigationStarted(): void {
    this.capture.navigationStarted();
  }

  navigationCommitted(): void {
    this.capture.navigationCommitted();
  }

  entry(entry: PreviewLogEntry): void {
    this.capture.entry(entry);
  }

  sessionEnded(): void {
    this.capture.sessionEnded();
  }

  /** Read-only snapshot for the e2e suite (messages and URLs the page reported; never file contents). */
  debugInfo() {
    return this.capture.snapshot();
  }

  dispose(): void {
    this.capture.dispose();
    this.target = null;
  }
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

/** Same checks as ipc.ts, in the same order: trusted workbench sender, at most one argument, payload parser. */
export function registerProblemsIpcHandlers(
  ipc: Pick<IpcMain, 'handle'>,
  deps: { readonly allowedOrigin: string; readonly bridge: ProblemsBridge },
): void {
  const handle = (channel: string, run: () => IpcResult<unknown, never>) => {
    ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1 || parseNoPayload(args[0]) === null) return INVALID;
      return run();
    });
  };
  handle(PROBLEMS_CHANNELS.list, () => ({ ok: true, value: deps.bridge.capture.list() }));
  handle(PROBLEMS_CHANNELS.clearResolved, () => {
    const removed = deps.bridge.capture.clearResolved();
    deps.bridge.capture.flush();
    return { ok: true, value: removed };
  });
}
