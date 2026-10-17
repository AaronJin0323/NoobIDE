/**
 * Rules 16–25 (S55.2): a positive and a negative fixture per rule (tests/fixtures/beginner-rules, listed in
 * cases.json). Static fixtures go the production way: NoobIDE's beginner check → Monaco-style marker →
 * markerToProblem (renderer/problems/static-problems.ts) → explanation rules. Every explanation is checked against
 * the machine-checkable honesty rules (honesty.ts) in zh-CN and en, and the original message stays verbatim.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemInput, type ProblemRecord } from '../../shared/problem';
import { folderNameIssues } from '../../shared/portability';
import { scanPortability } from '../../workspace/portability-scan';
import { markerToProblem } from '../../renderer/problems/static-problems';
import { checkBeginner, matchReference, type BeginnerFinding } from '../beginner-checks';
import { renderExplanation } from './engine';
import { honestyViolations } from './honesty';
import { explain } from './index';
import type { RuleContext } from './types';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures/beginner-rules');
const read = (name: string) => readFileSync(path.join(dir, name), 'utf8');

interface StaticCase {
  number: number;
  rule: string;
  language: string;
  relPath: string;
  positive: string;
  negative: string;
}
interface RuntimeSide {
  input: ProblemInput;
  ctx: RuleContext;
  expectedRule?: string;
}
interface Cases {
  projectFiles: string[];
  htmlIds: string[];
  htmlClasses: string[];
  static: StaticCase[];
  runtime: { number: number; rule: string; positive: RuntimeSide; negative: RuntimeSide }[];
  casePairs: { reference: string; file: string; caseOnly: boolean; fileNfd?: boolean }[];
}
const cases = JSON.parse(read('cases.json')) as Cases;
const facts = { projectFiles: cases.projectFiles, htmlIds: cases.htmlIds, htmlClasses: cases.htmlClasses };
const ctx: RuleContext = facts;

/** A finding as the editor reports it: a warning marker of owner noobide-beginner, then a static record. */
function record(f: BeginnerFinding, relPath: string): ProblemRecord {
  const marker = {
    owner: 'noobide-beginner',
    severity: 4,
    code: f.code,
    message: f.message,
    startLineNumber: f.line,
    startColumn: f.column,
    endLineNumber: f.line,
    endColumn: f.endColumn,
  };
  const r = markerToProblem(marker, { projectId: 'proj', relPath, at: 1 });
  if (!r) throw new Error('no record');
  return r;
}

function findings(c: StaticCase, side: 'positive' | 'negative') {
  const text = read(c[side]);
  return { text, list: checkBeginner(c.language, text, { ...facts, relPath: c.relPath }) };
}

describe.each(cases.static)('rule $number ($rule)', (c) => {
  it('positive fixture: found, explained by the rule, honest in zh-CN and en, original kept', () => {
    const { list } = findings(c, 'positive');
    const own = list.filter((f) => f.code === c.rule);
    expect(own.length).toBeGreaterThan(0);
    for (const f of own) {
      const r = record(f, c.relPath);
      const exp = explain(r, ctx);
      expect(exp.ruleId).toBe(c.rule);
      expect(honestyViolations(r, exp)).toEqual([]);
      expect(renderExplanation('en', r, exp).original).toBe(f.message);
    }
  });

  it('negative fixture: nothing for this rule', () => {
    const { list } = findings(c, 'negative');
    expect(list.filter((f) => f.code === c.rule)).toEqual([]);
    for (const f of list) expect(explain(record(f, c.relPath), ctx).ruleId).not.toBe(c.rule);
  });
});

describe.each(cases.runtime)('rule $number ($rule)', (c) => {
  it('positive fixture: explained by the rule, honest, original kept', () => {
    const r = createProblemRecord(c.positive.input, 'pos');
    const exp = explain(r, c.positive.ctx);
    expect(exp.ruleId).toBe(c.rule);
    expect(honestyViolations(r, exp)).toEqual([]);
    expect(renderExplanation('zh-CN', r, exp).original).toBe(c.positive.input.message);
  });

  it('negative fixture: left to the existing rule it must not duplicate', () => {
    const r = createProblemRecord(c.negative.input, 'neg');
    expect(explain(r, c.negative.ctx).ruleId).toBe(c.negative.expectedRule);
  });
});

