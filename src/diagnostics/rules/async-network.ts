/**
 * Rules 9–12 (S22.3): unhandled promise rejections, fetch failures, CORS and JSON parse errors.
 *
 * Order matters: CORS, JSON and fetch are more specific than "unhandled rejection" (a failed fetch that nobody
 * catches arrives as "Uncaught (in promise) TypeError: Failed to fetch"), so DEFAULT_RULES lists them first.
 */
import type { MessageRef, ProblemRecord } from '../../shared/problem';
import { msg, type DiagnosticsMessageKey } from '../messages';
import { requestedPath } from './not-found';
import type { Rule } from './types';

const fromPage = (r: ProblemRecord) => r.source === 'runtime' || r.source === 'console';

// Rule 9 ------------------------------------------------------------------------------------------------------------

export const unhandledRejectionRule: Rule = {
  id: 'unhandled-rejection',
  explain(record) {
    if (!fromPage(record)) return null;
    if (record.code !== 'unhandledrejection' && !/Uncaught \(in promise\)/.test(record.originalMessage)) return null;
    return {
      certainty: 'possible',
      title: msg('rejection.title'),
      explanation: msg('rejection.explanation'),
      checks: [msg('rejection.check.catch'), msg('rejection.check.reason')],
    };
  },
};

// Rule 10 -----------------------------------------------------------------------------------------------------------

const FAILED_TO_FETCH = /Failed to fetch|NetworkError when attempting to fetch resource|Load failed/;

function isLocalhost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

export const fetchFailureRule: Rule = {
  id: 'fetch-failed',
  explain(record) {
    const checks = [msg('fetch.check.url'), msg('fetch.check.console')];
    if (record.source === 'resource') {
      const r = record.resource;
      if (!r || r.resourceType !== 'fetch') return null;
      const path = requestedPath(record) ?? r.requestedUrl;
      if (r.status !== undefined && r.status >= 400) {
        return {
          certainty: 'possible',
          title: msg('fetch.status.title', { path, status: r.status }),
          explanation: msg('fetch.explanation'),
          causes: r.status === 404 ? [msg('fetch.cause.notFound')] : [],
          checks,
        };
      }
      if (r.netError) {
        const causes: MessageRef[] = isLocalhost(r.requestedUrl)
          ? [msg('fetch.cause.serverDown')]
          : [msg('fetch.cause.offline'), msg('fetch.cause.cors')];
        return {
          certainty: 'possible',
          title: msg('fetch.network.title', { path, netError: r.netError }),
          explanation: msg('fetch.explanation'),
          causes,
          checks,
        };
      }
      return null;
    }
    if (!fromPage(record) || !FAILED_TO_FETCH.test(record.originalMessage)) return null;
    return {
      certainty: 'possible',
      title: msg('fetch.failed.title'),
      explanation: msg('fetch.explanation'),
      causes: [msg('fetch.cause.cors'), msg('fetch.cause.offline'), msg('fetch.cause.serverDown')],
      checks,
    };
  },
};

// Rule 11 -----------------------------------------------------------------------------------------------------------

const CORS = /blocked by CORS policy/;
const CORS_URL = /Access to (?:fetch|XMLHttpRequest|script|image|font|resource)? ?at '([^']+)' from origin/;

export const corsRule: Rule = {
  id: 'cors',
  explain(record) {
    if (!fromPage(record) && record.source !== 'resource') return null;
    if (!CORS.test(record.originalMessage)) return null;
    const url = CORS_URL.exec(record.originalMessage)?.[1];
    return {
      certainty: 'certain',
      title: url ? msg('cors.title', { url }) : msg('cors.titleGeneric'),
      explanation: msg('cors.explanation'),
      checks: [msg('cors.check.local'), msg('cors.check.api')],
    };
  },
};

// Rule 12 -----------------------------------------------------------------------------------------------------------

const JSON_CASES: readonly [RegExp, DiagnosticsMessageKey, 'likely' | 'possible'][] = [
  [/Unexpected token '?<'?,? .*(?:is not valid JSON|in JSON)/, 'json.html.explanation', 'likely'],
  [/"undefined" is not valid JSON|Unexpected token u in JSON/, 'json.undefined.explanation', 'likely'],
  [/Unexpected end of JSON input/, 'json.empty.explanation', 'possible'],
  [
    /Expected (?:double-quoted )?property name|Expected ',' or '}' after property value|Unexpected token '''|Bad control character|in JSON at position/,
    'json.quotes.explanation',
    'likely',
  ],
];

export const jsonParseRule: Rule = {
  id: 'json-parse',
  explain(record) {
    if (!fromPage(record)) return null;
    const m = record.originalMessage;
    if (!/SyntaxError/.test(m) && record.code !== 'SyntaxError') return null;
    if (!/JSON/.test(m)) return null;
    const [, key, certainty] = JSON_CASES.find(([re]) => re.test(m)) ?? [
      undefined,
      'json.generic.explanation' as const,
      'possible' as const,
    ];
    return {
      certainty,
      title: msg('json.title'),
      explanation: msg(key),
      checks: [msg('json.check.url'), msg('json.check.file')],
    };
  },
};
