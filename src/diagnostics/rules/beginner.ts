/**
 * Rules 16–25 (S55.2, docs/product/explanation-rules-16-25.md).
 *
 * Static rules 16–20 and 23–25 consume the records of NoobIDE's beginner checks (../beginner-checks.ts): the code
 * names the rule and `data` holds the facts the check quoted (static-problems.ts reads them from the marker). Runtime
 * rules 21 and 22 run before rules 1 and 3 and take only their narrower cases, so a record gets one rule, never two.
 *
 * Quick fixes (S55.3) are returned as actions only when their target is unambiguous: a `replace-text` with
 * `match: 'exact'` on the reported span, or a `create-file` that never overwrites. The fix decides nothing on its own
 * later: it re-checks that the span still reads `from` before editing.
 */
import type { LineSpan, MessageRef, ProblemAction, ProblemRecord } from '../../shared/problem';
import {
  BEGINNER_CODES,
  matchReference,
  relativeReference,
  resolveReference,
  type ReferenceMatch,
} from '../beginner-checks';
import { msg } from '../messages';
import { dirName, extension, joinNames } from '../text';
import { BY_ID, NULL_ACCESS, QUERY } from './null-element';
import type { Rule, RuleContext } from './types';
import { undefinedName } from './undefined-name';

const str = (record: ProblemRecord, key: string): string | undefined => {
  const v = record.data?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
};

/** The reported span on one line (the marker's start column to its end column), when the record has it. */
function spanOf(record: ProblemRecord, length?: number): LineSpan | undefined {
  if (!record.file || !record.line || !record.column) return undefined;
  const end = record.data?.endColumn;
  const endLine = record.data?.endLine;
  if (endLine !== undefined && endLine !== record.line) return undefined;
  const endColumn = length !== undefined ? record.column + length : typeof end === 'number' ? end : undefined;
  if (endColumn === undefined || endColumn <= record.column) return undefined;
  return { file: record.file, line: record.line, column: record.column, endColumn };
}

const isStatic = (record: ProblemRecord, code: string) => record.source === 'static' && record.code === code;

// Rules 16 and 24 — references ------------------------------------------------------------------------------------

/** `ref` rewritten to point at `target`, keeping its style (root-relative or relative) and its ?query / #fragment. */
export function rewriteReference(fromFile: string, ref: string, target: string): string {
  const suffix = /[?#].*$/.exec(ref)?.[0] ?? '';
  const path = ref.trim().startsWith('/') ? `/${target}` : relativeReference(fromFile, target);
  return path + suffix;
}

const TEMPLATES: Readonly<Record<string, 'html' | 'css' | 'js'>> = { html: 'html', htm: 'html', css: 'css', js: 'js' };

function referenceFacts(record: ProblemRecord, ctx: RuleContext) {
  const ref = str(record, 'ref');
  const attr = str(record, 'attr') ?? 'src';
  if (!record.file || ref === undefined) return null;
  const target = resolveReference(record.file, ref);
  const match: ReferenceMatch | null = target && ctx.projectFiles ? matchReference(target, ctx.projectFiles) : null;
  return { ref, attr, target, match, file: record.file };
}

function usePath(record: ProblemRecord, ref: string, file: string, target: string): ProblemAction | null {
  const span = spanOf(record, ref.length);
  const to = rewriteReference(file, ref, target);
  if (!span || to === ref) return null;
  return { kind: 'replace-text', label: msg('action.usePath', { path: to }), span, from: ref, to, match: 'exact' };
}

export const brokenRefRule: Rule = {
  id: 'html-broken-ref',
  explain(record, ctx) {
    if (!isStatic(record, BEGINNER_CODES.brokenRef)) return null;
    const facts = referenceFacts(record, ctx);
    if (!facts) return null;
    const { ref, attr, target, match, file } = facts;
    const candidates = match?.kind === 'missing' ? match.candidates : [];
    const causes: MessageRef[] = [];
    const actions: ProblemAction[] = [];
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) {
      causes.push(msg('brokenRef.cause.similar', { actual: only }));
      const fix = usePath(record, ref, file, only);
      if (fix) actions.push(fix);
    } else if (candidates.length > 1) {
      causes.push(msg('brokenRef.cause.several', { candidates: joinNames(candidates.slice(0, 3)) }));
    } else {
      causes.push(msg('brokenRef.cause.missing'));
      const template = target ? TEMPLATES[extension(target)] : undefined;
      const folder = target ? dirName(target) : '';
      const folderExists = folder === '' || Boolean(ctx.projectFiles?.some((f) => f.startsWith(`${folder}/`)));
      if (target && template && match?.kind === 'missing' && folderExists && record.line) {
        actions.push({
          kind: 'create-file',
          label: msg('action.createFile', { path: target }),
          path: target,
          template,
          problemFile: file,
          problemLine: record.line,
        });
      }
    }
    return {
      certainty: 'likely',
      title: msg('brokenRef.title', { attr, ref }),
      explanation: msg('brokenRef.explanation', { path: target ?? ref }),
      causes,
      checks: [msg('brokenRef.check.relative', { file }), msg('brokenRef.check.compare')],
      actions,
      ...(candidates.length ? { candidates } : {}),
    };
  },
};

