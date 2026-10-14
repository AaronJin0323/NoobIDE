/**
 * The built-in explanation rules, in priority order: specific message patterns first (modules and JSON are also
 * SyntaxErrors, a failed fetch is also an unhandled rejection), catch-all patterns last.
 */
import type { ProblemExplanation, ProblemRecord } from '../../shared/problem';
import { corsRule, fetchFailureRule, jsonParseRule, unhandledRejectionRule } from './async-network';
import { htmlUnclosedTagRule, notAFunctionRule, selectorGuidedRule } from './code-structure';
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
  corsRule,
  jsonParseRule,
  fetchFailureRule,
  undefinedNameRule,
  notAFunctionRule,
  nullElementRule,
  syntaxRule,
  scriptNotFoundRule,
  imageNotFoundRule,
  stylesheetNotFoundRule,
  cssPropertyRule,
  htmlUnclosedTagRule,
  selectorGuidedRule,
  unhandledRejectionRule,
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
