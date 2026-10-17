import type {
  CheckpointCompareEntry,
  CheckpointComparison,
  CheckpointErrorCode,
  CheckpointsApi,
} from '../../shared/ipc/checkpoints-contract';
import type { NoobideApi } from '../../shared/ipc/contract';
import type { FileOpsHooks } from '../workbench/FilesPanel';

/**
 * Restoring a project checkpoint (S56.2). User data is sacred (AGENTS.md), so:
 *
 * - Before anything is written, an automatic checkpoint of the project as it is now is taken
 *   (`before-checkpoint-restore`), so a restore can itself be undone. If that fails, nothing is restored.
 * - Unsaved edits in open tabs are the user's call: saved first (and then part of that safety checkpoint), or kept,
 *   in which case those files are not restored and stay as they are in the editor.
 * - An open text file is restored through its editor tab: the checkpoint's text becomes the tab's content as one
 *   undo step and is saved by the tab's own save pipeline (atomic write, local history). Closed files (and files that
 *   are not text) are written by main through the same atomic replace, only while the file is still exactly the
 *   version the comparison saw; a file deleted since is created again, never over something that appeared meanwhile.
 * - Files added since the checkpoint go to the OS trash only when the user confirmed it (`trashAdded`), through the
 *   Files panel's path (unsaved edits saved first, a local-history copy kept). Otherwise they stay.
 * - A file that cannot be restored (its copy in the checkpoint is damaged, it changed meanwhile, its save failed) is
 *   skipped and reported; the others are restored.
 */
export interface CheckpointRestoreHost {
  readonly projectId: string;
  readonly checkpoints: Pick<CheckpointsApi, 'compare' | 'readText' | 'restoreFile' | 'create'>;
  readonly workspace: Pick<NoobideApi['workspace'], 'trashEntry'>;
  readonly fileOps: FileOpsHooks;
  /** The open tab of a file, or undefined. `blocked`: in a conflict with the disk or its file was deleted. */
  openTab(relPath: string):
    | {
        readonly text: string;
        readonly readOnly: boolean;
        readonly blocked?: boolean;
        readonly dirty?: boolean;
        /** The tab saves with a UTF-8 BOM (the file on disk has one). */
        readonly bom?: boolean;
      }
    | undefined;
  /** Saves the open tab's unsaved edits. False when that failed (the tab explains why). */
  saveOpen(relPath: string): Promise<boolean>;
  /** Makes `text` the open tab's content (one undo step) and saves it, if the tab still holds `before`. Null = saved. */
  replaceOpenText(relPath: string, before: string, text: string): Promise<{ readonly code: string } | null>;
}

export interface RestorePlan {
  readonly checkpointId: string;
  /** Changed or removed since the checkpoint, with a usable copy: written back. */
  readonly write: readonly CheckpointCompareEntry[];
  /** Changed or removed, but the checkpoint's copy is missing or damaged: cannot be restored. */
  readonly unavailable: readonly CheckpointCompareEntry[];
  /** Not in the checkpoint: moved to the trash only if the user confirms. */
  readonly added: readonly CheckpointCompareEntry[];
  /** Open files with unsaved edits among the files above: saved first or kept, by the user's choice. */
  readonly dirty: readonly string[];
}

/** What a restore of everything (or of `only` one file) would do. */
export function planRestore(
  comparison: CheckpointComparison,
  openTab: CheckpointRestoreHost['openTab'],
  only?: string,
): RestorePlan {
  const entries = comparison.entries.filter((e) => e.status !== 'same' && (only === undefined || e.relPath === only));
  const back = entries.filter((e) => e.status === 'changed' || e.status === 'removed');
  const added = entries.filter((e) => e.status === 'added');
  const touched = [...back.filter((e) => e.available), ...added].map((e) => e.relPath);
  return {
    checkpointId: comparison.checkpoint.id,
    write: back.filter((e) => e.available),
    unavailable: back.filter((e) => !e.available),
    added,
    dirty: touched.filter((relPath) => openTab(relPath)?.dirty === true),
  };
}

