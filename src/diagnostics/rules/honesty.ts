/**
 * Machine-checkable honesty requirements for explanations (PLAN §9, §13), used by the rule tests:
 * - uncertain causes are worded as possibilities in every locale and come with causes or checks;
 * - the original error stays reachable ("Show original error" is always an action);
 * - every text exists in both dictionaries and every placeholder is filled.
 */
import type { ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { isDiagnosticsMessageKey, type DiagnosticsLocale } from '../messages';
import { renderExplanation } from './engine';

const POSSIBILITY: Record<DiagnosticsLocale, RegExp> = {
  'zh-CN': /可能|也许|或许|不确定|不能确定/,
  en: /\b(may|might|could|possibl[ey]|probably|likely|not sure|cannot tell|not certain)\b/i,
};

export function honestyViolations(record: ProblemRecord, exp: ProblemExplanation): string[] {
  const problems: string[] = [];
  const refs = [exp.title, exp.explanation, ...exp.causes, ...exp.checks, ...exp.actions.map((a) => a.label)];
  for (const r of refs) if (!isDiagnosticsMessageKey(r.key)) problems.push(`unknown message key ${r.key}`);
  if (exp.actions.at(-1)?.kind !== 'show-original') problems.push('show-original is not offered');
  if (exp.certainty !== 'certain' && exp.causes.length + exp.checks.length === 0) {
    problems.push('uncertain explanation without causes or checks');
  }
  for (const locale of ['zh-CN', 'en'] as const) {
    const out = renderExplanation(locale, record, exp);
    const texts = [out.title, out.explanation, ...out.causes, ...out.checks, ...out.actions.map((a) => a.label)];
    for (const t of texts) if (/\{\w+\}/.test(t)) problems.push(`${locale}: unfilled placeholder in "${t}"`);
    if (out.original !== record.originalMessage) problems.push('original message altered');
    if (exp.certainty !== 'certain' && !POSSIBILITY[locale].test(out.explanation)) {
      problems.push(`${locale}: uncertain explanation not worded as a possibility: "${out.explanation}"`);
    }
  }
  return problems;
}