export const refCaseRule: Rule = {
  id: 'html-ref-case',
  explain(record, ctx) {
    if (!isStatic(record, BEGINNER_CODES.refCase)) return null;
    const facts = referenceFacts(record, ctx);
    if (!facts) return null;
    const { ref, attr, match, file } = facts;
    // With the file list the match is recomputed (the files may have changed); without it the check's own answer.
    const actuals =
      match?.kind === 'case' ? match.actuals : match ? [] : (str(record, 'actual') ?? '').split(', ').filter(Boolean);
    const [only] = actuals;
    const actions: ProblemAction[] = [];
    if (actuals.length === 1 && only !== undefined) {
      const fix = usePath(record, ref, file, only);
      if (fix) actions.push(fix);
    }
    return {
      certainty: 'likely',
      title: msg('refCase.title', { attr, ref, actual: actuals.length ? joinNames(actuals) : ref }),
      explanation: msg('refCase.explanation'),
      checks: [msg('refCase.check.match')],
      actions,
    };
  },
};

// Rule 17 ---------------------------------------------------------------------------------------------------------

export const duplicateIdRule: Rule = {
  id: 'html-duplicate-id',
  explain(record) {
    if (!isStatic(record, BEGINNER_CODES.duplicateId)) return null;
    const id = str(record, 'id');
    if (!id) return null;
    return {
      certainty: 'certain',
      title: msg('dupId.title', { id, firstLine: str(record, 'firstLine') ?? '?' }),
      explanation: msg('dupId.explanation', { id }),
      checks: [msg('dupId.check.rename'), msg('dupId.check.code', { id })],
    };
  },
};

// Rule 18 ---------------------------------------------------------------------------------------------------------

export const imgAltRule: Rule = {
  id: 'html-img-no-alt',
  explain(record) {
    if (!isStatic(record, BEGINNER_CODES.imgNoAlt)) return null;
    // The tag name as written (`IMG` stays `IMG`): the fix replaces exactly it.
    const tag = /^img$/i.test(str(record, 'tag') ?? '') ? (str(record, 'tag') as string) : 'img';
    const span = spanOf(record, 3);
    const actions: ProblemAction[] = span
      ? [{ kind: 'replace-text', label: msg('action.addAlt'), span, from: tag, to: `${tag} alt=""`, match: 'exact' }]
      : [];
    return {
      certainty: 'certain',
      title: msg('imgAlt.title'),
      explanation: msg('imgAlt.explanation'),
      checks: [msg('imgAlt.check.describe')],
      actions,
    };
  },
};

// Rule 19 ---------------------------------------------------------------------------------------------------------

export const mismatchedCloseRule: Rule = {
  id: 'html-mismatched-close',
  explain(record) {
    if (!isStatic(record, BEGINNER_CODES.mismatchedClose)) return null;
    const tag = str(record, 'tagName');
    if (!tag) return null;
    const open = str(record, 'open');
    if (!open) {
      return {
        certainty: 'certain',
        title: msg('mismatch.title', { tag }),
        explanation: msg('mismatch.explanation.none', { tag }),
        checks: [msg('mismatch.check.spelling')],
      };
    }
    const actions: ProblemAction[] = [];
    const span = spanOf(record, tag.length);
    // Only when <open> is never closed later (the check says so): then the pair is unambiguous.
    if (span && str(record, 'pairs') === 'yes' && open !== tag) {
      actions.push({
        kind: 'replace-text',
        label: msg('action.fixClosingTag', { from: tag, to: open }),
        span,
        from: tag,
        to: open,
        match: 'exact',
      });
    }
    return {
      certainty: 'likely',
      title: msg('mismatch.title', { tag }),
      explanation: msg('mismatch.explanation.open', { tag, open }),
      checks: [msg('mismatch.check.pair', { open }), msg('mismatch.check.spelling')],
      actions,
    };
  },
};

// Rule 20 ---------------------------------------------------------------------------------------------------------

export const unitlessLengthRule: Rule = {
  id: 'css-unitless-length',
  explain(record) {
    if (!isStatic(record, BEGINNER_CODES.unitlessLength)) return null;
    const property = str(record, 'property');
    const value = str(record, 'value');
    if (!property || !value) return null;
    // The number itself (the marker's span) is what needs the unit.
    const number = /-?(?:\d+\.?\d*|\.\d+)/.exec(value)?.[0] ?? value;
    return {
      certainty: 'certain',
      title: msg('unitless.title', { property, value }),
      explanation: msg('unitless.explanation', { value: number }),
      checks: [msg('unitless.check.unit')],
    };
  },
};

// Rule 21 ---------------------------------------------------------------------------------------------------------

const INLINE_FRAME = /\bat HTML\w*Element\.on[a-z]+\b/;