export interface RestoreChoices {
  /** Unsaved edits in affected tabs: saved first, or kept (those files are then not restored). */
  readonly unsaved: 'save' | 'keep';
  /** The user confirmed moving the files added since the checkpoint to the OS trash. */
  readonly trashAdded: boolean;
}

export type SkipReason =
  | 'unsaved-kept'
  | 'save-failed'
  | 'unavailable'
  | 'changed-on-disk'
  | 'open-blocked'
  | 'write-failed'
  | 'added-kept'
  | 'trash-failed';

export interface RestoreReport {
  readonly restored: readonly string[];
  readonly trashed: readonly string[];
  readonly skipped: readonly { readonly relPath: string; readonly reason: SkipReason }[];
  /** The automatic checkpoint taken first (null when the restore was aborted). */
  readonly safetyId: string | null;
  /** Set when nothing was restored because the safety checkpoint could not be taken. */
  readonly aborted?: { readonly code: CheckpointErrorCode | 'forbidden-sender' | 'invalid-request' };
}

export async function restoreFromCheckpoint(
  host: CheckpointRestoreHost,
  plan: RestorePlan,
  choices: RestoreChoices,
  /** Name of the automatic checkpoint taken first (already translated). */
  safetyName: string,
): Promise<RestoreReport> {
  const restored: string[] = [];
  const trashed: string[] = [];
  const skipped: { relPath: string; reason: SkipReason }[] = plan.unavailable.map((e) => ({
    relPath: e.relPath,
    reason: 'unavailable' as const,
  }));
  const skip = new Set<string>();
  const skipWith = (relPath: string, reason: SkipReason) => {
    skip.add(relPath);
    skipped.push({ relPath, reason });
  };

  // 1. Unsaved edits: the user's choice.
  const savedFirst: string[] = [];
  for (const relPath of plan.dirty) {
    if (choices.unsaved === 'keep') skipWith(relPath, 'unsaved-kept');
    else if (await host.saveOpen(relPath).catch(() => false)) savedFirst.push(relPath);
    else skipWith(relPath, 'save-failed');
  }
  if (!choices.trashAdded) {
    for (const e of plan.added) if (!skip.has(e.relPath)) skipWith(e.relPath, 'added-kept');
  }

  // What each file must still be when it is written or trashed: the version the user reviewed — or, for edits the
  // user chose to save first, what that save left. Anything else changed meanwhile and is left alone.
  const expected = new Map<string, string | null>(
    [...plan.write, ...plan.added].map((e) => [e.relPath, e.currentHash]),
  );
  if (savedFirst.length > 0) {
    const afterSave = await host.checkpoints.compare({ projectId: host.projectId, id: plan.checkpointId });
    const byPath = new Map((afterSave.ok ? afterSave.value.entries : []).map((e) => [e.relPath, e]));
    for (const relPath of savedFirst) {
      const entry = byPath.get(relPath);
      if (entry) expected.set(relPath, entry.currentHash);
      else skipWith(relPath, 'write-failed');
    }
  }

  // 2. The project as it is now is kept first; without it nothing is restored. The checkpoint being restored is
  // never pruned by it.
  const safety = await host.checkpoints
    .create({
      projectId: host.projectId,
      name: safetyName,
      kind: 'auto',
      cause: 'before-checkpoint-restore',
      keep: plan.checkpointId,
    })
    .catch(() => ({ ok: false as const, code: 'write-failed' as const, message: 'failed' }));
  if (!safety.ok) {
    return { restored: [], trashed: [], skipped: [], safetyId: null, aborted: { code: safety.code } };
  }

  // 3. The comparison as it is right now: each file is written only while it is still the expected version.
  const fresh = await host.checkpoints.compare({ projectId: host.projectId, id: plan.checkpointId });
  const now = new Map((fresh.ok ? fresh.value.entries : []).map((e) => [e.relPath, e]));

  for (const planned of plan.write) {
    if (skip.has(planned.relPath)) continue;
    const entry = now.get(planned.relPath);
    if (!entry) {
      skipWith(planned.relPath, fresh.ok ? 'changed-on-disk' : 'write-failed');
      continue;
    }
    if (entry.status === 'same') {
      restored.push(entry.relPath);
      continue;
    }
    if (entry.currentHash !== expected.get(entry.relPath)) {
      skipWith(entry.relPath, 'changed-on-disk');
      continue;
    }
    if (!entry.available) {
      skipWith(entry.relPath, 'unavailable');
      continue;
    }
    const reason = await restoreOne(host, plan.checkpointId, entry);
    if (reason === null) restored.push(entry.relPath);
    else skipWith(entry.relPath, reason);
  }

  // 4. Files added since the checkpoint, only after the user's confirmation, and only as they were confirmed.
  if (choices.trashAdded) {
    for (const added of plan.added) {
      if (skip.has(added.relPath)) continue;
      const entry = now.get(added.relPath);
      if (!entry || entry.status !== 'added' || entry.currentHash !== expected.get(added.relPath)) {
        skipWith(added.relPath, 'changed-on-disk');
        continue;
      }
      const reason = await trashOne(host, added.relPath);
      if (reason === null) trashed.push(added.relPath);
      else skipWith(added.relPath, reason);
    }
  }
  return { restored, trashed, skipped, safetyId: safety.value.checkpoint.id };
}

