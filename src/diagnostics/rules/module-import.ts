/**
 * Rule 8 — ES module import failures (S22.2).
 *
 * Applies to Chromium messages:
 * - Failed to resolve module specifier "lodash". Relative references must start with either "/", "./", or "../".
 * - Cannot use import statement outside a module / Unexpected token 'export'
 * - The requested module './util.js' does not provide an export named 'add'
 * - Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME
 *   type of "text/html" … / Failed to fetch dynamically imported module: …
 */
import { msg } from '../messages';
import type { Rule } from './types';

export const MODULE_IMPORT_RULE_ID = 'module-import';

const BARE = /Failed to resolve module specifier ["']([^"']+)["']/;
const NOT_MODULE = /Cannot use import statement outside a module|Unexpected token '(?:export|import)'/;
const MISSING_EXPORT = /The requested module ['"]([^'"]+)['"] does not provide an export named ['"]([^'"]+)['"]/;
const LOAD_FAILED = /Failed to load module script|Failed to fetch dynamically imported module/;

export const moduleImportRule: Rule = {
  id: MODULE_IMPORT_RULE_ID,
  explain(record) {
    if (record.source !== 'runtime' && record.source !== 'console') return null;
    const m = record.originalMessage;

    const bare = BARE.exec(m)?.[1];
    if (bare !== undefined) {
      return {
        certainty: 'certain',
        title: msg('module.bare.title', { specifier: bare }),
        explanation: msg('module.bare.explanation', { specifier: bare }),
        checks: [msg('module.bare.check.relative'), msg('module.bare.check.download')],
      };
    }
    if (NOT_MODULE.test(m)) {
      return {
        certainty: 'likely',
        title: msg('module.notModule.title'),
        explanation: msg('module.notModule.explanation'),
        checks: [msg('module.notModule.check.type')],
      };
    }
    const missing = MISSING_EXPORT.exec(m);
    if (missing?.[1] && missing[2]) {
      const params = { module: missing[1], name: missing[2] };
      return {
        certainty: 'likely',
        title: msg('module.missingExport.title', params),
        explanation: msg('module.missingExport.explanation', params),
        checks: [msg('module.missingExport.check.export', params), msg('module.missingExport.check.default')],
      };
    }
    if (LOAD_FAILED.test(m)) {
      return {
        certainty: 'possible',
        title: msg('module.loadFailed.title'),
        explanation: msg('module.loadFailed.explanation'),
        checks: [msg('module.loadFailed.check.path')],
      };
    }
    return null;
  },
};
