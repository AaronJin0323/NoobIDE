/**
 * S16.6 — cross-origin script errors: explains why no file or line can be shown (PLAN §9 "Clearly explain when a
 * cross-origin error prevents access to its location").
 *
 * - Opaque "Script error." (no message, no location): lists the page's scripts from other websites when the caller
 *   knows them (`ctx.externalScripts`).
 * - An error the preview captured inside a script from another website (`data.scriptUrl`, no project file): Chromium
 *   reports the message to NoobIDE, but the page itself only gets "Script error." and the code is not in the
 *   project, so there is no line to go to. Said with certainty: the reported location is that URL.
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
    const scriptUrl = record.data?.scriptUrl;
    const external =
      !opaque &&
      record.source === 'runtime' &&
      !record.file &&
      typeof scriptUrl === 'string' &&
      /^https?:/i.test(scriptUrl);
    if (external) {
      return {
        certainty: 'certain',
        title: msg('crossOrigin.external.title', { url: scriptUrl }),
        explanation: msg('crossOrigin.external.explanation', { url: scriptUrl }),
        checks: [
          msg('crossOrigin.external.check.calls'),
          msg('crossOrigin.check.download'),
          msg('crossOrigin.check.console'),
        ],
      };
    }
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
