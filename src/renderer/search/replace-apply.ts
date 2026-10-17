/**
 * Replace in files (S51.4): applies a reviewed replace plan file by file, never bypassing the save pipeline. Each file
 * is opened as an editor tab (host.prepare), checked against the text the search saw (textFingerprint: a file that
 * changed since — on disk or in its editor — is refused, never edited at stale positions), changed as ONE undoable
 * edit of its editor model and saved through its own DocumentSaver (host.commit: atomic write, version check, local
 * history, recovery journal). A file that fails keeps going for the others; it keeps its edited text in the editor
 * with the save-failure state, and the summary names it.
 *
 * Monaco-free: the host is injected (the workbench in the app, ProjectService + DocumentSaver in the tests).
 */
import type { SearchResults } from '../../shared/ipc/search-contract';
import { matchKey, replaceInText, textFingerprint, type SearchQuery } from '../../shared/search';

export interface ReplacePlanFile {
  readonly relPath: string;
  /** textFingerprint of the text the search matched in. */
  readonly fingerprint: string;
  /** matchKey of every match to replace (the user may have excluded others). */
  readonly keys: ReadonlySet<string>;
}

export interface ReplacePlan {
  /** The project the search ran in: a host refuses every file once another project is open. */
  readonly projectId: string;
  /** The query the results were found with (not the field's current text). */
  readonly query: SearchQuery;
  readonly replacement: string;
  readonly files: readonly ReplacePlanFile[];
}

/** Why a file was not changed (or its change not saved). Explained per file in the summary. */
export type ReplaceFailure =
  /** The file's text is not what the search saw: it changed on disk or in the editor since. */
  | 'changed-since-search'
  /** Shown read-only (another encoding): the editor cannot change it. */
  | 'read-only'
  /** Being renamed, moved or trashed, deleted on disk, or in a conflict with its disk version. */
  | 'blocked'
  /** The file could not be opened. */
  | 'open-failed'
  /** Another project was opened before this file's turn: nothing of the old plan touches it. */
  | 'project-changed'
  /** The editor could not take the change; the file is unchanged. */
  | 'editor-failed'
  /** The change is in the editor (undoable), but saving it failed: the tab says why and keeps the text. */
  | 'save-failed';

export interface ReplaceSummary {
  readonly applied: readonly { readonly relPath: string; readonly replaced: number }[];
  readonly failed: readonly { readonly relPath: string; readonly reason: ReplaceFailure; readonly detail?: string }[];
}

export interface ReplaceHost {
  /** Opens (or shows) the file's editor tab and returns its current text, or why it cannot be edited. */
  prepare(relPath: string, projectId: string): Promise<{ readonly text: string } | { readonly error: ReplaceFailure }>;
  /**
   * Replaces the file's editor text `before` with `after` as one undo step and saves it through its save pipeline.
   * `changed-since` when the text moved on between prepare and commit (typing, a disk reload); `blocked`,
   * `project-changed` and `editor-failed` as in ReplaceFailure; any other code is a failed save.
   */
  commit(
    relPath: string,
    before: string,
    after: string,
    projectId: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
  /**
   * Optional: holds the preview's automatic refresh while the files are written, so the page reloads once after the
   * last save instead of once per file. Returns the release function.
   */
  holdPreview?(): () => void;
}

/** The plan for the matches the user kept: every match of every file unless excluded. */
export function buildPlan(
  projectId: string,
  results: SearchResults,
  query: SearchQuery,
  replacement: string,
  excludedFiles: ReadonlySet<string>,
  excludedMatches: ReadonlySet<string>,
): ReplacePlan {
  const files: ReplacePlanFile[] = [];
  for (const file of results.files) {
    if (excludedFiles.has(file.relPath)) continue;
    const keys = new Set(
      file.matches
        .map((m) => matchKey(m.line, m.column))
        .filter((key) => !excludedMatches.has(hitId(file.relPath, key))),
    );
    if (keys.size > 0) files.push({ relPath: file.relPath, fingerprint: file.fingerprint, keys });
  }
  return { projectId, query, replacement, files };
}

/** The id of one match across files (exclusions are kept per match). */
export const hitId = (relPath: string, key: string) => `${relPath}\u0000${key}`;

export async function applyReplace(plan: ReplacePlan, host: ReplaceHost): Promise<ReplaceSummary> {
  const applied: { relPath: string; replaced: number }[] = [];
  const failed: { relPath: string; reason: ReplaceFailure; detail?: string }[] = [];
  const release = host.holdPreview?.();
  try {
    for (const file of plan.files) {
      const prepared = await host.prepare(file.relPath, plan.projectId);
      if ('error' in prepared) {
        failed.push({ relPath: file.relPath, reason: prepared.error });
        continue;
      }
      if (textFingerprint(prepared.text) !== file.fingerprint) {
        failed.push({ relPath: file.relPath, reason: 'changed-since-search' });
        continue;
      }
      const outcome = replaceInText(prepared.text, plan.query, plan.replacement, file.keys);
      // Every kept match must still be where the search saw it; otherwise nothing of this file is changed.
      if (outcome === null || outcome.replaced !== file.keys.size) {
        failed.push({ relPath: file.relPath, reason: 'changed-since-search' });
        continue;
      }
      if (outcome.text === prepared.text) continue; // replacing a text with itself
      const committed = await host.commit(file.relPath, prepared.text, outcome.text, plan.projectId);
      if (committed.ok) applied.push({ relPath: file.relPath, replaced: outcome.replaced });
      else failed.push(failureOf(file.relPath, committed.code));
    }
  } finally {
    release?.();
  }
  return { applied, failed };
}

const COMMIT_FAILURES: Readonly<Record<string, ReplaceFailure>> = {
  'changed-since': 'changed-since-search',
  blocked: 'blocked',
  'project-changed': 'project-changed',
  'editor-failed': 'editor-failed',
};

function failureOf(relPath: string, code: string): { relPath: string; reason: ReplaceFailure; detail?: string } {
  const reason = COMMIT_FAILURES[code];
  return reason ? { relPath, reason } : { relPath, reason: 'save-failed', detail: code };
}
