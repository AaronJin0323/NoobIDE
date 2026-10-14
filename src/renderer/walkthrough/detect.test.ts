import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProblemRecord, type ProblemRecord } from '../../shared/problem';
import {
  STEP_FILES,
  declarations,
  fileStepDone,
  headingText,
  misspelledNameReported,
  paragraphCount,
  roleFilesOpened,
  stringLiterals,
  taskDone,
  taskSignature,
} from './detect';

const templates = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../resources/templates');
const read = (template: string, file: string) => readFileSync(path.join(templates, template, file), 'utf8');
const TEMPLATES = ['personal-intro', 'product-showcase', 'button-counter'];

const problem = (over: Partial<Parameters<typeof createProblemRecord>[0]>): ProblemRecord =>
  createProblemRecord({
    source: 'static',
    severity: 'error',
    projectId: 'p',
    file: 'script.js',
    line: 3,
    column: 13,
    code: '2552',
    message: "Cannot find name 'userNmae'. Did you mean 'userName'?",
    at: 1,
    ...over,
  });

const signature = (step: 'heading' | 'style' | 'interaction', text: string) =>
  (STEP_FILES[step] as { signature(text: string): string }).signature(text);

describe('step detection (S23.2)', () => {
  it('reads the heading text, ignoring comments and inner tags', () => {
    expect(headingText(read('personal-intro', 'index.html'))).toBe('你好，我是小雨');
    expect(headingText('<!-- <h1>old</h1> --><h1 class="x">  林 <em>小雨</em>\n</h1>')).toBe('林 小雨');
    expect(headingText('<p>no heading</p>')).toBe('');
  });

  it('heading: done when the saved heading differs from the start and is not empty', () => {
    const html = read('personal-intro', 'index.html');
    const base = signature('heading', html);
    expect(fileStepDone('heading', base, base)).toBe(false);
    const changed = html.replace('你好，我是小雨', '你好，我是林小雨');
    expect(fileStepDone('heading', base, signature('heading', changed))).toBe(true);
    expect(fileStepDone('heading', base, signature('heading', html.replace('你好，我是小雨', '')))).toBe(false);
    // other edits in the page do not count
    expect(fileStepDone('heading', base, signature('heading', html.replace('画画', '跑步')))).toBe(false);
  });

  it('style: done when a colour or font size changes; comments and spacing do not count', () => {
    const css = read('personal-intro', 'style.css');
    const base = signature('style', css);
    expect(fileStepDone('style', base, signature('style', css.replace('color: #2563eb;', 'color: #db2777;')))).toBe(
      true,
    );
    expect(fileStepDone('style', base, signature('style', css.replace('font-size: 32px;', 'font-size: 40px;')))).toBe(
      true,
    );
    expect(fileStepDone('style', base, signature('style', `/* 注释 */\n${css}`))).toBe(false);
    expect(fileStepDone('style', base, signature('style', css.replace('margin: 0;', 'margin: 4px;')))).toBe(false);
    expect(declarations('h1 { color : Red ; }', /^color$/)).toEqual(['h1{color:red}']);
  });

  it('interaction: done when a string literal changes and the script has no error', () => {
    const js = read('personal-intro', 'script.js');
    const base = signature('interaction', js);
    const changed = js.replace('很高兴认识你', '欢迎来到我的主页');
    expect(fileStepDone('interaction', base, signature('interaction', changed))).toBe(true);
    expect(fileStepDone('interaction', base, signature('interaction', `// 只改注释\n${js}`))).toBe(false);
    expect(fileStepDone('interaction', base, signature('interaction', changed), [problem({})])).toBe(false);
    expect(stringLiterals("const a = 'x'; // 'not this'\nconst b = \"y\"; /* 'nor this' */ `z`")).toEqual([
      'x',
      'y',
      'z',
    ]);
  });

  it.each(TEMPLATES)('every template has what the file steps change (%s)', (template) => {
    expect(headingText(read(template, 'index.html'))).not.toBe('');
    expect(JSON.parse(signature('style', read(template, 'style.css')))).not.toEqual([]);
    expect(JSON.parse(signature('interaction', read(template, 'script.js')))).toBeInstanceOf(Array);
  });

  it('deliberate error: a misspelled-name problem in a script is recognised; other problems are not', () => {
    expect(misspelledNameReported([problem({})])).toBe(true);
    expect(misspelledNameReported([problem({ code: '2304', message: "Cannot find name 'cuont'." })])).toBe(true);
    expect(
      misspelledNameReported([
        problem({ source: 'runtime', code: 'ReferenceError', message: 'userNmae is not defined' }),
      ]),
    ).toBe(true);
    expect(misspelledNameReported([problem({ severity: 'warning' })])).toBe(false);
    expect(misspelledNameReported([problem({ file: 'style.css', code: 'unknownProperties' })])).toBe(false);
    expect(misspelledNameReported([problem({ code: '1005', message: "';' expected." })])).toBe(false);
    expect(misspelledNameReported([])).toBe(false);
  });

  it('meet the files: done once index.html, style.css and script.js have been opened', () => {
    expect(roleFilesOpened(['index.html', 'style.css'])).toBe(false);
    expect(roleFilesOpened(['script.js', 'index.html', 'style.css', 'images/a.svg'])).toBe(true);
  });
});

describe('final task detection (S23.3)', () => {
  const html = read('personal-intro', 'index.html');
  const css = read('personal-intro', 'style.css');
  const base = taskSignature(html, css);
  const moreHtml = html.replace('</main>', '  <p class="me">我喜欢做网页。</p>\n    </main>');

  it('counts paragraphs outside comments', () => {
    expect(paragraphCount('<p>a</p><!-- <p>b</p> --><P class="x">c</P><pre>no</pre><param>')).toBe(2);
  });

  it('needs both a new paragraph and a new or changed colour', () => {
    expect(taskDone(base, base)).toBe(false);
    expect(taskDone(base, taskSignature(moreHtml, css))).toBe(false);
    expect(taskDone(base, taskSignature(html, `${css}\n.me { color: #16a34a; }\n`))).toBe(false);
    expect(taskDone(base, taskSignature(moreHtml, `${css}\n.me { color: #16a34a; }\n`))).toBe(true);
    expect(taskDone(base, taskSignature(moreHtml, css.replace('color: #52606d;', 'color: purple;')))).toBe(true);
  });

  it('a broken baseline never reports done', () => {
    expect(taskDone('not json', taskSignature(moreHtml, `${css} p{color:red}`))).toBe(false);
  });
});
