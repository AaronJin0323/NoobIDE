/**
 * Fixtures for the explanation rules: real Chromium / language-service messages as the capture adapter (S16.2),
 * resource tracking (S16.4) and Monaco markers (S19) will report them. At least one per rule; used by the per-rule
 * tests and by rules.test.ts, which runs every fixture through the full rule list and the honesty checks.
 */
import { createProblemRecord, type ProblemInput, type ProblemRecord } from '../../shared/problem';
import type { RuleContext } from './types';

export interface RuleFixture {
  readonly name: string;
  /** The rule id expected to explain it (with DEFAULT_RULES). */
  readonly rule: string;
  readonly record: ProblemRecord;
  readonly ctx: RuleContext;
}

const base = { severity: 'error', projectId: 'proj', at: 1_000 } as const;
const preview = { sessionId: 's4', generation: 2 } as const;
const ORIGIN = 'http://127.0.0.1:51734';

function runtime(
  code: string,
  message: string,
  file = 'script.js',
  line = 12,
  column = 5,
  stack?: string,
): ProblemInput {
  return {
    ...base,
    source: 'runtime',
    preview,
    file,
    line,
    column,
    code,
    message,
    stack: stack ?? `${message.replace(/^Uncaught /, '')}\n    at ${ORIGIN}/${encodeURI(file)}:${line}:${column}`,
  };
}

function staticMarker(code: string, message: string, file: string, line: number, column: number): ProblemInput {
  return { ...base, source: 'static', file, line, column, code, message };
}

function resource(
  requestedPath: string,
  resourceType: NonNullable<ProblemInput['resource']>['resourceType'],
  initiatorFile = 'index.html',
  line = 14,
  status = 404,
): ProblemInput {
  const url = `${ORIGIN}/${encodeURI(requestedPath)}`;
  return {
    ...base,
    source: 'resource',
    preview,
    file: initiatorFile,
    line,
    code: 'resource-failed',
    message: `GET ${url} ${status} (Not Found)`,
    resource: { requestedUrl: url, requestedPath, initiatorFile, status, ...(resourceType ? { resourceType } : {}) },
  };
}

const fx = (name: string, rule: string, input: ProblemInput, ctx: RuleContext = {}): RuleFixture => ({
  name,
  rule,
  record: createProblemRecord(input, name),
  ctx,
});

/** The PLAN §9 / wireframe 3 example line: `alert('你好，' + userNmae);` */
export const USER_NMAE_LINE = "  alert('你好，' + userNmae);";
export const USER_NMAE_COLUMN = USER_NMAE_LINE.indexOf('userNmae') + 1;

