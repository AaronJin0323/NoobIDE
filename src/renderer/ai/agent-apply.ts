import type { AiFileChange } from '../../shared/ipc/ai-contract';
import type { NoobideApi } from '../../shared/ipc/contract';
import type {
  HistoryApi,
  HistoryGroup,
  HistoryGroupRef,
  HistoryGroupStep,
  HistoryGroupStepKind,
} from '../../shared/ipc/history-contract';
import type { RestoreOutcome } from '../history/history-model';
import type { FileOpsHooks } from '../workbench/FilesPanel';

/**
 * Applies the agent's accepted file changes through the workbench's existing paths, and undoes one agent turn as a
 * group from local history (S34.2, decision 0025). User data is sacred:
 *
 * - An open file changes only through its tab: its unsaved edits are saved first, then the new text becomes the
 *   editor content as one undoable edit (journaled like typing) and is saved by the tab's own save pipeline (atomic
 *   write, local-history snapshot).
 * - A closed file is written with `workspace.writeFile` and the hash of the version the agent read, so a file that
 *   changed on disk in the meantime is never overwritten.
 * - Before every change the current text must still be the text the agent based it on (an open tab's unsaved edits
 *   included); otherwise nothing is changed and the failure is reported.
 * - New files never replace anything; renames and deletions use the same hooks as the Files panel (unsaved edits are
 *   saved first, open tabs follow); deletions go to the OS trash with a local-history snapshot first.
 *
 * Every applied change is recorded in local history (app data) as a step of the turn's group: `groupBefore` keeps the
 * file's content right before the change, `groupRecord` what the change left. So a turn can still be undone after a
 * reload or a crash, from the chat or from the History window. Undoing reverses the steps newest first, each only if
 * the file is still exactly what the agent left: edited files get their earlier version back through the History
 * window's restore path (the current content is kept as a version first, so the undo itself can be undone), created
 * files go to the trash, renames are reversed, and deleted files come back from local history. A step that cannot be
 * undone is skipped and reported.
 */
export interface AgentApplyHost {
  readonly projectId: string;
  readonly workspace: Pick<
    NoobideApi['workspace'],
    'readFile' | 'writeFile' | 'createEntry' | 'renameEntry' | 'trashEntry'
  >;
  readonly history: Pick<
    HistoryApi,
    'read' | 'restoreDeleted' | 'groupBefore' | 'groupRecord' | 'groups' | 'groupUndone'
  >;
  readonly fileOps: FileOpsHooks;
  /**
   * The open tab's live text (unsaved edits included), or undefined when the file is not open. `blocked`: the tab is
   * in a conflict with the disk or its file was deleted — the user resolves that first. `dirty`: it has unsaved edits.
   */
  openTab(
    relPath: string,
  ):
    | { readonly text: string; readonly readOnly: boolean; readonly blocked?: boolean; readonly dirty?: boolean }
    | undefined;
  /** Saves the open tab's unsaved edits through its saver. False when that failed (the tab explains why). */
  saveOpen(relPath: string): Promise<boolean>;
  /**
   * Makes `text` the open tab's content (one undo step) and saves it through the tab's saver, if the tab still holds
   * `before` at that moment (checked again after every wait). Null = saved.
   */
  replaceOpenText(relPath: string, before: string, text: string): Promise<ApplyFailure | null>;
  /**
   * The History window's restore path for an existing file: opens it, keeps what is on disk as a version
   * (`before-restore`), then makes `text` the tab's content (one undo step) and saves it — only while the file's
   * text is still `expect` (`changed` otherwise, and nothing is touched).
   */
  restoreText(relPath: string, text: string, expect: string): Promise<RestoreOutcome>;
  /** Shows a file in a tab (a created or restored file). */
  openFile(relPath: string): void;
}

export type ApplyFailureCode =
  /** The file is no longer the text the agent saw or left (edited, or changed on disk). */
  | 'changed-since'
  | 'read-only'
  | 'exists'
  | 'not-found'
  /** The tab's save failed: the new text stays in the editor as unsaved edits, the banner explains. */
  | 'save-failed'
  | 'write-failed'
  /** The open file's edits could not be saved first, so the change did not start. */
  | 'save-first-failed'
  | 'no-history';

export interface ApplyFailure {
  readonly code: ApplyFailureCode;
  /** Machine code from main (e.g. 'permission-denied'), never file contents. */
  readonly detail?: string;
}

export type ApplyResult = { readonly ok: true } | { readonly ok: false; readonly failure: ApplyFailure };

/** Same text apart from line endings (the editor may hold CRLF text as LF). */
export const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
const failed = (code: ApplyFailureCode, detail?: string): ApplyResult => ({
  ok: false,
  failure: detail === undefined ? { code } : { code, detail },
});
const APPLIED: ApplyResult = { ok: true };

/**
 * Applies one accepted change; when it landed, it is recorded as a step of the turn's history group. A change whose
 * record fails stays applied (local history is a safety net; the save itself succeeded).
 */
