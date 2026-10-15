import type { AiFileChange } from '../../shared/ipc/ai-contract';
import type { NoobideApi } from '../../shared/ipc/contract';
import type { HistoryApi } from '../../shared/ipc/history-contract';
import type { FileOpsHooks } from '../workbench/FilesPanel';

/**
 * Applies the agent's accepted file changes through the workbench's existing paths, and undoes one agent turn as a
 * group (S34.2, decision 0025). User data is sacred:
 *
 * - An open file changes only through its tab: the new text becomes the editor content as one undoable edit
 *   (journaled like typing) and is saved by the tab's own save pipeline (atomic write, local-history snapshot).
 * - A closed file is written with `workspace.writeFile` and the hash of the version the agent read, so a file that
 *   changed on disk in the meantime is never overwritten.
 * - Before every change the current text must still be the text the agent based it on (an open tab's unsaved edits
 *   included); otherwise nothing is changed and the failure is reported.
 * - New files never replace anything; renames and deletions use the same hooks as the Files panel (unsaved edits are
 *   saved first, open tabs follow); deletions go to the OS trash with a local-history snapshot first.
 *
 * Undoing a turn reverses its applied changes newest first, each only if the file is still exactly what the agent
 * left: edited files get their earlier text back (saved again, so local history keeps every version), created files
 * go to the trash, renames are reversed, and deleted files come back from local history.
 */
export interface AgentApplyHost {
  readonly projectId: string;
  readonly workspace: Pick<
    NoobideApi['workspace'],
    'readFile' | 'writeFile' | 'createEntry' | 'renameEntry' | 'trashEntry'
  >;
  readonly history: Pick<HistoryApi, 'versions' | 'restoreDeleted'>;
  readonly fileOps: FileOpsHooks;
  /**
   * The open tab's live text (unsaved edits included), or undefined when the file is not open. `blocked`: the tab is
   * in a conflict with the disk or its file was deleted — the user resolves that first.
   */
  openTab(
    relPath: string,
  ): { readonly text: string; readonly readOnly: boolean; readonly blocked?: boolean } | undefined;
  /** Makes `text` the open tab's content (one undo step) and saves it through the tab's saver. Null = saved. */
  replaceOpenText(relPath: string, text: string): Promise<ApplyFailure | null>;
  /** Shows a file in a tab (a created or restored file). */
  openFile(relPath: string): void;
}

export type ApplyFailureCode =
  /** The file is no longer the text the agent saw (edited, or changed on disk). */
  | 'changed-since'
  | 'read-only'
  | 'exists'
  | 'not-found'
  /** The tab's save failed: the new text stays in the editor as unsaved edits, the banner explains. */
  | 'save-failed'
  | 'write-failed'
  /** The open file's edits could not be saved first, so the rename / deletion did not start. */
  | 'save-first-failed'
  | 'no-history';

export interface ApplyFailure {
  readonly code: ApplyFailureCode;
  /** Machine code from main (e.g. 'permission-denied'), never file contents. */
  readonly detail?: string;
}

export type UndoStep =
  | { readonly kind: 'edit'; readonly relPath: string; readonly before: string; readonly after: string }
  | { readonly kind: 'create'; readonly relPath: string; readonly after: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'delete'; readonly relPath: string };

export type ApplyResult =
  { readonly ok: true; readonly undo: UndoStep } | { readonly ok: false; readonly failure: ApplyFailure };

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
const failed = (code: ApplyFailureCode, detail?: string): ApplyResult => ({
  ok: false,
  failure: detail === undefined ? { code } : { code, detail },
});

export async function applyChange(host: AgentApplyHost, change: AiFileChange): Promise<ApplyResult> {
  try {
    switch (change.kind) {
      case 'edit':
        return await applyEdit(host, change.relPath, change.before, change.after);
      case 'create':
        return await applyCreate(host, change.relPath, change.after);
      case 'rename':
        return await applyRename(host, change.relPath, change.to);
      case 'delete':
        return await applyDelete(host, change.relPath);
    }
  } catch {
    return failed('write-failed');
  }
}

async function applyEdit(host: AgentApplyHost, relPath: string, before: string, after: string): Promise<ApplyResult> {
  const open = host.openTab(relPath);
  if (open) {
    if (open.readOnly) return failed('read-only');
    if (open.blocked || !sameText(open.text, before)) return failed('changed-since');
    const problem = await host.replaceOpenText(relPath, after);
    return problem ? { ok: false, failure: problem } : { ok: true, undo: { kind: 'edit', relPath, before, after } };
  }
  const current = await host.workspace.readFile({ projectId: host.projectId, relPath });
  if (!current.ok) return failed(current.code === 'not-found' ? 'not-found' : 'write-failed', current.code);
  if (current.value.readOnly) return failed('read-only');
  if (!sameText(current.value.text, before)) return failed('changed-since');
  const written = await host.workspace.writeFile({
    projectId: host.projectId,
    relPath,
    text: after,
    bom: current.value.bom,
    expectedHash: current.value.version.hash, // main refuses if the file changed after this read
  });
  if (!written.ok) return failed(written.code === 'changed-on-disk' ? 'changed-since' : 'write-failed', written.code);
  return { ok: true, undo: { kind: 'edit', relPath, before, after } };
}

