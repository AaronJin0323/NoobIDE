/**
 * Rule 2 — bracket and other JavaScript syntax errors (S22.2).
 *
 * Applies to Chromium SyntaxErrors (runtime) and the TypeScript/Monaco syntax diagnostics 1002, 1003, 1005, 1109,
 * 1127, 1128, 1160 (static). JSON.parse errors and module errors (import/export) are left to their own rules.
 */
import type { MessageRef, ProblemRecord } from '../../shared/problem';
import { msg } from '../messages';
import type { Rule, RuleOutput } from './types';

export const SYNTAX_RULE_ID = 'syntax';

const STATIC_CODES = new Set(['1002', '1003', '1005', '1109', '1127', '1128', '1160']);
/** Full-width punctuation a Chinese input method produces where code needs ASCII. */
const FULL_WIDTH = /[（）；，：“”‘’｛｝【】。、《》！？＝＋]/;

const isSyntaxError = (r: ProblemRecord) =>
  r.source === 'static'
    ? STATIC_CODES.has(r.code)
    : (r.source === 'runtime' || r.source === 'console') &&
      (r.code === 'SyntaxError' || /\bSyntaxError\b/.test(r.originalMessage));

const isOtherRulesBusiness = (m: string) =>
  /JSON|import statement|Unexpected token 'export'|Unexpected token 'import'|module/i.test(m);

const bracketChecks: MessageRef[] = [msg('syntax.check.countBrackets'), msg('syntax.check.bracketHighlight')];

function bracketOutput(
  title: MessageRef,
  explanationKey: 'unclosed' | 'bracket',
  causes: MessageRef[] = [],
): RuleOutput {
  return {
    certainty: 'likely',
    title,
    explanation: msg(explanationKey === 'unclosed' ? 'syntax.explanation.unclosed' : 'syntax.explanation.bracket'),
    causes,
    checks: bracketChecks,
  };
}

export const syntaxRule: Rule = {
  id: SYNTAX_RULE_ID,
  explain(record, ctx) {
    if (!isSyntaxError(record)) return null;
    const m = record.originalMessage;
    if (isOtherRulesBusiness(m)) return null;

    if (/Unexpected end of input|'\}' expected|Unexpected end of text/.test(m)) {
      return bracketOutput(msg('syntax.title.endOfInput'), 'unclosed');
    }
    if (/missing \) after argument list|'\)' expected/.test(m)) {
      return bracketOutput(msg('syntax.title.missingParen'), 'bracket', [msg('syntax.cause.previousLine')]);
    }
    const expected = /'([)\]}])' expected/.exec(m);
    if (expected?.[1]) return bracketOutput(msg('syntax.title.expected', { token: expected[1] }), 'bracket');
    const extra = /Unexpected token '([)\]}])'/.exec(m);
    if (extra?.[1]) {
      return bracketOutput(msg('syntax.title.unexpected', { token: extra[1] }), 'bracket', [
        msg('syntax.cause.extraClose', { token: extra[1] }),
        msg('syntax.cause.previousLine'),
      ]);
    }

    const fullWidth = ctx.lineText !== undefined ? FULL_WIDTH.exec(ctx.lineText)?.[0] : undefined;
    if (
      /Invalid or unexpected token|Unterminated string|Invalid character/.test(m) ||
      record.code === '1002' ||
      record.code === '1127'
    ) {
      return {
        certainty: 'possible',
        title: msg('syntax.title.invalidToken'),
        explanation: msg('syntax.explanation.invalidToken'),
        causes: [
          ...(fullWidth ? [msg('syntax.cause.fullWidth', { char: fullWidth })] : []),
          msg('syntax.cause.unclosedQuote'),
        ],
        checks: [msg('syntax.check.quotes'), msg('syntax.check.englishPunctuation')],
      };
    }

    const token = /Unexpected (?:token|identifier|string|number) ?'?([^']*)'?/.exec(m)?.[1];
    return {
      certainty: 'possible',
      title: token ? msg('syntax.title.unexpected', { token }) : msg('syntax.title.generic'),
      explanation: msg('syntax.explanation.generic'),
      causes: [
        msg('syntax.cause.previousLine'),
        ...(fullWidth ? [msg('syntax.cause.fullWidth', { char: fullWidth })] : []),
      ],
      checks: [msg('syntax.check.previousLine'), ...bracketChecks],
    };
  },
};
