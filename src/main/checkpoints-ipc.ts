import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  CHECKPOINT_CHANNELS,
  parseCheckpointFile,
  parseCheckpointProject,
  parseCheckpointRef,
  parseCreateCheckpoint,
  parseRenameCheckpoint,
  parseRestoreFile,
  type CheckpointErrorCode,
  type CheckpointListing,
  type CheckpointResult,
} from '../shared/ipc/checkpoints-contract';
import type { CheckpointErr, CheckpointStore, CheckpointSummary } from '../recovery/checkpoints';
import type { ProjectService } from '../workspace/project-service';
import { decodeText } from '../workspace/text-codec';
import { isTrustedSender, senderInfo } from './ipc';

/**
 * IPC handlers of project checkpoints (S56). The same checks as the other handlers, in the same order: the sender is
 * the workbench's top-level frame on the app origin, at most one argument, and it passes the channel's parser
 * (src/shared/ipc/checkpoints-contract.ts) — before a store is touched. Projects are named by their opaque id; only
 * main knows the real root. Checkpoints live in app data (src/recovery/checkpoints.ts), never in the project.
 *
 * `restoreFile` is the only handler that writes a project file: through ProjectService.restoreBytes (atomic replace,
 * the expected version checked twice, local history keeps the replaced version, preview refresh after the rename).
 * The renderer restores open text files through their editor tab instead.
 */
export interface CheckpointsIpcDeps {
  readonly allowedOrigin: string;
  readonly store: Pick<
    CheckpointStore,
    'list' | 'create' | 'rename' | 'delete' | 'compare' | 'readFile' | 'usage' | 'limits'
  >;
  readonly projects: Pick<ProjectService, 'rootOf' | 'restoreBytes'>;
}

const FORBIDDEN = { ok: false, code: 'forbidden-sender', message: 'sender is not the workbench' } as const;
const INVALID = { ok: false, code: 'invalid-request', message: 'payload does not match the contract' } as const;
const UNKNOWN_PROJECT = { ok: false, code: 'unknown-project', message: 'project is not open' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function failure(e: CheckpointErr): CheckpointResult<never> {
  return e.detail === undefined
    ? { ok: false, code: e.code, message: e.message }
    : { ok: false, code: e.code, message: e.message, detail: e.detail };
}

const info = (s: CheckpointSummary) => ({ ...s });

export function registerCheckpointsIpcHandlers(ipc: Pick<IpcMain, 'handle'>, deps: CheckpointsIpcDeps): void {
  const { store, projects } = deps;

  function handle<P>(
    channel: string,
    parse: (payload: unknown) => P | null,
    run: (payload: P, event: IpcMainInvokeEvent) => Promise<CheckpointResult<unknown>>,
  ): void {
    ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!isTrustedSender(senderInfo(event), deps.allowedOrigin)) return FORBIDDEN;
      if (args.length > 1) return INVALID;
      const payload = parse(args[0]);
      if (payload === null) return INVALID;
      return run(payload, event);
    });
  }

  handle(CHECKPOINT_CHANNELS.list, parseCheckpointProject, async ({ projectId }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const listed = await store.list(root);
    if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };
    const usage = await store.usage(root);
    const value: CheckpointListing = {
      checkpoints: listed.value.checkpoints.map(info),
      damaged: listed.value.damaged.map((d) => ({ ...d })),
      usage: {
        totalBytes: usage.totalBytes,
        projectBytes: usage.projectBytes,
        maxTotalBytes: usage.limits.maxTotalBytes,
        named: usage.named,
        automatic: usage.automatic,
        maxNamed: usage.limits.maxNamed,
        maxAuto: usage.limits.maxAuto,
        maxAutoAgeDays: Math.round(usage.limits.maxAutoAgeMs / DAY_MS),
        maxFiles: usage.limits.maxFiles,
        maxFileBytes: usage.limits.maxFileBytes,
      },
    };
    return { ok: true, value };
  });

  handle(CHECKPOINT_CHANNELS.create, parseCreateCheckpoint, async ({ projectId, name, kind, cause, keep }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const made = await store.create(root, { name, kind, cause, ...(keep !== undefined ? { keep } : {}) });
    if (!made.ok) return failure(made);
    return { ok: true, value: { checkpoint: info(made.value.checkpoint), deduped: made.value.deduped } };
  });

  handle(CHECKPOINT_CHANNELS.rename, parseRenameCheckpoint, async ({ projectId, id, name }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const renamed = await store.rename(root, id, name);
    return renamed.ok ? { ok: true, value: info(renamed.value) } : failure(renamed);
  });

  handle(CHECKPOINT_CHANNELS.delete, parseCheckpointRef, async ({ projectId, id }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const deleted = await store.delete(root, id);
    return deleted.ok ? { ok: true, value: null } : failure(deleted);
  });

  handle(CHECKPOINT_CHANNELS.compare, parseCheckpointRef, async ({ projectId, id }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const compared = await store.compare(root, id);
    if (!compared.ok) return failure(compared);
    return {
      ok: true,
      value: {
        checkpoint: info(compared.value.checkpoint),
        incomplete: compared.value.incomplete,
        entries: compared.value.entries.map((e) => ({
          relPath: e.relPath,
          status: e.status,
          currentHash: e.currentHash,
          checkpointSize: e.checkpointSize,
          available: e.available,
        })),
      },
    };
  });

  handle(CHECKPOINT_CHANNELS.readText, parseCheckpointFile, async ({ projectId, id, relPath }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const data = await store.readFile(root, id, relPath);
    if (!data.ok) return failure(data);
    const decoded = decodeText(data.value);
    if (!decoded.ok) return { ok: false, code: 'not-text', message: decoded.reason };
    return { ok: true, value: { text: decoded.text, bom: decoded.bom } };
  });

  handle(CHECKPOINT_CHANNELS.restoreFile, parseRestoreFile, async ({ projectId, id, relPath, expectedHash }) => {
    const root = projects.rootOf(projectId);
    if (root === undefined) return UNKNOWN_PROJECT;
    const data = await store.readFile(root, id, relPath);
    if (!data.ok) return failure(data);
    const written = await projects.restoreBytes({ projectId, relPath, data: data.value, expectedHash });
    if (written.ok) return { ok: true, value: { relPath } };
    return { ok: false, code: restoreCode(written.code), message: written.message };
  });
}

function restoreCode(code: string): CheckpointErrorCode {
  switch (code) {
    case 'changed-on-disk':
      return 'changed-on-disk';
    case 'outside-project':
      return 'outside-project';
    case 'permission-denied':
    case 'read-only':
      return 'permission-denied';
    case 'disk-full':
      return 'disk-full';
    case 'not-found':
      return 'changed-on-disk';
    default:
      return 'write-failed';
  }
}
