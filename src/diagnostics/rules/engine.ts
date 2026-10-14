/**
 * Explanation rules engine (S22.1, PLAN §9).
 *
 * `explainProblem(record, ctx, rules)` runs the rules in order; the first that applies explains the problem. When none
 * applies, an honest fallback ("cause not certain") points at the original error. The engine never changes the
 * record's original message or stack: `withExplanation` returns a copy with `explanation` attached beside them, and
 * every explanation carries a "Show original error" action.
 *
 * A rule that throws is skipped (a broken rule must not hide a problem).
 */
import type { ProblemAction, ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { formatMessage, msg, type DiagnosticsLocale, type DiagnosticsMessageKey } from '../messages';
import type { Rule, RuleContext, RuleOutput } from './types';

export const FALLBACK_RULE_ID = 'fallback';

function fallback(record: ProblemRecord): RuleOutput {
  const title: Record<ProblemRecord['source'], DiagnosticsMessageKey> = {
    static: 'fallback.title.static',
    runtime: 'fallback.title.runtime',
    resource: 'fallback.title.resource',
    console: 'fallback.title.console',
  };
  return {
    certainty: 'unknown',
    title: msg(title[record.source]),
    explanation: msg('fallback.explanation'),
    checks: [
      ...(record.file && record.line ? [msg('fallback.check.goToCode')] : []),
      msg('fallback.check.readOriginal'),
    ],
  };
}

function standardActions(record: ProblemRecord, out: RuleOutput): ProblemAction[] {
  const own = out.actions ?? [];
  const fixes = own.filter((a) => a.kind === 'replace-text');
  const others = own.filter((a) => a.kind !== 'replace-text' && a.kind !== 'show-original' && a.kind !== 'go-to-code');
  const goTo: ProblemAction[] =
    record.file && record.line
      ? [
          {
            kind: 'go-to-code',
            label: msg('action.goToCode'),
            file: record.file,
            line: record.line,
            ...(record.column ? { column: record.column } : {}),
          },
        ]
      : [];
  return [...fixes, ...goTo, ...others, { kind: 'show-original', label: msg('action.showOriginal') }];
}

export function explainProblem(
  record: ProblemRecord,
  ctx: RuleContext = {},
  rules: readonly Rule[] = [],
): ProblemExplanation {
  let ruleId = FALLBACK_RULE_ID;
  let out: RuleOutput | null = null;
  for (const rule of rules) {
    try {
      out = rule.explain(record, ctx);
    } catch {
      out = null;
    }
    if (out) {
      ruleId = rule.id;
      break;
    }
  }
  out ??= fallback(record);
  return {
    ruleId,
    certainty: out.certainty,
    title: out.title,
    explanation: out.explanation,
    causes: out.causes ?? [],
    checks: out.checks ?? [],
    actions: standardActions(record, out),
    ...(out.candidates ? { candidates: out.candidates } : {}),
    ...(out.span ? { span: out.span } : {}),
  };
}

/** A copy of the record with its explanation attached. Original message, stack and all other fields are untouched. */
export function withExplanation(
  record: ProblemRecord,
  ctx: RuleContext = {},
  rules: readonly Rule[] = [],
): ProblemRecord {
  return { ...record, explanation: explainProblem(record, ctx, rules) };
}

/** Plain-text rendering of an explanation for one locale (what the problem card shows, minus layout). */
export interface RenderedExplanation {
  readonly location?: string;
  readonly title: string;
  readonly explanation: string;
  readonly causesHeading?: string;
  readonly causes: readonly string[];
  readonly checksHeading?: string;
  readonly checks: readonly string[];
  readonly actions: readonly { readonly kind: ProblemAction['kind']; readonly label: string }[];
  /** Always the record's original message, verbatim. */
  readonly original: string;
}

export function renderExplanation(
  locale: DiagnosticsLocale,
  record: ProblemRecord,
  exp: ProblemExplanation,
): RenderedExplanation {
  const f = (r: Parameters<typeof formatMessage>[1]) => formatMessage(locale, r);
  const location = record.file
    ? record.line
      ? f(msg('location.fileLine', { file: record.file, line: record.line }))
      : f(msg('location.file', { file: record.file }))
    : undefined;
  return {
    ...(location ? { location } : {}),
    title: f(exp.title),
    explanation: f(exp.explanation),
    ...(exp.causes.length ? { causesHeading: f(msg('heading.possibleCauses')) } : {}),
    causes: exp.causes.map(f),
    ...(exp.checks.length ? { checksHeading: f(msg('heading.checks')) } : {}),
    checks: exp.checks.map(f),
    actions: exp.actions.map((a) => ({ kind: a.kind, label: f(a.label) })),
    original: record.originalMessage,
  };
}
