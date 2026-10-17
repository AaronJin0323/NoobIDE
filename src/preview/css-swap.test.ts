import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isCssPath,
  matchSheets,
  parseSheetHeader,
  projectPathOfSheet,
  readSavedStylesheets,
  scanCss,
  swapProblemMessage,
  swapStylesheets,
  type SheetHeader,
  type SwapDebugger,
} from './css-swap';

const ORIGIN = 'http://127.0.0.1:51734';

describe('isCssPath', () => {
  it('only .css files, any case', () => {
    expect(isCssPath('style.css')).toBe(true);
    expect(isCssPath('样式 表/主题.CSS')).toBe(true);
    expect(isCssPath('index.html')).toBe(false);
    expect(isCssPath('app.js')).toBe(false);
    expect(isCssPath('style.css.bak')).toBe(false);
    expect(isCssPath('scss/a.scss')).toBe(false);
  });
});

describe('scanCss', () => {
  it('accepts ordinary stylesheets, comments and strings with braces', () => {
    expect(scanCss('body { color: red; }\n/* { */\na::after { content: "}"; }\n')).toEqual({
      syntax: null,
      hasImport: false,
    });
    expect(scanCss("@media (max-width: 600px) { .a { b: c } }\n.q { content: 'it\\'s' }").syntax).toBeNull();
    expect(scanCss('').syntax).toBeNull();
  });

  it('finds an unclosed block at the line where it opened', () => {
    expect(scanCss('a { color: red; }\nbody {\n  color: blue;\n').syntax).toEqual({ kind: 'unclosed-block', line: 2 });
  });

  it('finds a stray closing brace', () => {
    expect(scanCss('a { color: red; }\n}\n').syntax).toEqual({ kind: 'unexpected-close', line: 2 });
  });

  it('finds an unclosed comment and an unclosed string', () => {
    expect(scanCss('a {}\n/* never closed\n b {}').syntax).toEqual({ kind: 'unclosed-comment', line: 2 });
    expect(scanCss('a {\n content: "oops;\n}\n').syntax).toEqual({ kind: 'unclosed-string', line: 2 });
  });

  it('counts lines inside comments and multi-line constructs (CRLF too)', () => {
    expect(scanCss('/* a\r\nb\r\nc */\r\nx {').syntax).toEqual({ kind: 'unclosed-block', line: 4 });
  });

  it('notices @import outside comments and strings only', () => {
    expect(scanCss('@import url("base.css");\nbody{}').hasImport).toBe(true);
    expect(scanCss('@IMPORT "x.css";').hasImport).toBe(true);
    expect(scanCss('/* @import "x.css"; */ a { content: "@import" }').hasImport).toBe(false);
    expect(scanCss('@importance {}').hasImport).toBe(false);
  });
});

describe('parseSheetHeader / projectPathOfSheet', () => {
  it('reads the fields it needs and nothing else', () => {
    expect(
      parseSheetHeader({
        styleSheetId: '1',
        sourceURL: `${ORIGIN}/a.css`,
        frameId: 'F',
        ownerNode: 5,
        origin: 'regular',
      }),
    ).toEqual({ styleSheetId: '1', sourceURL: `${ORIGIN}/a.css`, frameId: 'F', ownerNode: 5 });
    expect(parseSheetHeader({ styleSheetId: 1 })).toBeNull();
    // A sheet that names itself with /*# sourceURL= */ is not the file it claims to be.
    expect(
      parseSheetHeader({
        styleSheetId: '1',
        sourceURL: `${ORIGIN}/a.css`,
        frameId: 'F',
        ownerNode: 5,
        hasSourceURL: true,
      }),
    ).toBeNull();
    expect(parseSheetHeader(null)).toBeNull();
  });

  it('maps only the preview origin, decodes, ignores query and hash', () => {
    expect(projectPathOfSheet(`${ORIGIN}/%E6%A0%B7%E5%BC%8F%20%E8%A1%A8/main.css?v=2#x`, ORIGIN)).toBe(
      '样式 表/main.css',
    );
    expect(projectPathOfSheet('https://cdn.example.com/a.css', ORIGIN)).toBeNull();
    expect(projectPathOfSheet('', ORIGIN)).toBeNull();
  });
});

