import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchProject } from '../../src/workspace/project-search';
import type { OpenBuffer, SearchResults } from '../../src/shared/ipc/search-contract';
import type { SearchQuery } from '../../src/shared/search';

/**
 * S51.2 project search on the real file system, in a project whose path has Chinese characters and spaces: root
 * containment, ignore rules, binary and oversized files, the match cap, open buffers winning over disk, cancellation,
 * and the 2 000-file fixture (its timing budget: tests/perf/project-search.perf.test.ts).
 */
let tmp: string;
let root: string;
let outside: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'noobide-search-')));
  root = path.join(tmp, '网页 练习', '中文 路径 项目');
  outside = path.join(tmp, '外面');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const q = (text: string, options: Partial<SearchQuery> = {}): SearchQuery => ({
  text,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  ...options,
});

async function write(relPath: string, content: string | Uint8Array, base = root): Promise<void> {
  const full = path.join(base, ...relPath.split('/'));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function search(
  query: SearchQuery,
  buffers: OpenBuffer[] = [],
  options: Parameters<typeof searchProject>[4] = {},
): Promise<SearchResults> {
  const result = await searchProject(root, 1, query, buffers, options);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}

const paths = (results: SearchResults) => results.files.map((f) => f.relPath);

describe('project search (S51.2)', () => {
  it('groups matches by project-relative path with line, column and a context line', async () => {
    await write('index.html', '<h1 class="card">你好</h1>\n<div class="card card-body">\n');
    await write('子 文件夹/页面 二.html', '<p>\n  <span class="card">林小雨</span>\n</p>\n');
    const results = await search(q('card'));
    expect(paths(results)).toEqual(['index.html', '子 文件夹/页面 二.html']);
    expect(results.totalMatches).toBe(4);
    const [index, page] = results.files;
    expect(index?.matches.map((m) => [m.line, m.column, m.length])).toEqual([
      [1, 12, 4],
      [2, 13, 4],
      [2, 18, 4],
    ]);
    expect(index?.source).toBe('disk');
    const span = page?.matches[0];
    expect(span).toMatchObject({ line: 2, column: 16, length: 4 });
    // The context line, leading indentation trimmed, with the match position inside it.
    expect(span?.preview).toBe('<span class="card">林小雨</span>');
    expect(span?.preview.slice(span.previewStart, span.previewStart + 4)).toBe('card');
    expect(results.truncated).toBe(false);
  });

  it('honours ignore.ts: dotfiles, node_modules, OS litter and NoobIDE temporaries are not searched', async () => {
    await write('style.css', '.card {}');
    await write('.noobide/project.json', '{"card": 1}');
    await write('.git/config', 'card');
    await write('node_modules/lib/index.js', 'card');
    await write('Thumbs.db', 'card');
    await write('style.css.noobide-tmp', 'card');
    await write('.hidden.html', 'card');
    expect(paths(await search(q('card')))).toEqual(['style.css']);
  });

  it('skips binary files, files that are not UTF-8 and files over the size cap, and counts them', async () => {
    await write('page.html', 'card');
    await write('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x63, 0x61, 0x72, 0x64]));
    // "卡片 card" in GB18030 (not UTF-8): skipped, never mis-decoded.
    await write('legacy.txt', new Uint8Array([0xbf, 0xa8, 0xc6, 0xac, 0x20, 0x63, 0x61, 0x72, 0x64]));
    await write('big.css', `${'x'.repeat(2000)}card`);
    const results = await search(q('card'), [], { maxFileBytes: 1000 });
    expect(paths(results)).toEqual(['page.html']);
    expect(results.skippedBinary).toBe(2);
    expect(results.skippedLarge).toBe(1);
    expect(results.filesSearched).toBe(1);
  });

  it('stays inside the realpath-checked project root: links to outside are never followed', async () => {
    await write('index.html', 'card');
    await write('secret.txt', 'card', outside);
    await write('more/secret.txt', 'card', outside);
    let linked = true;
    try {
      await symlink(path.join(outside, 'more'), path.join(root, 'escape'), 'junction');
    } catch {
      linked = false; // no link support on this file system: the walk test below still runs
    }
    try {
      await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    } catch {
      // file symlinks need a privilege on Windows; the junction above covers the folder case
    }
    // A link inside the project to a folder inside the project is followed once (no loop).
    await write('real/inner.html', 'card');
    try {
      await symlink(path.join(root, 'real'), path.join(root, 'alias'), 'junction');
      await symlink(root, path.join(root, 'real', 'loop'), 'junction');
    } catch {
      // as above
    }
    const results = await search(q('card'));
    expect(paths(results)).not.toContain('escape/secret.txt');
    expect(paths(results)).not.toContain('escape.txt');
    expect(paths(results).every((p) => !p.includes('secret'))).toBe(true);
    expect(paths(results)).toContain('index.html');
    expect(paths(results).filter((p) => p.endsWith('inner.html'))).toHaveLength(1);
    expect(linked || results.files.length > 0).toBe(true);
  });

  it('caps the total matches and says the results are truncated', async () => {
    for (let i = 0; i < 5; i += 1) await write(`p${i}.html`, 'card card\ncard\n');
    const results = await search(q('card'), [], { maxMatches: 7 });
    expect(results.totalMatches).toBe(7);
    expect(results.truncated).toBe(true);
    // Deterministic: path order, cut at the cap.
    expect(paths(results)).toEqual(['p0.html', 'p1.html', 'p2.html']);
    expect(results.files[2]?.matches).toHaveLength(1);
  });

  it('open buffers are searched from memory and win over the disk content', async () => {
    await write('index.html', '<p class="card">old</p>');
    await write('about.html', '<p class="card">about</p>');
    const buffers = [
      { relPath: 'index.html', text: '<p class="panel">unsaved</p>' },
      { relPath: '新 页面.html', text: '<div class="panel"></div>' }, // open, not on disk (yet)
    ];
    const card = await search(q('card'), buffers);
    expect(paths(card)).toEqual(['about.html']);
    const panel = await search(q('panel'), buffers);
    expect(paths(panel)).toEqual(['index.html', '新 页面.html']);
    expect(panel.files.map((f) => f.source)).toEqual(['buffer', 'buffer']);
    expect(panel.files[0]?.fingerprint).not.toBe(card.files[0]?.fingerprint);
  });

  it('returns invalid-regex as a typed error', async () => {
    await write('index.html', 'card');
    const result = await searchProject(root, 3, q('[unclosed', { regex: true }), []);
    expect(result).toMatchObject({ ok: false, code: 'invalid-regex' });
  });

  it('an aborted search answers cancelled', async () => {
    for (let i = 0; i < 100; i += 1) await write(`f${i}.html`, 'card');
    const controller = new AbortController();
    const running = searchProject(root, 4, q('card'), [], { signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('2 000 files with Chinese names and spaces: every file is searched, hits are listed, a common word hits the cap', async () => {
    // The S51.2 timing budget on this fixture (under 1 s, main never blocked for more than 100 ms) is measured in
    // tests/perf/project-search.perf.test.ts (S58.3, ADR 0038: enforced on developer machines, reported on CI).
    const line = '<div class="card 卡片">林小雨的 网页 practice line with some words</div>\n';
    const body = line.repeat(60); // ~4 KB per file, 8 MB in all
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const folder = `栏目 ${i % 20}/子 目录 ${i % 7}`;
      writes.push(write(`${folder}/页面 ${i}.html`, i % 10 === 0 ? `${body}<p>needle 针</p>\n` : body));
    }
    await Promise.all(writes);

    const results = await search(q('needle 针'));
    expect(results.filesSearched).toBe(2000);
    expect(results.files).toHaveLength(200);
    expect(results.files.every((f) => f.relPath.includes('栏目 ') && f.relPath.endsWith('.html'))).toBe(true);
    expect(results.truncated).toBe(false);

    // A common word with thousands of matches is cut at the cap.
    const common = await search(q('card'));
    expect(common.truncated).toBe(true);
    expect(common.totalMatches).toBe(2000);
  }, 60_000);
});

describe('project search under a slow regular expression (S51.6)', () => {
  const evil = q('(a+)+$', { regex: true });

  it('stops a catastrophically backtracking pattern after the per-file limit with regex-too-slow', async () => {
    await write('index.html', `<p>card</p>\n${'a'.repeat(40)}!\n`);
    // The event loop is blocked at most about the per-file limit, never for the pattern's full run (hours).
    let lastTick = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
    }, 5);
    const started = performance.now();
    const result = await searchProject(root, 5, evil, [], { regexFileBudgetMs: 100 });
    const elapsed = performance.now() - started;
    clearInterval(timer);
    expect(result).toMatchObject({ ok: false, code: 'regex-too-slow' });
    expect(elapsed).toBeLessThan(2000);
    expect(maxGap).toBeLessThan(1000);
  });

  it('applies the limit to open buffers too, and with the default limits', async () => {
    const result = await searchProject(root, 6, evil, [{ relPath: 'a.js', text: `${'a'.repeat(40)}!` }]);
    expect(result).toMatchObject({ ok: false, code: 'regex-too-slow' });
  });

  it('a total budget stops a pattern that is slow on every file, never reporting partial results', async () => {
    // Long text the pattern has to scan, with one match at the end (well under the match cap).
    const line = 'the price times the count gives the total 价格 card\n';
    const big = `${line.repeat(Math.floor(500_000 / line.length))}total = price\n`;
    await write('a.js', big);
    await write('b.js', big);
    const pattern = q('\\w+\\s*=\\s*\\w+', { regex: true });
    expect((await search(pattern)).files.map((f) => f.relPath)).toEqual(['a.js', 'b.js']);
    // Matching a.js takes longer than 1 ms, so the budget is spent before b.js.
    const result = await searchProject(root, 7, pattern, [], { regexTotalBudgetMs: 1, regexFileBudgetMs: 60_000 });
    expect(result).toMatchObject({ ok: false, code: 'regex-too-slow' });
  });

  it('gives the event loop a turn after each slow file, not only between batches', async () => {
    const buffers = Array.from({ length: 64 }, (_, i) => ({ relPath: `f${i}.js`, text: 'card\n'.repeat(10) }));
    // S58.10: counts the turns the search itself gives (its setImmediate calls) instead of racing a free-running
    // tick loop, whose count depended on how busy the machine was (hosted Windows measured slow − normal = −87).
    const yieldsDuring = async (yieldAfterMs: number | undefined) => {
      const spy = vi.spyOn(globalThis, 'setImmediate');
      try {
        const result = await searchProject(
          root,
          8,
          q('card'),
          buffers,
          yieldAfterMs === undefined ? {} : { yieldAfterMs },
        );
        expect(result.ok).toBe(true);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    const normal = await yieldsDuring(undefined);
    // Every file counts as slow (-1 ms): one more turn after each of the 64 files, on top of one per batch.
    const slow = await yieldsDuring(-1);
    expect(slow - normal).toBe(64);
  });
});
