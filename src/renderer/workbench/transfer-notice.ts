import type { PortabilityIssue, PortabilityReport } from '../../shared/portability';
import { fill, nameProblemsText, type Translate } from './file-op-messages';

/**
 * S13.5: the text of the cross-platform transfer notice. Pure so every issue kind is tested to have a message; the
 * wording lives in the i18n dictionaries. Names are shown exactly as they are on disk.
 */
export const MAX_SHOWN_ISSUES = 8;

const quoteNames = (names: readonly string[]) => names.map((n) => `“${n}”`).join(', ');

export function transferIssueText(t: Translate, issue: PortabilityIssue): string {
  switch (issue.kind) {
    case 'case-conflict':
    case 'unicode-conflict':
      return fill(t(issue.kind === 'case-conflict' ? 'transfer.caseConflict' : 'transfer.unicodeConflict'), {
        folder: issue.folder === '' ? t('transfer.rootFolder') : issue.folder,
        names: quoteNames(issue.names),
      });
    case 'decomposed-name':
      return fill(t('transfer.decomposedName'), { path: issue.relPath });
    case 'unportable-name':
      return fill(t('transfer.unportableName'), {
        path: issue.relPath,
        reason: nameProblemsText(t, issue.problems, issue.invalidChars),
      });
    case 'mixed-eol':
      return fill(t('transfer.mixedEol'), { path: issue.relPath });
  }
}

export interface TransferNoticeView {
  readonly lines: readonly string[];
  /** Issues not listed (the notice stays short); `0` when all are shown. */
  readonly more: number;
  readonly truncated: boolean;
}

/** `null` when there is nothing to report (no notice at all). */
export function transferNoticeView(t: Translate, report: PortabilityReport): TransferNoticeView | null {
  if (report.issues.length === 0) return null;
  const shown = report.issues.slice(0, MAX_SHOWN_ISSUES);
  return {
    lines: shown.map((issue) => transferIssueText(t, issue)),
    more: report.issues.length - shown.length,
    truncated: report.truncated,
  };
}
