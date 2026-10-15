import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { AI_CHANNELS, AI_EVENT_CHANNEL, type AiEvent } from '../shared/ipc/ai-contract';
import {
  parseAiRequest,
  parseProposalDecision,
  parseProviderOnly,
  parseRequestId,
  parseSetConfig,
  parseSetConsent,
  parseSetKey,
  parseStatusRequest,
} from '../shared/ipc/ai-parse';
import { toIpcResult, type IpcResult } from '../shared/ipc/contract';
import type { AiService } from '../ai/service';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers of the AI channels (S31.3, decision 0025). Same checks as ipc.ts / preview-ipc.ts, in the same order:
 * the sender is the workbench's top-level frame on the app origin, at most one argument, and it passes the channel's
 * parser (src/shared/ipc/ai-parse.ts) — before the service is touched. The preview page has no preload and can never
 * reach these channels.
 *
 * No response ever contains the API key: setKey answers `null`, status only says which providers have a key.
 * Request events go to the window that started the request; when it is destroyed its requests are cancelled.
 */
export interface AiIpcDeps {
  readonly allowedOrigin: string;
  readonly service: Pick<
    AiService,
    | 'status'
    | 'setKey'
    | 'clearKey'
    | 'testKey'
    | 'listModels'
    | 'setConfig'
    | 'setConsent'
    | 'request'
    | 'cancel'
    | 'cancelAllFor'
    | 'resolveProposal'
  >;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;

export function registerAiIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: AiIpcDeps): void {
  const { service } = deps;
  const watched = new Set<number>();

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

  /**
   * Cancels a window's requests when its page goes away: closed, reloaded (a new document keeps the same webContents id,
   * so its new page must not inherit — or be able to resolve — the old page's runs), or the renderer crashed (S36.1).
   */
  function watch(event: IpcMainInvokeEvent): void {
    const contents = event.sender;
    if (watched.has(contents.id)) return;
    watched.add(contents.id);
    const id = contents.id;
    contents.once('destroyed', () => {
      watched.delete(id);
      service.cancelAllFor(id);
    });
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) service.cancelAllFor(id);
    });
    contents.on('render-process-gone', () => service.cancelAllFor(id));
  }

  handle(AI_CHANNELS.status, parseStatusRequest, async ({ projectId }) => ({
    ok: true,
    value: await service.status(projectId),
  }));
  handle(AI_CHANNELS.setKey, parseSetKey, async ({ provider, key }) =>
    toIpcResult(await service.setKey(provider, key)),
  );
  handle(AI_CHANNELS.clearKey, parseProviderOnly, async ({ provider }) =>
    toIpcResult(await service.clearKey(provider)),
  );
  handle(AI_CHANNELS.testKey, parseProviderOnly, async ({ provider }) => toIpcResult(await service.testKey(provider)));
  handle(AI_CHANNELS.listModels, parseProviderOnly, async ({ provider }) =>
    toIpcResult(await service.listModels(provider)),
  );
  handle(AI_CHANNELS.setConfig, parseSetConfig, async ({ config }) => ({
    ok: true,
    value: await service.setConfig(config),
  }));
  handle(AI_CHANNELS.setConsent, parseSetConsent, async ({ projectId, allowed }) =>
    toIpcResult(await service.setConsent(projectId, allowed)),
  );
  handle(AI_CHANNELS.request, parseAiRequest, async (request, event) => {
    watch(event);
    const contents = event.sender;
    const sink = (aiEvent: AiEvent) => {
      if (!contents.isDestroyed()) contents.send(AI_EVENT_CHANNEL, aiEvent);
    };
    return toIpcResult(await service.request(request, contents.id, sink));
  });
  handle(AI_CHANNELS.cancel, parseRequestId, async ({ requestId }, event) => {
    service.cancel(requestId, event.sender.id);
    return { ok: true, value: null };
  });
  handle(AI_CHANNELS.resolveProposal, parseProposalDecision, async (decision, event) =>
    toIpcResult(service.resolveProposal(decision, event.sender.id)),
  );
}
