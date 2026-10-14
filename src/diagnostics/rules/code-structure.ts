/**
 * Rules 13–15 (S22.3): "x is not a function", unclosed HTML tags, and guided checks for a CSS selector that does not
 * match the HTML.
 *
 * Rules 14 and 15 consume static records from NoobIDE's own HTML/CSS checks (S19), which must use the codes below and
 * put the tag name / selector in `data`. Rule 15 is deliberately a guided checklist: static analysis cannot prove why a
 * style does not apply (PLAN §9), so its certainty is always 'unknown'.
 */
import type { MessageRef } from '../../shared/problem';
import { msg } from '../messages';
import { IDENTIFIER, joinNames, similarNames } from '../text';
import type { Rule } from './types';

// Rule 13 -----------------------------------------------------------------------------------------------------------

/** Built-in methods beginners call most often; used for did-you-mean on a misspelled method name. */
// prettier-ignore
export const KNOWN_METHODS: readonly string[] = [
  'getElementById', 'getElementsByClassName', 'getElementsByTagName', 'querySelector', 'querySelectorAll',
  'addEventListener', 'removeEventListener', 'appendChild', 'removeChild', 'createElement', 'setAttribute',
  'getAttribute', 'removeAttribute', 'preventDefault', 'stopPropagation', 'insertBefore', 'replaceChild', 'cloneNode',
  'contains', 'focus', 'blur', 'click', 'scrollIntoView', 'toggle', 'add', 'remove', 'append', 'prepend',
  'forEach', 'map', 'filter', 'reduce', 'find', 'findIndex', 'includes', 'indexOf', 'push', 'pop', 'shift',
  'unshift', 'slice', 'splice', 'join', 'sort', 'reverse', 'concat', 'some', 'every',
  'toUpperCase', 'toLowerCase', 'trim', 'split', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'substring',
  'padStart', 'charAt', 'toFixed', 'toString', 'parse', 'stringify', 'floor', 'round', 'random', 'ceil', 'max', 'min',
  'abs', 'log', 'warn', 'error', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'alert', 'prompt',
  'confirm', 'fetch', 'then', 'catch', 'json', 'text', 'getItem', 'setItem', 'removeItem',
];
const ARRAY_METHODS = new Set([
  'forEach',
  'map',
  'filter',
  'reduce',
  'find',
  'findIndex',
  'some',
  'every',
  'join',
  'push',
  'includes',
]);

const NOT_A_FUNCTION = new RegExp(`(${IDENTIFIER}(?:\\.${IDENTIFIER})*) is not a function`, 'u');

export const notAFunctionRule: Rule = {
  id: 'not-a-function',
  explain(record, ctx) {
    if (record.source !== 'runtime' && record.source !== 'console') return null;
    const name = NOT_A_FUNCTION.exec(record.originalMessage)?.[1];
    if (!name) return null;
    const dot = name.lastIndexOf('.');
    const member = dot === -1 ? name : name.slice(dot + 1);
    const object = dot === -1 ? undefined : name.slice(0, dot);
    const pool = [...(object ? KNOWN_METHODS : []), ...(ctx.declaredNames ?? []).map((d) => d.name)];
    // A correctly spelled method (items.map) means the object is the problem, not the name.
    const candidates = pool.includes(member) ? [] : similarNames(member, pool);
    const [only] = candidates;

    let explanation: MessageRef;
    let certainty: 'likely' | 'possible' = 'possible';
    const checks: MessageRef[] = [];
    if (candidates.length === 1 && only !== undefined) {
      explanation = msg('notFunction.explanation.typo', { candidate: only });
      certainty = 'likely';
      checks.push(msg('notFunction.check.spelling'));
    } else if (candidates.length > 1) {
      explanation = msg('notFunction.explanation.several', { candidates: joinNames(candidates.slice(0, 3)) });
      checks.push(msg('notFunction.check.spelling'));
    } else if (object && ARRAY_METHODS.has(member)) {
      explanation = msg('notFunction.explanation.notArray', { object, method: member });
      checks.push(msg('notFunction.check.array', { object }));
    } else {
      explanation = msg('notFunction.explanation.generic');
      checks.push(msg('notFunction.check.spelling'));
    }
    checks.push(msg('notFunction.check.log', { name }));
    return { certainty, title: msg('notFunction.title', { name }), explanation, checks, candidates };
  },
};

// Rule 14 -----------------------------------------------------------------------------------------------------------

/** Static code for an HTML element without its closing tag; `data.tagName` holds the tag. */
export const HTML_UNCLOSED_CODE = 'html-unclosed-tag';
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const UNCLOSED_MESSAGE = /Unclosed (?:element|tag) [`'"<]?([A-Za-z][\w-]*)/i;

export const htmlUnclosedTagRule: Rule = {
  id: 'html-unclosed-tag',
  explain(record) {
    if (record.source !== 'static') return null;
    const fromData = record.data?.tagName;
    const tag =
      record.code === HTML_UNCLOSED_CODE && typeof fromData === 'string'
        ? fromData
        : UNCLOSED_MESSAGE.exec(record.originalMessage)?.[1];
    if (!tag || VOID_ELEMENTS.has(tag.toLowerCase())) return null;
    return {
      certainty: 'likely',
      title: msg('htmlUnclosed.title', { tag }),
      explanation: msg('htmlUnclosed.explanation', { tag }),
      checks: [
        record.line
          ? msg('htmlUnclosed.check.findFromLine', { tag, line: record.line })
          : msg('htmlUnclosed.check.find', { tag }),
        msg('htmlUnclosed.check.typo'),
        msg('htmlUnclosed.check.indent'),
      ],
    };
  },
};

// Rule 15 -----------------------------------------------------------------------------------------------------------

/** Static code for a CSS selector that matches nothing in the project's HTML; `data.selector` holds it. */
export const SELECTOR_UNMATCHED_CODE = 'css-selector-unmatched';
/** Code for the user-started guided check "my style does not apply" (no selector known). */
export const STYLE_NOT_APPLIED_CODE = 'guided-style-not-applied';

const SIMPLE = /^([#.])([\w-]+)$/u;

export const selectorGuidedRule: Rule = {
  id: 'selector-guided-checks',
  explain(record, ctx) {
    if (record.code !== SELECTOR_UNMATCHED_CODE && record.code !== STYLE_NOT_APPLIED_CODE) return null;
    const selector = typeof record.data?.selector === 'string' ? record.data.selector : undefined;
    const causes: MessageRef[] = [];
    const simple = selector ? SIMPLE.exec(selector.trim()) : null;
    if (simple?.[1] && simple[2]) {
      const [, prefix, name] = simple;
      const same = prefix === '#' ? ctx.htmlIds : ctx.htmlClasses;
      const other = prefix === '#' ? ctx.htmlClasses : ctx.htmlIds;
      if (other?.includes(name) && !same?.includes(name)) {
        causes.push(msg(prefix === '#' ? 'selector.cause.isClass' : 'selector.cause.isId', { name }));
      } else if (same) {
        const [similar] = similarNames(name, same);
        if (similar !== undefined) {
          causes.push(
            msg(prefix === '#' ? 'selector.cause.similarId' : 'selector.cause.similarClass', { candidate: similar }),
          );
        }
      }
    }
    return {
      certainty: 'unknown',
      title: selector ? msg('selector.title', { selector }) : msg('selector.titleGeneric'),
      explanation: msg('selector.explanation'),
      causes,
      checks: [
        msg('selector.check.spelling'),
        msg('selector.check.prefix'),
        msg('selector.check.linked'),
        msg('selector.check.override'),
        msg('selector.check.saved'),
      ],
    };
  },
};