async function restoreOne(
  host: CheckpointRestoreHost,
  id: string,
  entry: CheckpointCompareEntry,
): Promise<SkipReason | null> {
  try {
    const tab = host.openTab(entry.relPath);
    if (tab) {
      if (tab.blocked) return 'open-blocked';
      if (tab.dirty) return 'unsaved-kept'; // typed after the choice was made: never replaced
      if (!tab.readOnly) {
        const text = await host.checkpoints.readText({ projectId: host.projectId, id, relPath: entry.relPath });
        // Only plain LF text without a BOM goes through the tab: the editor would change a BOM or CRLF line endings
        // on save. Anything else is written byte for byte by main, and the clean tab follows the disk (S11).
        if (text.ok && !text.value.bom && !tab.bom && !text.value.text.includes('\r')) {
          const problem = await host.replaceOpenText(entry.relPath, tab.text, text.value.text);
          if (problem === null) return null;
          return problem.code === 'changed-since' ? 'changed-on-disk' : 'save-failed';
        }
        if (!text.ok && (text.code === 'corrupt' || text.code === 'missing')) return 'unavailable';
        if (!text.ok && text.code !== 'not-text') return 'write-failed';
        // Not plain text: written as bytes like a closed file (the clean tab reloads from disk).
      }
    }
    const written = await host.checkpoints.restoreFile({
      projectId: host.projectId,
      id,
      relPath: entry.relPath,
      expectedHash: entry.currentHash,
    });
    if (written.ok) return null;
    if (written.code === 'changed-on-disk') return 'changed-on-disk';
    if (written.code === 'corrupt' || written.code === 'missing') return 'unavailable';
    return 'write-failed';
  } catch {
    return 'write-failed';
  }
}

async function trashOne(host: CheckpointRestoreHost, relPath: string): Promise<SkipReason | null> {
  if (!(await host.fileOps.beforeChange(relPath))) return 'save-failed';
  try {
    const result = await host.workspace.trashEntry({ projectId: host.projectId, relPath });
    if (!result.ok) {
      host.fileOps.cancelled?.(relPath);
      return 'trash-failed';
    }
  } catch {
    host.fileOps.cancelled?.(relPath);
    return 'trash-failed';
  }
  host.fileOps.afterChange({ type: 'deleted', relPath });
  return null;
}
