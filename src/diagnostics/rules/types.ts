import type { Certainty, LineSpan, MessageRef, ProblemAction, ProblemRecord } from '../../shared/problem';

/** A name declared in scope at the error location (from the language service), for did-you-mean. */
export interface DeclaredName {
  readonly name: string;
  readonly file?: string;
  /** 1-based line of the declaration. */
  readonly line?: number;
}

/**
 * Facts a rule may use besides the record. Everything is optional: a rule must still give an honest (less specific)
 * explanation when a fact is missing. Gathered by the caller (language service, file tree); kept in memory only and
 * never copied into the record — `lineText` in particular is source code and must not reach logs.
 */
export interface RuleContext {
  /** Names declared in scope where the error happened. */
  readonly declaredNames?: readonly DeclaredName[];
  /** Every file in the project: project-relative, '/'-separated. */
  readonly projectFiles?: readonly string[];
  /** Text of the reported line only (record.file, record.line). */
  readonly lineText?: string;
  /** `id` attribute values present in the project's HTML. */
  readonly htmlIds?: readonly string[];
  /** `class` names present in the project's HTML. */
  readonly htmlClasses?: readonly string[];
  /** URLs of <script src> on other websites that the page loads (for cross-origin "Script error."). */
  readonly externalScripts?: readonly string[];
}

/** What a rule returns; the engine adds the standard actions (go to code, show original) and the rule id. */
export interface RuleOutput {
  readonly certainty: Certainty;
  readonly title: MessageRef;
  readonly explanation: MessageRef;
  readonly causes?: readonly MessageRef[];
  readonly checks?: readonly MessageRef[];
  /** Rule-specific actions, e.g. a one-click fix or "show in file tree". */
  readonly actions?: readonly ProblemAction[];
  readonly candidates?: readonly string[];
  readonly span?: LineSpan;
}

/**
 * A pure function from a record (+ facts) to an explanation, or null when the rule does not apply. Rules must apply
 * only to their defined conditions (PLAN §13: "limit rules to defined conditions").
 */
export interface Rule {
  readonly id: string;
  explain(record: ProblemRecord, ctx: RuleContext): RuleOutput | null;
}