export const RULE_FIXTURES: readonly RuleFixture[] = [
  // S16.6 — opaque cross-origin error (as normalizePageError produces it)
  fx(
    'cross-origin-script-error',
    'cross-origin-script-error',
    { ...base, source: 'runtime', preview, code: 'cross-origin-script-error', message: 'Script error.' },
    { externalScripts: ['https://cdn.example.com/lib.min.js'] },
  ),
  // S16.6 — an error the preview captured inside a script from another website (no project file, URL kept)
  fx(
    'cross-origin-external-script-error',
    'cross-origin-script-error',
    {
      ...base,
      source: 'runtime',
      preview,
      code: 'TypeError',
      message: "Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')",
      data: { scriptUrl: 'https://cdn.example.com/lib.min.js' },
    },
    {},
  ),

  // Rule 1 — misspelled / undefined variable
  fx(
    'runtime-referenceerror-one-candidate',
    'undefined-name',
    runtime('ReferenceError', 'Uncaught ReferenceError: userNmae is not defined', 'script.js', 12, USER_NMAE_COLUMN),
    { declaredNames: [{ name: 'userName', file: 'script.js', line: 9 }, { name: 'greet' }], lineText: USER_NMAE_LINE },
  ),
  fx(
    'runtime-referenceerror-no-candidates',
    'undefined-name',
    runtime('ReferenceError', 'Uncaught ReferenceError: total is not defined'),
    { declaredNames: [{ name: 'price' }] },
  ),
  fx(
    'runtime-referenceerror-chinese-name',
    'undefined-name',
    runtime('ReferenceError', 'Uncaught ReferenceError: 用户名字 is not defined'),
    { declaredNames: [{ name: '用户名称', line: 3 }] },
  ),
  fx(
    'static-2552-did-you-mean',
    'undefined-name',
    staticMarker('2552', "Cannot find name 'userNmae'. Did you mean 'userName'?", 'script.js', 12, USER_NMAE_COLUMN),
    { lineText: USER_NMAE_LINE },
  ),

  // Rule 2 — brackets / syntax
  fx(
    'runtime-unexpected-end',
    'syntax',
    runtime('SyntaxError', 'Uncaught SyntaxError: Unexpected end of input', 'script.js', 20, 1),
  ),
  fx(
    'runtime-unexpected-close',
    'syntax',
    runtime('SyntaxError', "Uncaught SyntaxError: Unexpected token '}'", 'script.js', 8, 1),
  ),
  fx('runtime-missing-paren', 'syntax', runtime('SyntaxError', 'Uncaught SyntaxError: missing ) after argument list')),
  fx('static-brace-expected', 'syntax', staticMarker('1005', "'}' expected.", 'script.js', 30, 1)),
  fx(
    'runtime-invalid-token-fullwidth',
    'syntax',
    runtime('SyntaxError', 'Uncaught SyntaxError: Invalid or unexpected token'),
    {
      lineText: "alert('你好')；",
    },
  ),
  fx(
    'runtime-unexpected-identifier',
    'syntax',
    runtime('SyntaxError', "Uncaught SyntaxError: Unexpected identifier 'name'"),
  ),

  // Rule 3 — null DOM element
  fx(
    'runtime-null-addEventListener',
    'null-element',
    runtime(
      'TypeError',
      "Uncaught TypeError: Cannot read properties of null (reading 'addEventListener')",
      'script.js',
      11,
      32,
    ),
    { lineText: "document.getElementById('btn').addEventListener('click', () => {", htmlIds: ['hi', 'Btn'] },
  ),
  fx(
    'runtime-null-set-textContent-selector',
    'null-element',
    runtime('TypeError', "Uncaught TypeError: Cannot set properties of null (setting 'textContent')"),
    { lineText: "document.querySelector('.title').textContent = '你好';" },
  ),
  fx(
    'runtime-null-id-with-hash',
    'null-element',
    runtime('TypeError', "Uncaught TypeError: Cannot read properties of null (reading 'style')"),
    { lineText: "document.getElementById('#box').style.color = 'red';", htmlIds: ['box'] },
  ),

  // Rules 4–6 — 404s
  fx('script-404-missing', 'script-not-found', resource('js/app.js', 'script'), {
    projectFiles: ['index.html', 'style.css', 'script.js'],
  }),
  fx('script-404-other-folder', 'script-not-found', resource('app.js', undefined), {
    projectFiles: ['index.html', 'js/app.js'],
  }),
  fx('image-404-case-mismatch', 'image-not-found', resource('images/头像.PNG', 'image'), {
    projectFiles: ['index.html', 'images/头像.png', 'style.css'],
  }),
  fx('image-404-no-file-list', 'image-not-found', resource('images/logo.png', 'image')),
  fx('css-404-similar-name', 'stylesheet-not-found', resource('styles.css', 'stylesheet', '我的 主页/index.html'), {
    projectFiles: ['我的 主页/index.html', 'style.css'],
  }),
  // A link to a page that does not exist: the document request itself is the 404.
  fx('page-404-missing', 'page-not-found', resource('about.html', 'document'), {
    projectFiles: ['index.html', 'style.css', 'script.js'],
  }),
  fx('page-404-similar-name', 'page-not-found', resource('关于 我.html', 'document'), {
    projectFiles: ['index.html', '关于我.html'],
  }),

  // Rule 7 — misspelled CSS property
  fx(
    'css-unknown-property-colr',
    'css-unknown-property',
    staticMarker('unknownProperties', "Unknown property: 'colr'", 'style.css', 4, 3),
    {
      lineText: '  colr: red;',
    },
  ),
  fx(
    'css-unknown-property-backround-color',
    'css-unknown-property',
    staticMarker('unknownProperties', "Unknown property: 'backround-color'", 'style.css', 7, 3),
  ),

  // Rule 8 — module import failures
  fx(
    'module-bare-specifier',
    'module-import',
    runtime(
      'TypeError',
      'Uncaught TypeError: Failed to resolve module specifier "lodash". Relative references must start with either "/", "./", or "../".',
      'main.js',
      1,
      1,
    ),
  ),
  fx(
    'module-import-outside-module',
    'module-import',
    runtime('SyntaxError', 'Uncaught SyntaxError: Cannot use import statement outside a module', 'main.js', 1, 1),
  ),
  fx(
    'module-missing-export',
    'module-import',
    runtime(
      'SyntaxError',
      "Uncaught SyntaxError: The requested module './util.js' does not provide an export named 'add'",
      'main.js',
      1,
      10,
    ),
  ),
  fx(
    'module-mime-html',
    'module-import',
    runtime(
      'Error',
      'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html". Strict MIME type checking is enforced for module scripts per HTML spec.',
      'index.html',
      9,
      1,
    ),
  ),

  // Rule 9 — unhandled rejection
  fx('unhandled-rejection-error', 'unhandled-rejection', {
    ...runtime('unhandledrejection', 'Uncaught (in promise) Error: 用户不存在', 'app.js', 20, 11),
  }),

  // Rule 10 — fetch failures
  fx(
    'fetch-failed-to-fetch',
    'fetch-failed',
    runtime('TypeError', 'Uncaught (in promise) TypeError: Failed to fetch', 'app.js', 3, 1),
  ),
  fx('fetch-404-resource', 'fetch-failed', { ...resource('data/题目.json', 'fetch', 'app.js', 3) }),
  fx('fetch-connection-refused', 'fetch-failed', {
    ...base,
    source: 'resource',
    preview,
    file: 'app.js',
    line: 3,
    code: 'resource-failed',
    message: 'GET http://localhost:3000/api/list net::ERR_CONNECTION_REFUSED',
    resource: {
      requestedUrl: 'http://localhost:3000/api/list',
      resourceType: 'fetch',
      initiatorFile: 'app.js',
      netError: 'net::ERR_CONNECTION_REFUSED',
    },
  }),

  // Rule 11 — CORS
  fx('cors-blocked-fetch', 'cors', {
    ...base,
    source: 'console',
    preview,
    code: 'console.error',
    message:
      "Access to fetch at 'https://api.example.com/weather' from origin 'http://127.0.0.1:51734' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
  }),

  // Rule 12 — JSON parse errors
  fx(
    'json-got-html',
    'json-parse',
    runtime(
      'SyntaxError',
      'Uncaught (in promise) SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON',
      'app.js',
      4,
      1,
    ),
  ),
  fx(
    'json-single-quotes',
    'json-parse',
    runtime(
      'SyntaxError',
      "Uncaught SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)",
      'app.js',
      7,
      19,
    ),
  ),
  fx(
    'json-undefined',
    'json-parse',
    runtime('SyntaxError', 'Uncaught SyntaxError: "undefined" is not valid JSON', 'app.js', 9, 17),
  ),
  fx(
    'json-empty',
    'json-parse',
    runtime('SyntaxError', 'Uncaught SyntaxError: Unexpected end of JSON input', 'app.js', 9, 17),
  ),

  // Rule 13 — not a function
  fx(
    'not-a-function-case',
    'not-a-function',
    runtime('TypeError', 'Uncaught TypeError: document.getElementByID is not a function', 'script.js', 2, 21),
  ),
  fx(
    'not-a-function-typo',
    'not-a-function',
    runtime('TypeError', 'Uncaught TypeError: btn.addEventListner is not a function'),
  ),
  fx(
    'not-a-function-not-array',
    'not-a-function',
    runtime('TypeError', 'Uncaught TypeError: items.map is not a function'),
  ),
  fx('not-a-function-plain', 'not-a-function', runtime('TypeError', 'Uncaught TypeError: greet is not a function'), {
    declaredNames: [{ name: 'greet' }],
  }),

  // S42.3 — pending /ai prompt (NoobIDE's own marker)
  fx('ai-prompt-pending', 'ai-prompt-pending', {
    ...staticMarker('ai-prompt-pending', 'Unfinished /ai prompt', 'index.html', 7, 3),
  }),

  // Rule 14 — unclosed HTML tag
  fx('html-unclosed-div', 'html-unclosed-tag', {
    ...staticMarker('html-unclosed-tag', 'Unclosed element `div`.', 'index.html', 18, 5),
    data: { tagName: 'div' },
  }),

  // Rule 15 — selector guided checks
  fx(
    'selector-unmatched-wrong-prefix',
    'selector-guided-checks',
    {
      ...staticMarker('css-selector-unmatched', 'Selector .hero matches no element in index.html', 'style.css', 10, 1),
      data: { selector: '.hero' },
    },
    { htmlIds: ['hero'], htmlClasses: ['title'] },
  ),
  fx(
    'selector-unmatched-similar',
    'selector-guided-checks',
    {
      ...staticMarker('css-selector-unmatched', 'Selector #mainTitle matches no element', 'style.css', 3, 1),
      data: { selector: '#mainTitle' },
    },
    { htmlIds: ['main-title'], htmlClasses: [] },
  ),
  fx('style-not-applied-guided', 'selector-guided-checks', {
    ...base,
    source: 'static',
    code: 'guided-style-not-applied',
    message: 'User asked: my style is not applied',
  }),
];

export function fixture(name: string): RuleFixture {
  const f = RULE_FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}
