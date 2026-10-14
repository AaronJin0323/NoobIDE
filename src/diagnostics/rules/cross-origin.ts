/**
 * S16.6 — opaque cross-origin "Script error.": explains why no file or line can be shown (PLAN §9 "Clearly explain
 * when a cross-origin error prevents access to its location"). Lists the page's scripts from other websites when the
 * caller knows them (`ctx.externalScripts`).
 */
import { msg } from '../messages';
import { CROSS_ORIGIN_SCRIPT_ERROR } from '../normalize';
import type { Rule } from './types';

export const crossOriginRule: Rule = {
  id: CROSS_ORIGIN_SCRIPT_ERROR,
  explain(record, ctx) {
    const opaque =
      record.code === CROSS_ORIGIN_SCRIPT_ERROR ||
      (record.source === 'runtime' &&
        !record.file &&
        /^(?:Uncaught )?Script error\.?$/.test(record.originalMessage.trim()));
    if (!opaque) return null;
    return {
      certainty: 'likely',
      title: msg('crossOrigin.title'),
      explanation: msg('crossOrigin.explanation'),
      causes: (ctx.externalScripts ?? []).slice(0, 3).map((url) => msg('crossOrigin.cause.script', { url })),
      checks: [
        msg('crossOrigin.check.download'),
        msg('crossOrigin.check.crossorigin'),
        msg('crossOrigin.check.console'),
      ],
    };
  },
};
