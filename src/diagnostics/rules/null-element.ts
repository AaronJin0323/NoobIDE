/**
 * Rule 3 — using a DOM element that was not found (S22.2).
 *
 * Applies to Chromium TypeErrors "Cannot read properties of null (reading 'addEventListener')" and
 * "Cannot set properties of null (setting 'textContent')". When the reported line is known, the id or selector is
 * taken from a getElementById / querySelector call on it and compared with the ids in the project's HTML.
 */
import type { MessageRef } from '../../shared/problem';
import { msg } from '../messages';
import { similarNames } from '../text';
import type { Rule } from './types';

export const NULL_ELEMENT_RULE_ID = 'null-element';

const NULL_ACCESS =
  /Cannot (?:read|set) propert(?:ies|y) (?:of null \((?:reading|setting) '([^']+)'\)|'([^']+)' of null)/;
const BY_ID = /getElementById\(\s*(['"`])([^'"`]+)\1\s*\)/;
const QUERY = /querySelector\(\s*(['"`])([^'"`]+)\1\s*\)/;

export const nullElementRule: Rule = {
  id: NULL_ELEMENT_RULE_ID,
  explain(record, ctx) {
    if (record.source !== 'runtime' && record.source !== 'console') return null;
    const m = NULL_ACCESS.exec(record.originalMessage);
    const property = m?.[1] ?? m?.[2];
    if (!property) return null;

    const causes: MessageRef[] = [];
    const line = ctx.lineText ?? '';
    const id = BY_ID.exec(line)?.[2];
    const selector = id === undefined ? QUERY.exec(line)?.[2] : undefined;
    if (id !== undefined) {
      if (id.startsWith('#')) {
        causes.push(msg('nullElement.cause.idHash', { id: id.slice(1) }));
      } else if (ctx.htmlIds && !ctx.htmlIds.includes(id)) {
        causes.push(msg('nullElement.cause.idMissing', { id }));
        const [similar] = similarNames(id, ctx.htmlIds);
        if (similar !== undefined) causes.push(msg('nullElement.cause.idSimilar', { candidate: similar }));
      } else if (!ctx.htmlIds) {
        causes.push(msg('nullElement.cause.idMissing', { id }));
      }
    } else if (selector !== undefined) {
      causes.push(msg('nullElement.cause.selector', { selector }));
    }
    causes.push(msg('nullElement.cause.tooEarly'));

    return {
      certainty: 'possible',
      title: msg('nullElement.title', { property }),
      explanation: msg('nullElement.explanation'),
      causes,
      checks: [msg('nullElement.check.compare'), msg('nullElement.check.scriptPosition')],
    };
  },
};