export async function applyChange(
  host: AgentApplyHost,
  change: AiFileChange,
  group: HistoryGroupRef,
): Promise<ApplyResult> {
  try {
    switch (change.kind) {
      case 'edit':
        return await applyEdit(host, change.relPath, change.before, change.after, group);
      case 'create': {
        const result = await applyCreate(host, change.relPath, change.after);
        if (result.ok) await record(host, group, { kind: 'create', relPath: change.relPath, before: null });
        return result;
      }
      case 'rename': {
        const result = await applyRename(host, change.relPath, change.to);
        if (result.ok) {
          await record(host, group, { kind: 'rename', relPath: change.relPath, to: change.to, before: null });
        }
        return result;
      }
      case 'delete':
        return await applyDelete(host, change.relPath, group);
    }
  } catch {
    return failed('write-failed');
  }
}

interface Kept {
  /** Version id of the content before the change, or null when none could be kept. */
  readonly id: string | null;
  /** The path to record the step under: the history key main kept it under (real case), else as given. */
  readonly relPath: string;
}

/** Keeps the file's current content as the group's "before" version. */
async function keepBefore(host: AgentApplyHost, group: HistoryGroupRef, relPath: string): Promise<Kept> {
  try {
    const kept = await host.history.groupBefore({ projectId: host.projectId, groupId: group.id, relPath });
    if (kept.ok && kept.value.id !== null) return { id: kept.value.id, relPath: kept.value.relPath ?? relPath };
  } catch {
    // recorded without a "before" version: undo reports it
  }
  return { id: null, relPath };
}

async function record(
  host: AgentApplyHost,
  group: HistoryGroupRef,
  step: { kind: HistoryGroupStepKind; relPath: string; to?: string; before: string | null },
): Promise<void> {
  try {
    await host.history.groupRecord({ projectId: host.projectId, group, step });
  } catch {
    // The change is applied; only its history record is missing (undo then reports it).
  }
}

async function applyEdit(
  host: AgentApplyHost,
  relPath: string,
  before: string,
  after: string,
  group: HistoryGroupRef,
): Promise<ApplyResult> {
  const open = host.openTab(relPath);
  if (open) {
    if (open.readOnly) return failed('read-only');
    if (open.blocked || !sameText(open.text, before)) return failed('changed-since');
    // Unsaved edits the agent based its change on are saved first, so the "before" version kept in history is the
    // text the change replaces (and those edits are a version of their own).
    if (open.dirty && !(await host.saveOpen(relPath))) return failed('save-first-failed');
    const kept = await keepBefore(host, group, relPath);
    // A failed save leaves the new text in the editor as unsaved edits (Ctrl+Z there brings the old text back);
    // nothing reached the disk, so nothing is recorded.
    const problem = await host.replaceOpenText(relPath, before, after);
    if (problem) return { ok: false, failure: problem };
    await record(host, group, { kind: 'edit', relPath: kept.relPath, before: kept.id });
    return APPLIED;
  }
  const current = await host.workspace.readFile({ projectId: host.projectId, relPath });
  if (!current.ok) return failed(current.code === 'not-found' ? 'not-found' : 'write-failed', current.code);
  if (current.value.readOnly) return failed('read-only');
  if (!sameText(current.value.text, before)) return failed('changed-since');
  const kept = await keepBefore(host, group, relPath);
  const written = await host.workspace.writeFile({
    projectId: host.projectId,
    relPath,
    text: after,
    bom: current.value.bom,
    expectedHash: current.value.version.hash, // main refuses if the file changed after this read
  });
  if (!written.ok) return failed(written.code === 'changed-on-disk' ? 'changed-since' : 'write-failed', written.code);
  await record(host, group, { kind: 'edit', relPath: kept.relPath, before: kept.id });
  return APPLIED;
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
  return APPLIED;
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
  return APPLIED;
}

/** Trashes a file (the Files panel's path). With a group, its content is kept as the group's "before" version. */
async function applyDelete(
  host: AgentApplyHost,
  relPath: string,
  group?: HistoryGroupRef,
  /** Runs after unsaved edits were saved, right before the trash: a failure cancels the deletion. */
  recheck?: () => Promise<ApplyFailure | null>,
): Promise<ApplyResult> {
  if (!(await host.fileOps.beforeChange(relPath))) return failed('save-first-failed');
  const problem = recheck ? await recheck().catch((): ApplyFailure => ({ code: 'write-failed' })) : null;
  if (problem) {
    host.fileOps.cancelled?.(relPath);
    return { ok: false, failure: problem };
  }
  const kept = group ? await keepBefore(host, group, relPath) : null;
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
  if (group && kept) await record(host, group, { kind: 'delete', relPath: kept.relPath, before: kept.id });
  return APPLIED;
}

/**
 * The file's text when it is still exactly what the agent's step left — on disk with `afterHash`, and an open tab
 * showing that same text (no edits since) — else why not.
 */
