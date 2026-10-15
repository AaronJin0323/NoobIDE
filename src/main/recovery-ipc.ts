import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { CHANNELS, parseNoPayload, toIpcResult, type IpcResult } from '../shared/ipc/contract';
import {
  parseBufferRef,
  parseJournalRecordRequest,
  parseJournalSavedRequest,
  parsePendingRef,
  parseRecoveryKeyRequest,
  parseRelocateConfirm,
  type PendingRecovery,
  type RelocateError,
  type RelocateResult,
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
  | 'record'
  | 'discardSaved'
  | 'discard'
  | 'listPending'
  | 'rootOfPending'
  | 'read'
  | 'usage'
  | 'clearAll'
  | 'readPending'
  | 'discardPending'
  | 'retarget'
>;

/** Decision 0033: native dialogs shown by main for copies whose project folder is missing. */
export interface RecoveryDialogsPort {
  /** Native folder picker; `null` when cancelled. */
  chooseFolder(event: IpcMainInvokeEvent): Promise<string | null>;
  /** Native save dialog suggesting `fileName` (it asks before replacing a file); `null` when cancelled. */
  chooseSaveFile(event: IpcMainInvokeEvent, fileName: string): Promise<string | null>;
}

/** Relative paths (`/`-separated) that are not files inside `root`. */
export async function missingRelPaths(root: string, relPaths: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const relPath of relPaths) {
    const isFile = await stat(path.join(root, ...relPath.split('/'))).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!isFile) missing.push(relPath);
  }
  return missing;
}

const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;

export function registerRecoveryHandlers(
  handle: HandleFn,
  projects: Pick<ProjectService, 'open' | 'read' | 'rootOf' | 'writeStandaloneCopy'>,
  journal: RecoveryJournalPort,
  /** S07.3: a project reopened from recovery is watched like one opened from the folder dialog. */
  projectOpened?: (projectId: string, root: string, sender: IpcMainInvokeEvent['sender']) => void,
  dialogs?: RecoveryDialogsPort,
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

  // --- Decision 0033: copies of a project whose folder was moved, renamed or is on a missing drive. The renderer
  // names a copy by its journal key and buffer id only; folders and destinations come from dialogs shown by main. ---
  const NO_DIALOGS = { ok: false, code: 'not-found', message: 'no dialogs' } as const;

  handle(CHANNELS.recoveryReadPending, parsePendingRef, async ({ key, bufferId }) => {
    const entry = await journal.readPending(key, bufferId);
    if (!entry.ok) return toIpcResult(entry);
    const { relPath, revision, updatedAt, text, bom } = entry.value;
    return { ok: true, value: { relPath, bufferId, revision, updatedAt, text, bom } };
  });

  handle(CHANNELS.recoveryDiscardPending, parsePendingRef, async ({ key, bufferId }) =>
    toIpcResult(await journal.discardPending(key, bufferId)),
  );

  handle(CHANNELS.recoverySavePendingAs, parsePendingRef, async ({ key, bufferId }, event) => {
    if (!dialogs) return NO_DIALOGS;
    const entry = await journal.readPending(key, bufferId);
    if (!entry.ok) return toIpcResult(entry);
    const { relPath, text, bom } = entry.value;
    const destination = await dialogs.chooseSaveFile(event, relPath.slice(relPath.lastIndexOf('/') + 1));
    if (destination === null) return { ok: true, value: null };
    const saved = await projects.writeStandaloneCopy(destination, text, bom);
    if (!saved.ok) return toIpcResult(saved); // the journal copy stays
    // The text is safely on disk now: like a save, this empties the journal entry.
    const discarded = await journal.discardPending(key, bufferId);
    const removed = discarded.ok && discarded.value.removed;
    return { ok: true, value: { path: saved.value.path, removed } };
  });

  /** Folders the user picked that lack some recovered files, waiting for confirmation (latest choice only). */
  const choices = new Map<string, { key: string; folder: string }>();

  const relocate = async (
    key: string,
    folder: string,
    sender: IpcMainInvokeEvent['sender'],
  ): Promise<IpcResult<RelocateResult, RelocateError>> => {
    // Journal first (to the folder's real path, the root ProjectService will report), then open: a failed open
    // leaves the copies pointing at a folder that exists, so 'Open project and review' works next time.
    const moved = await journal.retarget(key, folder);
    if (!moved.ok) return toIpcResult(moved);
    const opened = await projects.open(folder);
    if (!opened.ok) return toIpcResult(opened);
    projectOpened?.(opened.value.projectId, opened.value.rootPath, sender);
    return { ok: true, value: { status: 'opened', project: opened.value } };
  };

  handle(CHANNELS.recoveryRelocate, parseRecoveryKeyRequest, async ({ key }, event) => {
    if (!dialogs) return NO_DIALOGS;
    const pending = (await journal.listPending()).find((p) => p.key === key);
    if (!pending) return { ok: false, code: 'not-found', message: 'no recovery data for this key' };
    const chosen = await dialogs.chooseFolder(event);
    if (chosen === null) return { ok: true, value: { status: 'cancelled' } };
    let folder: string;
    try {
      folder = await realpath(chosen);
      if (!(await stat(folder)).isDirectory()) return { ok: false, code: 'list-failed', message: 'not a directory' };
    } catch {
      return { ok: false, code: 'list-failed', message: 'folder cannot be read' };
    }
    const missing = await missingRelPaths(
      folder,
      pending.files.map((f) => f.relPath),
    );
    // Decision 0033: only a folder with the old name and every recovered file is used without asking; beginner
    // projects share names like index.html, so another project's folder would otherwise pass silently.
    if (missing.length === 0 && path.basename(folder) === path.basename(pending.rootPath)) {
      return relocate(key, folder, event.sender);
    }
    const choiceId = randomUUID();
    choices.clear();
    choices.set(choiceId, { key, folder });
    return {
      ok: true,
      value: { status: 'confirm', choiceId, folderName: path.basename(folder), missing: [...new Set(missing)] },
    };
  });

  handle(CHANNELS.recoveryRelocateConfirm, parseRelocateConfirm, async ({ key, choiceId }, event) => {
    const choice = choices.get(choiceId);
    if (!choice || choice.key !== key) return { ok: false, code: 'expired', message: 'choose the folder again' };
    choices.delete(choiceId);
    return relocate(key, choice.folder, event.sender);
  });
}