/** The first explained finding of a positive fixture for `rule`. */
function explained(rule: string, side: 'positive' | 'negative' = 'positive', extra: RuleContext = {}) {
  const c = cases.static.find((x) => x.rule === rule)!;
  const list = findings(c, side).list.filter((f) => f.code === rule);
  return list.map((f) => {
    const r = record(f, c.relPath);
    return { finding: f, record: r, exp: explain(r, { ...ctx, ...extra }) };
  });
}
const fixes = (exp: ReturnType<typeof explain>) =>
  exp.actions.filter((a) => a.kind === 'replace-text' || a.kind === 'create-file');

describe('rules 16–25: details and fixes (S55.3 inputs)', () => {
  it('16: a similar file → change the path; nothing similar → create from a template; no file list → no fix', () => {
    const [css, img] = explained('html-broken-ref');
    expect(fixes(img!.exp)).toEqual([
      expect.objectContaining({
        kind: 'replace-text',
        from: 'images/logoo.png',
        to: 'images/logo.png',
        match: 'exact',
      }),
    ]);
    expect(fixes(css!.exp)).toEqual([
      expect.objectContaining({
        kind: 'create-file',
        path: 'css/main.css',
        template: 'css',
        problemFile: 'index.html',
      }),
    ]);
    expect(renderExplanation('zh-CN', css!.record, css!.exp).actions[0]?.label).toBe('新建文件 css/main.css');
    expect(renderExplanation('en', img!.record, img!.exp).actions[0]?.label).toBe('Change the path to images/logo.png');
    expect(fixes(explain(img!.record, {}))).toEqual([]);
    // The folder does not exist: creating would need a new folder too, so it is not offered.
    expect(fixes(explain(css!.record, { projectFiles: ['index.html'] }))).toEqual([]);
    // Two similar names: ambiguous.
    const two = explain(img!.record, { projectFiles: ['images/logo.png', 'images/logos.png'] });
    expect(fixes(two)).toEqual([]);
    expect(two.causes[0]?.key).toBe('brokenRef.cause.several');
  });

  it('17: duplicate id names the first line and offers no fix', () => {
    const [dup] = explained('html-duplicate-id');
    expect(dup!.record.line).toBe(3);
    expect(renderExplanation('zh-CN', dup!.record, dup!.exp).title).toBe(
      'id “hero” 在这个文件里用了不止一次（第一次在第 2 行）。',
    );
    expect(fixes(dup!.exp)).toEqual([]);
  });

  it('18: add alt="" replaces exactly the tag name', () => {
    const [img] = explained('html-img-no-alt');
    expect(fixes(img!.exp)).toEqual([
      expect.objectContaining({
        from: 'img',
        to: 'img alt=""',
        span: expect.objectContaining({ line: 2, column: 4, endColumn: 7 }),
      }),
    ]);
  });

  it('19: </secton> pairs with the never-closed <section>; a closing tag with nothing open has no fix', () => {
    const [close] = explained('html-mismatched-close');
    expect(fixes(close!.exp)).toEqual([expect.objectContaining({ from: 'secton', to: 'section' })]);
    expect(renderExplanation('en', close!.record, close!.exp).actions[0]?.label).toBe('Change </secton> to </section>');
    const stray = checkBeginner('html', '<div></div>\n</span>\n').map((f) => explain(record(f, 'a.html')));
    expect(stray.map((e) => [e.ruleId, e.certainty, fixes(e).length])).toEqual([
      ['html-mismatched-close', 'certain', 0],
    ]);
    const closedLater = checkBeginner('html', '<section>\n</secton>\n</section>\n').map((f) =>
      explain(record(f, 'a.html')),
    );
    expect(closedLater.map((e) => fixes(e).length)).toEqual([0]);
  });

  it('20: the unitless number is located, certain, and no unit is guessed as a fix', () => {
    const [w] = explained('css-unitless-length');
    expect(w!.finding).toMatchObject({ line: 2, column: 10, endColumn: 13 });
    expect(w!.exp.certainty).toBe('certain');
    expect(renderExplanation('en', w!.record, w!.exp).explanation).toContain('You may have meant 100px');
    expect(fixes(w!.exp)).toEqual([]);
    expect(checkBeginner('html', '<style>\n  p { font-size: 16; }\n</style>\n')).toEqual([
      expect.objectContaining({ code: 'css-unitless-length', line: 2, column: 18 }),
    ]);
  });

  it('23: rename to the defined id/class, only when exactly one is defined', () => {
    const [byId, query] = explained('js-selector-prefix');
    expect(fixes(byId!.exp)).toEqual([expect.objectContaining({ from: '#title', to: 'title' })]);
    expect(fixes(query!.exp)).toEqual([expect.objectContaining({ from: 'hero', to: '.hero' })]);
    expect(fixes(explain(query!.record, { htmlIds: ['hero'], htmlClasses: ['hero'] }))).toEqual([]);
    expect(fixes(explain(byId!.record, { htmlIds: [] }))).toEqual([]);
    // Inside a <script> block of an HTML page, too.
    const inline = checkBeginner('html', '<p id="x"></p>\n<script>\n  getElementById(\'#x\');\n</script>\n', facts);
    expect(inline).toEqual([expect.objectContaining({ code: 'js-selector-prefix', line: 3, column: 19 })]);
  });

  it('24: case-only difference → use the exact file name', () => {
    const [ref] = explained('html-ref-case');
    expect(fixes(ref!.exp)).toEqual([expect.objectContaining({ from: 'Images/Logo.PNG', to: 'images/logo.png' })]);
    expect(renderExplanation('zh-CN', ref!.record, ref!.exp).title).toBe(
      'src="Images/Logo.PNG" 和项目里的文件 images/logo.png 只差大小写。',
    );
  });

  it('25: the single = is located; idioms and comparisons are not reported', () => {
    const [a] = explained('js-assign-in-condition');
    expect(a!.finding).toMatchObject({ line: 2, column: 11, endColumn: 12 });
    expect(fixes(a!.exp)).toEqual([]);
  });

  it('paths are resolved from the HTML file, with ../ and root-relative forms, and Chinese names with spaces', () => {
    const html = '<img src="../图片/我的 头像.png" alt="x">\n<img src="/图片/我的 头象.png" alt="y">\n';
    const files = ['pages/a.html', '图片/我的 头像.png'];
    const list = checkBeginner('html', html, { relPath: 'pages/a.html', projectFiles: files });
    expect(list.map((f) => [f.code, f.line])).toEqual([['html-broken-ref', 2]]);
    const exp = explain(record(list[0]!, 'pages/a.html'), { projectFiles: files });
    expect(fixes(exp)).toEqual([expect.objectContaining({ to: '/图片/我的 头像.png' })]);
  });
});

