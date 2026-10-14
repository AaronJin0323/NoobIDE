/**
 * Rule 7 — misspelled CSS property (S22.2).
 *
 * Applies to the CSS language service's static diagnostic `unknownProperties` ("Unknown property: 'colr'").
 * Vendor-prefixed properties (-webkit-…) are left alone. Candidates come from a bundled list of standard properties.
 */
import type { LineSpan } from '../../shared/problem';
import { msg } from '../messages';
import { joinNames, similarNames } from '../text';
import type { Rule } from './types';

export const CSS_PROPERTY_RULE_ID = 'css-unknown-property';

/** Standard CSS properties a beginner is likely to type (offline, bundled). */
// prettier-ignore
export const CSS_PROPERTIES: readonly string[] = [
  'accent-color', 'align-content', 'align-items', 'align-self', 'all', 'animation', 'animation-delay',
  'animation-direction', 'animation-duration', 'animation-fill-mode', 'animation-iteration-count', 'animation-name',
  'animation-play-state', 'animation-timing-function', 'aspect-ratio', 'backdrop-filter', 'backface-visibility',
  'background', 'background-attachment', 'background-blend-mode', 'background-clip', 'background-color',
  'background-image', 'background-origin', 'background-position', 'background-repeat', 'background-size',
  'border', 'border-bottom', 'border-bottom-color', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-bottom-style', 'border-bottom-width', 'border-collapse', 'border-color', 'border-image', 'border-left',
  'border-left-color', 'border-left-style', 'border-left-width', 'border-radius', 'border-right', 'border-right-color',
  'border-right-style', 'border-right-width', 'border-spacing', 'border-style', 'border-top', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-top-style', 'border-top-width', 'border-width',
  'bottom', 'box-shadow', 'box-sizing', 'caption-side', 'caret-color', 'clear', 'clip-path', 'color', 'column-count',
  'column-gap', 'columns', 'content', 'counter-increment', 'counter-reset', 'cursor', 'direction', 'display',
  'empty-cells', 'filter', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow', 'flex-shrink',
  'flex-wrap', 'float', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight', 'gap', 'grid',
  'grid-area', 'grid-auto-columns', 'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end',
  'grid-column-start', 'grid-row', 'grid-row-end', 'grid-row-start', 'grid-template', 'grid-template-areas',
  'grid-template-columns', 'grid-template-rows', 'height', 'inset', 'isolation', 'justify-content', 'justify-items',
  'justify-self', 'left', 'letter-spacing', 'line-height', 'list-style', 'list-style-image', 'list-style-position',
  'list-style-type', 'margin', 'margin-bottom', 'margin-left', 'margin-right', 'margin-top', 'max-height',
  'max-width', 'min-height', 'min-width', 'mix-blend-mode', 'object-fit', 'object-position', 'opacity', 'order',
  'outline', 'outline-color', 'outline-offset', 'outline-style', 'outline-width', 'overflow', 'overflow-wrap',
  'overflow-x', 'overflow-y', 'padding', 'padding-bottom', 'padding-left', 'padding-right', 'padding-top',
  'perspective', 'place-content', 'place-items', 'place-self', 'pointer-events', 'position', 'quotes', 'resize',
  'right', 'row-gap', 'scroll-behavior', 'scroll-margin', 'scroll-padding', 'tab-size', 'table-layout', 'text-align',
  'text-decoration', 'text-decoration-color', 'text-decoration-line', 'text-decoration-style', 'text-indent',
  'text-overflow', 'text-shadow', 'text-transform', 'top', 'transform', 'transform-origin', 'transition',
  'transition-delay', 'transition-duration', 'transition-property', 'transition-timing-function', 'user-select',
  'vertical-align', 'visibility', 'white-space', 'width', 'word-break', 'word-spacing', 'word-wrap', 'writing-mode',
  'z-index',
];

const UNKNOWN = /Unknown property:? '([^']+)'/;

export const cssPropertyRule: Rule = {
  id: CSS_PROPERTY_RULE_ID,
  explain(record, ctx) {
    if (record.source !== 'static') return null;
    const m = UNKNOWN.exec(record.originalMessage);
    if (record.code !== 'unknownProperties' && !m) return null;
    const property = m?.[1];
    if (!property || property.startsWith('-')) return null;

    const candidates = similarNames(property, CSS_PROPERTIES);
    let span: LineSpan | undefined;
    if (record.file && record.line && record.column && ctx.lineText !== undefined) {
      const at = ctx.lineText.slice(record.column - 1, record.column - 1 + property.length);
      if (at === property) {
        span = {
          file: record.file,
          line: record.line,
          column: record.column,
          endColumn: record.column + property.length,
        };
      }
    }
    const [only] = candidates;
    return {
      certainty: candidates.length === 1 ? 'likely' : 'possible',
      title: msg('cssProperty.title', { property }),
      explanation:
        candidates.length === 1 && only !== undefined
          ? msg('cssProperty.explanation.one', { candidate: only })
          : candidates.length > 1
            ? msg('cssProperty.explanation.several', { candidates: joinNames(candidates.slice(0, 3)) })
            : msg('cssProperty.explanation.none'),
      checks: [msg('cssProperty.check.spelling'), ...(candidates.length ? [] : [msg('cssProperty.check.reference')])],
      candidates,
      ...(span ? { span } : {}),
    };
  },
};
