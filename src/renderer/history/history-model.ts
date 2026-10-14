import type { HistoryError, HistoryOverview, HistoryReason } from '../../shared/ipc/history-contract';
import type { RequestError } from '../../shared/ipc/contract';
import type { MessageKey } from '../i18n/index';
import { fill, formatBytes } from '../recovery/format';
import { diffLines, type LineDiff } from '../recovery/line-diff';

/**
 * Pure view logic of the local-history window (S21.3, S21.4). What is compared with what, which message explains a
 * refusal, how storage is described. The window itself is HistoryDialog.tsx.
 */
type Translate = (key: MessageKey) => string;

export function reasonKey(reason: HistoryReason): MessageKey {
  return `history.reason.${reason}` as MessageKey;
}

/**
 * What the compare pane shows for a version: for a file that exists, a line diff from the current content (the
 * editor's text when the file is open, else the disk) to the version — `+` lines come back, `−` lines would be
 * replaced. A deleted file has nothing to compare with: the version's whole text is shown.
 */
export type VersionComparison =
  { readonly mode: 'diff'; readonly diff: LineDiff } | { readonly mode: 'deleted'; readonly text: string };

export function compareVersion(current: string | null, version: string): VersionComparison {
  return current === null ? { mode: 'deleted', text: version } : { mode: 'diff', diff: diffLines(current, version) };
}

/** How a restore went, as the workbench reports it. */
export type RestoreOutcome = 'restored' | 'save-failed' | 'read-only' | 'failed';

export function restoreOutcomeKey(outcome: RestoreOutcome): MessageKey {
  switch (outcome) {
    case 'restored':
      return 'history.restored';
    case 'save-failed':
      return 'history.error.saveFirst';
    case 'read-only':
      return 'history.error.readOnly';
    default:
      return 'history.error.generic';
  }
}

export function historyErrorKey(code: HistoryError | RequestError): MessageKey {
  switch (code) {
    case 'unavailable':
      return 'history.error.unavailable';
    case 'not-text':
      return 'history.error.notText';
    case 'corrupt':
      return 'history.error.corrupt';
    case 'not-found':
      return 'history.error.notFound';
    case 'exists':
      return 'history.error.exists';
    case 'clear-failed':
      return 'history.clearFailed';
    default:
      return 'history.error.generic';
  }
}

/** The storage lines of S21.4: usage against the limit and the cleanup policy, in words. */
export function storageText(t: Translate, usage: HistoryOverview['usage']): { usage: string; policy: string } {
  return {
    usage: fill(t('history.usage'), { used: formatBytes(usage.totalBytes), limit: formatBytes(usage.maxTotalBytes) }),
    policy: fill(t('history.policy'), {
      versions: String(usage.maxVersionsPerFile),
      perFile: formatBytes(usage.maxBytesPerFile),
    }),
  };
}

/** Deleted files after the existing ones, each group by path. */
export function sortHistoryFiles<T extends { relPath: string; exists: boolean }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) =>
    a.exists === b.exists ? (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0) : a.exists ? -1 : 1,
  );
}