describe('rule 21 takes only the inline-handler case (review fix)', () => {
  it('an undefined name in an inline <script> of a page stays rule 1', () => {
    const r = createProblemRecord(
      {
        source: 'runtime',
        severity: 'error',
        projectId: 'p',
        file: 'index.html',
        line: 20,
        column: 5,
        code: 'ReferenceError',
        message: 'Uncaught ReferenceError: total is not defined',
        stack: 'ReferenceError: total is not defined\n    at http://127.0.0.1:5173/index.html:20:5',
        at: 1,
      },
      'inline-script',
    );
    expect(explain(r).ruleId).toBe('undefined-name');
  });
});

describe('rule 24 agrees with the portability scan (src/workspace/portability-scan.ts)', () => {
  it.each(cases.casePairs)('$reference vs $file', (pair) => {
    const file = pair.fileNfd ? pair.file.normalize('NFD') : pair.file;
    const rule = matchReference(pair.reference, [file]).kind === 'case';
    // The scan's view, segment by segment: names that differ are one name on a case-insensitive volume exactly
    // when folderNameIssues groups them, and a case conflict (not only a Unicode one) makes it a case difference.
    const ref = pair.reference.split('/');
    const actual = file.split('/');
    let grouped = ref.length === actual.length;
    let caseConflict = false;
    ref.forEach((segment, i) => {
      const other = actual[i] ?? '';
      if (segment.normalize('NFC') === other.normalize('NFC')) return;
      const issues = folderNameIssues('', [segment, other]);
      if (issues.some((x) => x.kind === 'case-conflict')) caseConflict = true;
      else if (!issues.some((x) => x.kind === 'unicode-conflict')) grouped = false;
    });
    expect(rule).toBe(pair.caseOnly);
    expect(rule).toBe(grouped && caseConflict);
  });

  it('on the shared case-project fixture: the scan reports no conflict on disk, the rule flags the reference', async () => {
    const root = path.join(dir, 'case-project');
    const report = await scanPortability(root);
    expect(report.issues.filter((i) => i.kind === 'case-conflict')).toEqual([]);
    const list = checkBeginner('html', read('case-project/index.html'), {
      relPath: 'index.html',
      projectFiles: ['index.html', 'images/logo.png'],
    });
    expect(list.map((f) => f.code)).toEqual(['html-ref-case']);
  });
});
