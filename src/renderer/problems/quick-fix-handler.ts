import type { ProblemRecord } from '../../shared/problem';
import type { FixAction } from './fix-model';

/**
 * S55.3: where a quick fix chosen in the editor's lightbulb goes — the workbench's problem fix (useProblemFix), so the
 * lightbulb and the problem card apply a fix the same way (one editor edit, the file's save pipeline, a re-check, the
 * result announced on the fix card). Null while no project is open.
 */
export type QuickFixHandler = (record: ProblemRecord, action: FixAction, origin: 'card' | 'lightbulb') => void;

let handler: QuickFixHandler | null = null;

export function setQuickFixHandler(next: QuickFixHandler | null): void {
  handler = next;
}

export const getQuickFixHandler = (): QuickFixHandler | null => handler;
