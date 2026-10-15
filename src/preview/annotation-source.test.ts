import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnnotationTarget } from '../shared/ipc/annotations-contract';
import { locateTarget, projectTextReader } from './annotation-source';

let tmp = '';
let root = '';

const target = (over: Partial<AnnotationTarget> & { noId?: true } = {}): AnnotationTarget => {
  const { noId, ...rest } = over;
  const value: AnnotationTarget = {
    kind: 'element',
    pagePath: '页面/首 页.html',
    tag: 'button',
    id: 'send',
    classes: ['cta'],
    text: '发送',
    selector: '#send',
    path: [1, 0, 0],
    ancestry: [
      { tag: 'html', nth: 1 },
      { tag: 'body', nth: 1 },
      { tag: 'main', nth: 1 },
      { tag: 'button', nth: 1 },
    ],
    rect: { x: 0, y: 0, width: 10, height: 10 },
    viewport: { width: 800, height: 600 },
    rules: [
      { sheet: { kind: 'file', path: '页面/样式 表.css' }, selector: '.cta', occurrence: 1 },
      { sheet: { kind: 'style', index: 0 }, selector: '#send', occurrence: 1 },
      { sheet: { kind: 'file', path: '../outside.css' }, selector: '.cta', occurrence: 1 },
      { sheet: { kind: 'file', path: '.secret.css' }, selector: '.cta', occurrence: 1 },
    ],
    ...rest,
  };
  if (!noId) return value;
  const { id: _id, ...withoutId } = value;
  return withoutId;
};

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'noobide-annot-'));
  root = path.join(tmp, '我的 项目');
  await mkdir(path.join(root, '页面'), { recursive: true });
  await writeFile(
    path.join(root, '页面', '首 页.html'),
    '<!doctype html>\r\n<head>\r\n<link rel="stylesheet" href="样式 表.css">\r\n<style>\r\n#send { color: red; }\r\n</style>\r\n</head>\r\n<main>\r\n  <button id="send" class="cta">发送</button>\r\n</main>\r\n',
  );
  await writeFile(path.join(root, '页面', '样式 表.css'), 'body { margin: 0 }\n\n.cta {\n  padding: 4px;\n}\n');
  await writeFile(path.join(root, '.secret.css'), '.cta { color: blue }');
  await writeFile(path.join(tmp, 'outside.css'), '.cta { color: blue }');
  root = await realpath(root);
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('locateTarget (S41.2)', () => {
  it('finds the element and its CSS rules in files whose paths have Chinese characters and spaces', async () => {
    const source = await locateTarget(target(), projectTextReader(root));
    expect(source.state).toBe('found');
    expect(source.html).toEqual({ relPath: '页面/首 页.html', startLine: 9, endLine: 9, match: 'exact' });
    expect(source.css).toEqual([
      { relPath: '页面/样式 表.css', startLine: 3, endLine: 5, match: 'exact', selector: '.cta' },
      { relPath: '页面/首 页.html', startLine: 5, endLine: 5, match: 'exact', selector: '#send' },
    ]);
  });

  it('never reads outside the project or dotfiles', async () => {
    const source = await locateTarget(target(), projectTextReader(root));
    expect(source.css.map((c) => c.relPath)).not.toContain('../outside.css');
    expect(source.css.map((c) => c.relPath)).not.toContain('.secret.css');
    const outside = await locateTarget(target({ pagePath: '../outside.css' }), projectTextReader(root));
    expect(outside.state).toBe('no-file');
  });

  it('the index page is found for an empty path; a missing element says not-found', async () => {
    await writeFile(path.join(root, 'index.html'), '<p>hi</p>');
    const source = await locateTarget(
      target({
        pagePath: '',
        rules: [],
        ancestry: [{ tag: 'p', nth: 1 }],
        tag: 'p',
        noId: true,
        classes: [],
        text: 'bye',
      }),
      projectTextReader(root),
    );
    expect(source).toEqual({ state: 'not-found', html: null, css: [] });
  });
});