async function applyCreate(host: AgentApplyHost, relPath: string, after: string): Promise<ApplyResult> {
  const segments = relPath.split('/');
  // Missing folders first (an existing folder is fine; nothing is ever replaced).
  for (let i = 1; i < segments.length; i += 1) {
    const folder = segments.slice(0, i).join('/');
    const made = await host.workspace.createEntry({ projectId: host.projectId, relPath: folder, kind: 'directory' });
    if (!made.ok && made.code !== 'exists') return failed('write-failed', made.code);
  }
  // `create` reserves the name exclusively (never over an existing file), then writes atomically.
  const written = await host.workspace.writeFile({
    projectId: host.projectId,
    relPath,
    text: after,
    bom: false,
    create: true,
  });
  if (!written.ok) return failed(written.code === 'changed-on-disk' ? 'exists' : 'write-failed', written.code);
  host.openFile(relPath);
  return { ok: true, undo: { kind: 'create', relPath, after } };
}

async function applyRename(host: AgentApplyHost, from: string, to: string): Promise<ApplyResult> {
  if (!(await host.fileOps.beforeChange(from))) return failed('save-first-failed');
  try {
    const result = await host.workspace.renameEntry({ projectId: host.projectId, from, to });
    if (!result.ok) {
      host.fileOps.cancelled?.(from);
      return failed(
        result.code === 'exists' ? 'exists' : result.code === 'not-found' ? 'not-found' : 'write-failed',
        result.code,
      );
    }
  } catch {
    host.fileOps.cancelled?.(from);
    return failed('write-failed');
  }
  host.fileOps.afterChange({ type: 'renamed', from, to });
  return { ok: true, undo: { kind: 'rename', from, to } };
}

async function applyDelete(host: AgentApplyHost, relPath: string): Promise<ApplyResult> {
  if (!(await host.fileOps.beforeChange(relPath))) return failed('save-first-failed');
  try {
    const result = await host.workspace.trashEntry({ projectId: host.projectId, relPath });
    if (!result.ok) {
      host.fileOps.cancelled?.(relPath);
      return failed(result.code === 'not-found' ? 'not-found' : 'write-failed', result.code);
    }
  } catch {
    host.fileOps.cancelled?.(relPath);
    return failed('write-failed');
  }
  host.fileOps.afterChange({ type: 'deleted', relPath });
  return { ok: true, undo: { kind: 'delete', relPath } };
}

/** The current text of a file (the open tab's, else the disk's), or null when it cannot be read. */
async function currentText(host: AgentApplyHost, relPath: string): Promise<string | null> {
  const open = host.openTab(relPath);
  if (open) return open.text;
  const read = await host.workspace.readFile({ projectId: host.projectId, relPath });
  return read.ok ? read.value.text : null;
}

/** Reverses one applied step. Null when it was undone. */
export async function undoStep(host: AgentApplyHost, step: UndoStep): Promise<ApplyFailure | null> {
  try {
    switch (step.kind) {
      case 'edit': {
        const result = await applyEdit(host, step.relPath, step.after, step.before);
        return result.ok ? null : result.failure;
      }
      case 'create': {
        const text = await currentText(host, step.relPath);
        if (text === null) return { code: 'not-found' };
        if (!sameText(text, step.after)) return { code: 'changed-since' };
        const result = await applyDelete(host, step.relPath);
        return result.ok ? null : result.failure;
      }
      case 'rename': {
        const result = await applyRename(host, step.to, step.from);
        return result.ok ? null : result.failure;
      }
      case 'delete': {
        const versions = await host.history.versions({ projectId: host.projectId, relPath: step.relPath });
        const kept = versions.ok ? versions.value.find((v) => v.reason === 'before-delete') : undefined;
        if (!kept) return { code: 'no-history', ...(versions.ok ? {} : { detail: versions.code }) };
        const restored = await host.history.restoreDeleted({
          projectId: host.projectId,
          relPath: step.relPath,
          id: kept.id,
        });
        if (!restored.ok)
          return { code: restored.code === 'exists' ? 'exists' : 'write-failed', detail: restored.code };
        host.openFile(step.relPath);
        return null;
      }
    }
  } catch {
    return { code: 'write-failed' };
  }
}

export interface UndoTurnResult {
  readonly undone: number;
  readonly failures: readonly { readonly step: UndoStep; readonly failure: ApplyFailure }[];
}

/** Undoes a turn's applied steps, newest first; a step that cannot be undone is skipped and reported. */
export async function undoTurn(host: AgentApplyHost, steps: readonly UndoStep[]): Promise<UndoTurnResult> {
  let undone = 0;
  const failures: { step: UndoStep; failure: ApplyFailure }[] = [];
  for (const step of [...steps].reverse()) {
    const failure = await undoStep(host, step);
    if (failure) failures.push({ step, failure });
    else undone += 1;
  }
  return { undone, failures };
}

/** The outcome text the agent receives for a failed apply (English, machine-oriented; no file contents). */
export function failureForAgent(failure: ApplyFailure): string {
  const detail = failure.detail ? ` (${failure.detail})` : '';
  switch (failure.code) {
    case 'changed-since':
      return `The file changed since you read it (the user edited it or it changed on disk); read it again.${detail}`;
    case 'read-only':
      return 'The file is open read-only (not UTF-8 text).';
    case 'exists':
      return `Something with that name already exists.${detail}`;
    case 'not-found':
      return `The file or folder no longer exists.${detail}`;
    case 'save-failed':
      return 'Saving failed; the new text is in the editor as unsaved changes and the editor explains why.';
    case 'save-first-failed':
      return 'The file has unsaved changes that could not be saved first, so nothing was changed.';
    case 'no-history':
      return 'No local-history copy was found.';
    default:
      return `Writing failed.${detail}`;
  }
}