describe('matchSheets', () => {
  const link = (id: string, path: string, frameId = 'MAIN'): SheetHeader => ({
    styleSheetId: id,
    sourceURL: `${ORIGIN}/${encodeURI(path)}`,
    frameId,
    ownerNode: 10,
  });

  it('every saved file must be linked from the main frame', () => {
    const headers = [link('1', 'style.css'), link('2', '主题/颜色.css'), link('3', 'style.css')];
    const match = matchSheets(headers, ['style.css', '主题\\颜色.css'], ORIGIN, 'MAIN');
    expect(match.ok && [...match.sheets.entries()]).toEqual([
      ['style.css', ['1', '3']],
      ['主题/颜色.css', ['2']],
    ]);
    expect(matchSheets(headers, ['other.css'], ORIGIN, 'MAIN')).toEqual({ ok: false, reason: 'not-linked' });
  });

  it('a sheet in an iframe or pulled in by @import reloads', () => {
    expect(matchSheets([link('1', 'a.css'), link('2', 'a.css', 'FRAME')], ['a.css'], ORIGIN, 'MAIN')).toEqual({
      ok: false,
      reason: 'frame',
    });
    const imported: SheetHeader = { styleSheetId: '9', sourceURL: `${ORIGIN}/b.css`, frameId: 'MAIN' };
    expect(matchSheets([imported], ['b.css'], ORIGIN, 'MAIN')).toEqual({ ok: false, reason: 'import' });
  });

  it('inline <style> sheets never match', () => {
    const inline: SheetHeader = { ...link('1', 'index.html'), isInline: true };
    expect(matchSheets([inline], ['index.html'], ORIGIN, 'MAIN')).toEqual({ ok: false, reason: 'not-linked' });
  });
});

type Listener = (event: unknown, method: string, params: unknown, sessionId?: string) => void;

function fakeDebugger(options: {
  headers: unknown[];
  failOn?: string;
  hangOn?: string;
}): SwapDebugger & { calls: { method: string; params?: object }[] } {
  const listeners = new Set<Listener>();
  const calls: { method: string; params?: object }[] = [];
  return {
    calls,
    isAttached: () => true,
    on: (_e, l) => void listeners.add(l),
    off: (_e, l) => void listeners.delete(l),
    async sendCommand(method, params) {
      calls.push(params === undefined ? { method } : { method, params });
      if (method === options.failOn) throw new Error('nope');
      if (method === options.hangOn) return new Promise(() => undefined);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'MAIN' } } };
      if (method === 'CSS.enable') {
        for (const header of options.headers) for (const l of listeners) l({}, 'CSS.styleSheetAdded', { header });
        // a child target's sheet is ignored
        for (const l of listeners) {
          l(
            {},
            'CSS.styleSheetAdded',
            { header: { styleSheetId: 'W', sourceURL: `${ORIGIN}/a.css`, frameId: 'X' } },
            'child',
          );
        }
      }
      return {};
    },
  };
}

const useDom = <T>(work: () => Promise<T>) => work();
const LIMITS = { maxBytes: 1024, commandTimeoutMs: 50, totalTimeoutMs: 200 };