async function asLeft(
  host: AgentApplyHost,
  relPath: string,
  afterHash: string | null,
  /** The file-op lock this undo itself just took (the tab is read-only during the trash) does not count. */
  ownLock = false,
): Promise<{ readonly text: string } | ApplyFailure> {
  if (afterHash === null) return { code: 'no-history' };
  const disk = await host.workspace.readFile({ projectId: host.projectId, relPath });
  if (!disk.ok) return disk.code === 'not-found' ? { code: 'not-found' } : { code: 'write-failed', detail: disk.code };
  if (disk.value.version.hash !== afterHash) return { code: 'changed-since' };
  const open = host.openTab(relPath);
  if (open && ((open.blocked && !ownLock) || !sameText(open.text, disk.value.text))) return { code: 'changed-since' };
  return { text: disk.value.text };
}

const isFailure = (value: { readonly text: string } | ApplyFailure): value is ApplyFailure => 'code' in value;

function restoreFailure(outcome: RestoreOutcome): ApplyFailure | null {
  switch (outcome) {
    case 'restored':
      return null;
    case 'changed':
      return { code: 'changed-since' };
    case 'read-only':
      return { code: 'read-only' };
    case 'save-failed':
      return { code: 'save-failed' };
    default:
      return { code: 'write-failed' };
  }
}

/** Reverses one recorded step. Null when it was undone. */
export async function undoStep(host: AgentApplyHost, step: HistoryGroupStep): Promise<ApplyFailure | null> {
  try {
    switch (step.kind) {
      case 'edit': {
        if (step.before === null) return { code: 'no-history' };
        const left = await asLeft(host, step.relPath, step.afterHash);
        if (isFailure(left)) return left;
        const version = await host.history.read({ projectId: host.projectId, relPath: step.relPath, id: step.before });
        if (!version.ok) return { code: 'no-history', detail: version.code };
        return restoreFailure(await host.restoreText(step.relPath, version.value.text, left.text));
      }
      case 'create': {
        const left = await asLeft(host, step.relPath, step.afterHash);
        if (isFailure(left)) return left;
        // To the trash (with a local-history copy first), never deleted for good — and checked again after the
        // open tab's edits were saved, so nothing typed meanwhile goes to the trash.
        const result = await applyDelete(host, step.relPath, undefined, async () => {
          const again = await asLeft(host, step.relPath, step.afterHash, true);
          return isFailure(again) ? again : null;
        });
        return result.ok ? null : result.failure;
      }
      case 'rename': {
        if (step.to === undefined) return { code: 'no-history' };
        // renameEntry never replaces: if something has the old name again, nothing happens and it is reported.
        const result = await applyRename(host, step.to, step.relPath);
        return result.ok ? null : result.failure;
      }
      case 'delete': {
        if (step.before === null) return { code: 'no-history' };
        const restored = await host.history.restoreDeleted({
          projectId: host.projectId,
          relPath: step.relPath,
          id: step.before,
        });
        if (!restored.ok) {
          const code: ApplyFailureCode =
            restored.code === 'exists' ? 'exists' : restored.code === 'not-found' ? 'no-history' : 'write-failed';
          return { code, detail: restored.code };
        }
        host.openFile(restored.value.relPath);
        return null;
      }
    }
  } catch {
    return { code: 'write-failed' };
  }
}

export interface UndoTurnResult {
  readonly undone: number;
  /** `step` is null when the turn itself was not found in local history. */
  readonly failures: readonly { readonly step: HistoryGroupStep | null; readonly failure: ApplyFailure }[];
}

/**
 * Undoes a turn's recorded steps, newest first; a step that cannot be undone is skipped and reported. Only when
 * every step was undone does local history mark the group as undone; after a partial undo it can be run again (the
 * steps already undone are then skipped, as their files are no longer what the turn left).
 */
export async function undoGroup(host: AgentApplyHost, group: HistoryGroup): Promise<UndoTurnResult> {
  let undone = 0;
  const failures: { step: HistoryGroupStep; failure: ApplyFailure }[] = [];
  for (const step of [...group.steps].reverse()) {
    const failure = await undoStep(host, step);
    if (failure) failures.push({ step, failure });
    else undone += 1;
  }
  if (undone > 0 && failures.length === 0) {
    await host.history.groupUndone({ projectId: host.projectId, groupId: group.id }).catch(() => undefined);
  }
  return { undone, failures };
}

/** Finds a turn's group in local history and undoes it; a turn that is not there is reported as `no-history`. */
export async function undoGroupById(host: AgentApplyHost, groupId: string): Promise<UndoTurnResult> {
  let detail: string | undefined;
  try {
    const groups = await host.history.groups({ projectId: host.projectId });
    const group = groups.ok ? groups.value.find((g) => g.id === groupId) : undefined;
    if (group) return await undoGroup(host, group);
    detail = groups.ok ? undefined : groups.code;
  } catch {
    detail = undefined;
  }
  return {
    undone: 0,
    failures: [{ step: null, failure: detail === undefined ? { code: 'no-history' } : { code: 'no-history', detail } }],
  };
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
