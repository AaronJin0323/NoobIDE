import { describe, expect, it } from 'vitest';
import {
  htmlScriptParts,
  isValidIdentifier,
  planRename,
  positionAt,
  toLocations,
  type NavigationPaths,
  type ServiceSpan,
} from './js-navigation';

const ROOT = 'file:///d%3A/%E7%BD%91%E9%A1%B5/';
const FILES: Record<string, string> = {
  [`${ROOT}config.js`]: 'function greet(name) {\n  return name;\n}\n',
  [`${ROOT}app.js`]: 'greet("a");\nconst x = { greet };\ngreet("b");\n',
};

function paths(files = FILES, complete = true): NavigationPaths {
  return {
    relPathOf: (fileName) => (fileName in files ? fileName.slice(ROOT.length) : null),
    textOf: (fileName) => files[fileName] ?? null,
    complete: () => complete,
    whenIndexed: async () => true,
  };
}

/** Spans of every `greet` in a file. */
function spansOf(fileName: string, extra: Partial<ServiceSpan> = {}): ServiceSpan[] {
  const text = FILES[fileName] ?? '';
  return [...text.matchAll(/greet/g)].map((m) => ({ fileName, textSpan: { start: m.index, length: 5 }, ...extra }));
}

describe('toLocations (S57.1)', () => {
  it('turns service spans into project locations with line, column and the line text, sorted', () => {
    const spans = [...spansOf(`${ROOT}config.js`), ...spansOf(`${ROOT}app.js`)];
    const locations = toLocations(spans, paths());
    expect(locations.map((l) => `${l.relPath}:${l.line}:${l.column}`)).toEqual([
      'app.js:1:1',
      'app.js:2:13',
      'app.js:3:1',
      'config.js:1:10',
    ]);
    expect(locations[3]?.lineText).toBe('function greet(name) {');
  });

  it('drops places outside the project (built-in libraries) and duplicates', () => {
    const builtIn: ServiceSpan = { fileName: 'lib.dom.d.ts', textSpan: { start: 10, length: 3 } };
    const one = spansOf(`${ROOT}config.js`);
    expect(toLocations([builtIn, ...one, ...one], paths())).toHaveLength(1);
  });

  it('counts lines and columns from 1', () => {
    expect(positionAt('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });
});

describe('planRename (S57.2)', () => {
  const locations = [...spansOf(`${ROOT}config.js`), ...spansOf(`${ROOT}app.js`)];
  const input = (over: Partial<Parameters<typeof planRename>[0]> = {}) => ({
    info: { canRename: true, displayName: 'greet' },
    locations,
    newName: 'sayHello',
    paths: paths(),
    htmlPages: [],
    ...over,
  });

  it('computes every file with its changed lines', () => {
    const plan = planRename(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.oldName).toBe('greet');
    expect(plan.files.map((f) => [f.relPath, f.count])).toEqual([
      ['app.js', 3],
      ['config.js', 1],
    ]);
    expect(plan.files[1]?.after).toBe('function sayHello(name) {\n  return name;\n}\n');
    expect(plan.files[0]?.lines.map((l) => l.line)).toEqual([1, 2, 3]);
  });

  it('keeps shorthand properties meaning the same (prefix / suffix text)', () => {
    const app = `${ROOT}app.js`;
    const spans = spansOf(app).map((span, i) => (i === 1 ? { ...span, prefixText: 'greet: ' } : span));
    const plan = planRename(input({ locations: spans }));
    expect(plan.ok && plan.files[0]?.after).toBe('sayHello("a");\nconst x = { greet: sayHello };\nsayHello("b");\n');
  });

  it('refuses what the service cannot resolve with certainty, and says why', () => {
    expect(planRename(input({ info: { canRename: false } }))).toMatchObject({ ok: false, reason: 'not-renamable' });
    expect(planRename(input({ locations: [] }))).toMatchObject({ ok: false, reason: 'not-renamable' });
    // a name of the browser: one of its places is in a built-in library
    const builtIn: ServiceSpan = { fileName: 'lib.dom.d.ts', textSpan: { start: 0, length: 5 } };
    expect(planRename(input({ locations: [...locations, builtIn] }))).toMatchObject({ ok: false, reason: 'built-in' });
    // scripts the service does not see (over the limits)
    expect(planRename(input({ paths: paths(FILES, false) }))).toMatchObject({
      ok: false,
      reason: 'incomplete-project',
    });
    // written in an HTML page too (onclick, inline script): the service does not see HTML
    expect(
      planRename(input({ htmlPages: [{ relPath: 'index.html', text: '<button onclick="greet()">' }] })),
    ).toMatchObject({ ok: false, reason: 'used-in-html', detail: 'index.html' });
    // a place in a file that is not a project script
    const other: ServiceSpan = { fileName: 'file:///elsewhere/x.js', textSpan: { start: 0, length: 5 } };
    expect(planRename(input({ locations: [...locations, other] }))).toMatchObject({
      ok: false,
      reason: 'unknown-file',
    });
    // the service's span and the text disagree (the file changed in between)
    const stale: ServiceSpan = { fileName: `${ROOT}config.js`, textSpan: { start: 1, length: 5 } };
    expect(planRename(input({ locations: [stale] }))).toMatchObject({ ok: false, reason: 'not-renamable' });
  });

  it('refuses names that are not identifiers, reserved words and the same name', () => {
    expect(planRename(input({ newName: 'say hello' }))).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(planRename(input({ newName: 'class' }))).toMatchObject({ ok: false, reason: 'invalid-name' });
    expect(planRename(input({ newName: 'greet' }))).toMatchObject({ ok: false, reason: 'same-name' });
    expect(['问候', '_x', '$el', 'a1'].every(isValidIdentifier)).toBe(true);
    expect(['1a', 'a-b', '', 'let'].some(isValidIdentifier)).toBe(false);
  });

  it('an HTML page that only contains the name inside another word is no reason to refuse', () => {
    const plan = planRename(input({ htmlPages: [{ relPath: 'index.html', text: '<p>greetings</p>' }] }));
    expect(plan.ok).toBe(true);
  });

  it('refuses properties and methods: untyped JavaScript links their uses only by guess', () => {
    expect(planRename(input({ info: { canRename: true, displayName: 'greet', kind: 'property' } }))).toMatchObject({
      ok: false,
      reason: 'property',
    });
    expect(planRename(input({ info: { canRename: true, displayName: 'greet', kind: 'method' } }))).toMatchObject({
      ok: false,
      reason: 'property',
    });
    expect(planRename(input({ info: { canRename: true, displayName: 'greet', kind: 'function' } })).ok).toBe(true);
  });

  it('refuses a new name that is already used (shadowing, another script, the browser)', () => {
    const nameInUse = (name: string) => (name === 'location' ? 'browser' : name === 'total' ? 'app.js' : null);
    expect(planRename(input({ newName: 'location', nameInUse }))).toMatchObject({
      ok: false,
      reason: 'name-taken',
      detail: 'browser',
    });
    expect(planRename(input({ newName: 'total', nameInUse }))).toMatchObject({ ok: false, reason: 'name-taken' });
    expect(planRename(input({ newName: 'sayHello', nameInUse })).ok).toBe(true);
  });

  it('looks for a global only in the JavaScript of HTML pages; locals never block', () => {
    const page = {
      relPath: 'index.html',
      text: '<meta name="viewport" content="width=device-width"><span id="greet">greet</span><p>greet</p>',
    };
    // Markup, ids and text are not code: no refusal.
    expect(planRename(input({ htmlPages: [page] })).ok).toBe(true);
    const inline = { relPath: 'a.html', text: '<script>\n  greet();\n</script>' };
    expect(planRename(input({ htmlPages: [inline] }))).toMatchObject({ ok: false, reason: 'used-in-html' });
    // A local (parameter, local variable) cannot be used from a page.
    const local = { canRename: true, displayName: 'greet', kind: 'local var' };
    expect(planRename(input({ info: local, htmlPages: [inline] })).ok).toBe(true);
    expect(htmlScriptParts('<script src="a.js">x</script><button onclick="go()">')).toBe('"go()"');
  });
});