describe('swapStylesheets', () => {
  const header = { styleSheetId: 'S1', sourceURL: `${ORIGIN}/a.css?x=1`, frameId: 'MAIN', ownerNode: 3 };

  it('replaces the linked sheet text and disables the CSS domain again', async () => {
    const dbg = fakeDebugger({ headers: [header] });
    const result = await swapStylesheets(dbg, [{ relPath: 'a.css', text: 'h1 { color: red }' }], {
      origin: ORIGIN,
      useDom,
      limits: LIMITS,
    });
    expect(result).toEqual({ ok: true, sheets: 1 });
    expect(dbg.calls.map((c) => c.method)).toEqual([
      'Page.getFrameTree',
      'CSS.enable',
      'CSS.setStyleSheetText',
      'CSS.disable',
    ]);
    expect(dbg.calls[2]?.params).toEqual({ styleSheetId: 'S1', text: 'h1 { color: red }' });
    // No page-world evaluation of any kind.
    expect(dbg.calls.some((c) => c.method.startsWith('Runtime.'))).toBe(false);
  });

  it('broken or @import CSS never reaches the page', async () => {
    const dbg = fakeDebugger({ headers: [header] });
    expect(
      await swapStylesheets(dbg, [{ relPath: 'a.css', text: 'h1 {\n color: red' }], { origin: ORIGIN, useDom }),
    ).toEqual({
      ok: false,
      reason: 'syntax',
      file: 'a.css',
      line: 1,
      kind: 'unclosed-block',
    });
    expect(
      await swapStylesheets(dbg, [{ relPath: 'a.css', text: '@import "b.css";' }], { origin: ORIGIN, useDom }),
    ).toEqual({
      ok: false,
      reason: 'import',
      file: 'a.css',
    });
    expect(dbg.calls).toEqual([]);
  });

  it('a file the page does not link, a failing or hanging command, or no protocol: reload', async () => {
    const files = [{ relPath: 'a.css', text: 'a{}' }];
    expect(
      await swapStylesheets(fakeDebugger({ headers: [] }), files, { origin: ORIGIN, useDom, limits: LIMITS }),
    ).toEqual({
      ok: false,
      reason: 'not-linked',
    });
    const failing = fakeDebugger({ headers: [header], failOn: 'CSS.setStyleSheetText' });
    expect(await swapStylesheets(failing, files, { origin: ORIGIN, useDom, limits: LIMITS })).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(failing.calls.at(-1)?.method).toBe('CSS.disable');
    const hanging = fakeDebugger({ headers: [header], hangOn: 'CSS.enable' });
    expect(await swapStylesheets(hanging, files, { origin: ORIGIN, useDom, limits: LIMITS })).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(await swapStylesheets(null, files, { origin: ORIGIN, useDom })).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('readSavedStylesheets', () => {
  it('reads inside the root only, strips a BOM, refuses dotfiles, traversal and big files', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'noobide-css-'));
    try {
      const root = await realpath(path.join(tmp));
      await mkdir(path.join(root, '样式 表'));
      await writeFile(path.join(root, '样式 表', '主题.css'), '﻿a { color: red }');
      await writeFile(path.join(root, '.hidden.css'), 'a{}');
      await writeFile(path.join(root, 'big.css'), 'x'.repeat(2048));
      expect(await readSavedStylesheets(root, ['样式 表/主题.css'])).toEqual({
        ok: true,
        files: [{ relPath: '样式 表/主题.css', text: 'a { color: red }' }],
      });
      expect((await readSavedStylesheets(root, ['样式 表\\主题.css'])).ok).toBe(true);
      // The server would never serve these, so the page cannot link them.
      expect(await readSavedStylesheets(root, ['.hidden.css'])).toMatchObject({ ok: false, reason: 'not-linked' });
      expect(await readSavedStylesheets(root, ['../outside.css'])).toMatchObject({ ok: false, reason: 'not-linked' });
      expect(await readSavedStylesheets(root, ['missing.css'])).toMatchObject({ ok: false, reason: 'failed' });
      expect(await readSavedStylesheets(root, ['big.css'], 1024)).toMatchObject({ ok: false, reason: 'failed' });
      // GBK bytes ("中" = D6 D0) are not UTF-8: reload, never swap in garbled text.
      await writeFile(path.join(root, 'gbk.css'), Buffer.from([0x61, 0x7b, 0x7d, 0x2f, 0x2a, 0xd6, 0xd0, 0x2a, 0x2f]));
      expect(await readSavedStylesheets(root, ['gbk.css'])).toEqual({ ok: false, reason: 'failed', file: 'gbk.css' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('swapProblemMessage', () => {
  it('names the file and line in both languages, never CSS text', () => {
    const zh = swapProblemMessage('zh-CN', { reason: 'syntax', file: 'a.css', kind: 'unclosed-block', line: 4 });
    expect(zh).toMatch(/^NoobIDE：a\.css 第 4 行有 CSS 语法错误（有一个 \{ 没有对应的 \}）/u);
    const en = swapProblemMessage('en', { reason: 'syntax', file: 'a.css', kind: 'unclosed-string', line: 2 });
    expect(en).toMatch(/^NoobIDE: CSS syntax error in a\.css line 2 \(a quoted text is not closed\)/u);
    expect(swapProblemMessage('en', { reason: 'failed', file: 'b.css' })).toContain('b.css could not be applied');
  });
});
