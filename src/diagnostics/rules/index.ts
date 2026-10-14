/**
 * The built-in explanation rules, in priority order: specific message patterns first (modules and JSON are also
 * SyntaxErrors, so they precede the general syntax rule).
 */
import type { ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { cssPropertyRule } from './css-property';
import { explainProblem, withExplanation } from './engine';
import { moduleImportRule } from './module-import';
import { imageNotFoundRule, scriptNotFoundRule, stylesheetNotFoundRule } from './not-found';
import { nullElementRule } from './null-element';
import { syntaxRule } from './syntax';
import type { Rule, RuleContext } from './types';
import { undefinedNameRule } from './undefined-name';

export const DEFAULT_RULES: readonly Rule[] = [
  moduleImportRule,
  undefinedNameRule,
  nullElementRule,
  syntaxRule,
  scriptNotFoundRule,
  imageNotFoundRule,
  stylesheetNotFoundRule,
  cssPropertyRule,
];

/** Explains a record with the built-in rules. */
export function explain(record: ProblemRecord, ctx: RuleContext = {}): ProblemExplanation {
  return explainProblem(record, ctx, DEFAULT_RULES);
}

/** A copy of the record with the built-in explanation attached; the original evidence is untouched. */
export function explainRecord(record: ProblemRecord, ctx: RuleContext = {}): ProblemRecord {
  return withExplanation(record, ctx, DEFAULT_RULES);
}

export type { Rule, RuleContext, RuleOutput, DeclaredName } from './types';
