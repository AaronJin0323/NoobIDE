import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { CHANNELS, parseNoPayload, toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  parseBufferRef,
  parseJournalRecordRequest,
  parseJournalSavedRequest,
  parseRecoveryKeyRequest,
  type PendingRecovery,
} from '../shared/ipc/recovery-contract';
import type { RecoveryJournal } from '../recovery/journal';
import type { ProjectService } from '../workspace/project-service';
import type { HandleFn } from './ipc';

/**
 * Handlers of the crash-recovery channels (S12). Registered by registerIpcHandlers, so the sender and payload checks
 * of ipc.ts run first. The renderer only ever names an open project by id plus a relative path; the journal is keyed
 * by the project's real root path, which main looks up. Reopening a project after a crash uses the root path that
 * main itself stored in the journal, never a path from the renderer.
 */
export type RecoveryJournalPort = Pick<
  RecoveryJournal,
  'record' | 'discardSaved' | 'discard' | 'listPending' | 'rootOfPending' | 'read' | 'usage' | 'clearAll'
>;

const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;

export function registerRecoveryHandlers(
  handle: HandleFn,
  projects: Pick<ProjectService, 'open' | 'read' | 'rootOf'>,
  journal: RecoveryJournalPort,
  /** S07.3: a project reopened from recovery is watched like one opened from the folder dialog. */
  projectOpened?: (projectId: string, root: string, sender: IpcMainInvokeEvent['sender']) => void,
): void {
  const target = (projectId: string, relPath: string) => {
    const rootPath = projects.rootOf(projectId);
    return rootPath === undefined ? undefined : { rootPath, relPath };
  };

  handle(CHANNELS.recoveryRecord, parseJournalRecordRequest, async (request) => {
    const t = target(request.projectId, request.relPath);
    if (!t) return UNKNOWN_PROJECT;
    return toIpcResult(await journal.record(t, request));
  });

  handle(CHANNELS.recoveryDiscardSaved, parseJournalSavedRequest, async (request) => {
    const t = target(request.projectId, request.relPath);
    if (!t) return UNKNOWN_PROJECT;
    return toIpcResult(await journal.discardSaved(t, request.bufferId, request.revision));
  });

  handle(CHANNELS.recoveryDiscard, parseBufferRef, async (request) => {
    const t = target(request.projectId, request.relPath);
    if (!t) return UNKNOWN_PROJECT;
    return toIpcResult(await journal.discard(t, request.bufferId));
  });

  handle(CHANNELS.recoveryListPending, parseNoPayload, async (): Promise<IpcResult<PendingRecovery, never>> => {
    const [pending, usage] = await Promise.all([journal.listPending(), journal.usage()]);
    return {
      ok: true,
      value: {
        projects: pending.map((p) => ({
          key: p.key,
          name: path.basename(p.rootPath),
          rootPath: p.rootPath,
          files: p.files,
        })),
        usage: { bytes: usage.bytes, entries: usage.entries, maxTotalBytes: usage.limits.maxTotalBytes },
      },
    };
  });

  handle(CHANNELS.recoveryOpenProject, parseRecoveryKeyRequest, async ({ key }, event) => {
    const rootPath = await journal.rootOfPending(key);
    if (rootPath === undefined) return { ok: false, code: 'not-found', message: 'no recovery data for this key' };
    const opened = await projects.open(rootPath);
    if (opened.ok) projectOpened?.(opened.value.projectId, opened.value.rootPath, event.sender);
    return toIpcResult(opened);
  });

  handle(CHANNELS.recoveryRead, parseBufferRef, async (request) => {
    const t = target(request.projectId, request.relPath);
    if (!t) return UNKNOWN_PROJECT;
    const entry = await journal.read(t, request.bufferId);
    if (!entry.ok) return toIpcResult(entry);
    const disk = await projects.read({ projectId: request.projectId, relPath: request.relPath });
    const { relPath, bufferId, revision, updatedAt, text, bom } = entry.value;
    return {
      ok: true,
      value: {
        relPath,
        bufferId,
        revision,
        updatedAt,
        text,
        bom,
        disk: disk.ok ? disk.value : null,
        diskError: disk.ok ? null : disk.code,
      },
    };
  });

  handle(CHANNELS.recoveryClear, parseNoPayload, async () => toIpcResult(await journal.clearAll()));
}