export const inlineHandlerRule: Rule = {
  id: 'inline-handler-undefined',
  explain(record) {
    if (record.source !== 'runtime' && record.source !== 'console') return null;
    const found = undefinedName(record);
    if (!found) return null;
    const fromHtml = /\.html?$/i.test(record.file ?? '');
    if (!INLINE_FRAME.test(record.originalStack ?? '') && !fromHtml) return null;
    const { name } = found;
    return {
      certainty: 'possible',
      title: msg('inlineHandler.title', { name }),
      explanation: msg('inlineHandler.explanation', { name }),
      causes: [
        msg('inlineHandler.cause.module'),
        msg('inlineHandler.cause.notLoaded'),
        msg('inlineHandler.cause.spelling'),
        msg('inlineHandler.cause.nested'),
      ],
      checks: [msg('inlineHandler.check.compare', { name }), msg('inlineHandler.check.listener')],
    };
  },
};

// Rule 22 ---------------------------------------------------------------------------------------------------------

export const scriptBeforeElementRule: Rule = {
  id: 'script-before-element',
  explain(record, ctx) {
    if (record.source !== 'runtime' && record.source !== 'console') return null;
    if (!NULL_ACCESS.test(record.originalMessage) || !ctx.lineText || !ctx.htmlIds) return null;
    const byId = BY_ID.exec(ctx.lineText)?.[2];
    const selector = byId === undefined ? QUERY.exec(ctx.lineText)?.[2] : undefined;
    const id = byId ?? (selector && /^#[\w-]+$/u.test(selector) ? selector.slice(1) : undefined);
    // Only when the element is known to exist; otherwise rule 3 explains a missing or misspelled element.
    if (!id || !ctx.htmlIds.includes(id)) return null;
    return {
      certainty: 'likely',
      title: msg('scriptEarly.title', { id }),
      explanation: msg('scriptEarly.explanation'),
      checks: [msg('scriptEarly.check.move'), msg('scriptEarly.check.dynamic'), msg('scriptEarly.check.page', { id })],
    };
  },
};

// Rule 23 ---------------------------------------------------------------------------------------------------------

export const selectorPrefixRule: Rule = {
  id: 'js-selector-prefix',
  explain(record, ctx) {
    if (!isStatic(record, BEGINNER_CODES.selectorPrefix)) return null;
    const method = str(record, 'method');
    const selector = str(record, 'selector');
    if (!method || !selector) return null;
    const span = spanOf(record, selector.length);
    const fix = (to: string): ProblemAction[] =>
      span
        ? [
            {
              kind: 'replace-text',
              label: msg('action.useSelector', { from: selector, to }),
              span,
              from: selector,
              to,
              match: 'exact',
            },
          ]
        : [];
    if (method === 'getElementById') {
      const prefix = selector[0] ?? '#';
      const name = selector.slice(1);
      const defined = Boolean(ctx.htmlIds?.includes(name));
      return {
        certainty: 'likely',
        title: msg('selPrefix.title.byIdHash', { selector, prefix }),
        explanation: msg('selPrefix.explanation.byIdHash'),
        causes: defined ? [msg('selPrefix.cause.isId', { name })] : [],
        checks: [msg('selPrefix.check.prefix')],
        actions: defined ? fix(name) : [],
      };
    }
    const isId = Boolean(ctx.htmlIds?.includes(selector));
    const isClass = Boolean(ctx.htmlClasses?.includes(selector));
    const causes = [
      ...(isId ? [msg('selPrefix.cause.isId', { name: selector })] : []),
      ...(isClass ? [msg('selPrefix.cause.isClass', { name: selector })] : []),
    ];
    return {
      certainty: 'likely',
      title: msg('selPrefix.title.queryBare', { selector }),
      explanation: msg('selPrefix.explanation.queryBare', { selector }),
      causes,
      checks: [msg('selPrefix.check.prefix')],
      // Exactly one of "id" / "class" is defined: then the prefix is unambiguous.
      actions: isId !== isClass ? fix(`${isId ? '#' : '.'}${selector}`) : [],
    };
  },
};

// Rule 25 ---------------------------------------------------------------------------------------------------------

export const assignInConditionRule: Rule = {
  id: 'js-assign-in-condition',
  explain(record) {
    if (!isStatic(record, BEGINNER_CODES.assignInCondition)) return null;
    const keyword = str(record, 'keyword') === 'while' ? 'while' : 'if';
    return {
      certainty: 'likely',
      title: msg('assignCond.title', { keyword }),
      explanation: msg('assignCond.explanation'),
      checks: [msg('assignCond.check.compare')],
    };
  },
};

/** Static rules 16–20, 23–25 (any order: each takes only its own code). */
export const BEGINNER_STATIC_RULES: readonly Rule[] = [
  brokenRefRule,
  refCaseRule,
  duplicateIdRule,
  imgAltRule,
  mismatchedCloseRule,
  unitlessLengthRule,
  selectorPrefixRule,
  assignInConditionRule,
];
