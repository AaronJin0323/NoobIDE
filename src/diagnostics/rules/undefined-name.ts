/**
 * Rule 1 — misspelled or undefined variable, with did-you-mean (S22.2) and the data the one-click fix needs (S22.5).
 *
 * Applies to:
 * - runtime/console: Chromium "ReferenceError: userNmae is not defined"
 * - static: TypeScript/Monaco 2304 "Cannot find name 'userNmae'." and 2552 "… Did you mean 'userName'?"
 *
 * Candidates come from `ctx.declaredNames` (names in scope, from the language service); for 2552 the language
 * service's own suggestion is used when no names were supplied. A `replace-text` fix is returned only when there is
 * exactly one candidate AND the misspelled name was located exactly on the reported line (`ctx.lineText`).
 */
import type { LineSpan, ProblemAction } from '../../shared/problem';
import { msg } from '../messages';
import { IDENTIFIER, joinNames, locateIdentifier, similarNames } from '../text';
import type { DeclaredName, Rule } from './types';

export const UNDEFINED_NAME_RULE_ID = 'undefined-name';

const RUNTIME = new RegExp(`(?:^|[\\s:])(${IDENTIFIER}) is not defined\\b`, 'u');
const STATIC = /Cannot find name '([^']+)'\.(?: Did you mean '([^']+)'\?)?/;

/** The undefined name a record reports (and the language service's own suggestion), or null for other problems. */
export function undefinedName(record: Parameters<Rule['explain']>[0]): { name: string; suggestion?: string } | null {
  if (record.source === 'static') {
    if (record.code !== '2304' && record.code !== '2552') return null;
    const m = STATIC.exec(record.originalMessage);
    if (!m?.[1]) return null;
    return m[2] ? { name: m[1], suggestion: m[2] } : { name: m[1] };
  }
  if (record.source !== 'runtime' && record.source !== 'console') return null;
  if (record.code !== 'ReferenceError' && !record.originalMessage.includes('ReferenceError')) return null;
  const m = RUNTIME.exec(record.originalMessage);
  return m?.[1] ? { name: m[1] } : null;
}

export const undefinedNameRule: Rule = {
  id: UNDEFINED_NAME_RULE_ID,
  explain(record, ctx) {
    const found = undefinedName(record);
    if (!found) return null;
    const { name } = found;

    const declared: DeclaredName[] = ctx.declaredNames
      ? [...ctx.declaredNames]
      : found.suggestion
        ? [{ name: found.suggestion }]
        : [];
    const candidates = similarNames(
      name,
      declared.map((d) => d.name),
    );

    let span: LineSpan | undefined;
    if (record.file && record.line && ctx.lineText !== undefined) {
      const col = locateIdentifier(ctx.lineText, name, record.column);
      if (col !== undefined) span = { file: record.file, line: record.line, column: col, endColumn: col + name.length };
    }

    const checks = [];
    const actions: ProblemAction[] = [];
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) {
      const decl = declared.find((d) => d.name === only);
      const sameFile = decl?.file === undefined || decl.file === record.file;
      checks.push(
        decl?.line !== undefined && sameFile
          ? msg('undefinedName.check.matchWithLine', { candidate: only, line: decl.line })
          : msg('undefinedName.check.match', { candidate: only }),
      );
      if (only.toLowerCase() === name.toLowerCase())
        checks.push(msg('undefinedName.check.caseOnly', { name, candidate: only }));
      if (span) {
        actions.push({
          kind: 'replace-text',
          label: msg('action.replaceWith', { name: only }),
          span,
          from: name,
          to: only,
        });
      }
    } else if (candidates.length > 1) {
      checks.push(msg('undefinedName.check.matchSeveral', { candidates: joinNames(candidates) }));
    } else {
      checks.push(msg('undefinedName.check.spelling'));
    }
    checks.push(msg('undefinedName.check.declare'));
    if (candidates.length === 0) checks.push(msg('undefinedName.check.otherFile'));

    return {
      certainty: candidates.length === 1 ? 'likely' : 'possible',
      title: msg('undefinedName.title', { name }),
      explanation: msg('undefinedName.explanation'),
      checks,
      actions,
      candidates,
      ...(span ? { span } : {}),
    };
  },
};
