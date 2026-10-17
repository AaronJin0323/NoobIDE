import { describe, expect, it } from 'vitest';
import { MAX_SCRIPTS, MAX_SCRIPT_CHARS, ProjectScripts, isProjectScript, type ScriptHost } from './project-scripts';

function setup(disk: Record<string, string>) {
  const open = new Set<string>();
  const published: { filePath: string; content: string }[][] = [];
  const reads: string[] = [];
  const uri = (rel: string) => `file:///C:/网页 练习/p/${rel}`;
  const host: ScriptHost = {
    read: async (rel) => {
      reads.push(rel);
      return rel in disk ? { text: disk[rel] ?? '', uri: uri(rel) } : null;
    },
    hasModel: (u) => open.has(u),
    libName: (u) => encodeURI(u),
    setLibs: (libs) => {
      published.push([...libs]);
    },
  };
  const scripts = new ProjectScripts(host);
  const files = Object.keys(disk).map((relPath) => ({ relPath, uri: uri(relPath) }));
  return { scripts, open, published, reads, uri, files, disk };
}

const names = (libs: { filePath: string }[] | undefined) => (libs ?? []).map((l) => decodeURI(l.filePath));

describe('ProjectScripts (S18.4)', () => {
  it('only .js and .mjs files are scripts', () => {
    expect(['a.js', 'b.MJS', 'c.css', 'd.json', 'e.html'].filter(isProjectScript)).toEqual(['a.js', 'b.MJS']);
  });

  it('gives the closed scripts of the project to the language service, never an open one', async () => {
    const { scripts, open, published, uri, files } = setup({
      'js/main.js': "import { greet } from './util.mjs';",
      'js/util.mjs': 'export function greet() {}',
      'style.css': 'h1 {}',
    });
    open.add(uri('js/main.js'));
    await scripts.open(files);
    expect(names(published.at(-1))).toEqual(['file:///C:/网页 练习/p/js/util.mjs']);
    expect(published.at(-1)?.[0]?.content).toBe('export function greet() {}');

    open.add(uri('js/util.mjs')); // the user opens util.mjs: its live model replaces the lib
    scripts.modelsChanged();
    expect(published.at(-1)).toEqual([]);
  });

  it('reads a file again when its tab closes, and follows changes on disk', async () => {
    const { scripts, open, published, uri, files, disk } = setup({ 'a.js': 'const a = 1;', 'b.js': 'const b = 1;' });
    open.add(uri('a.js'));
    await scripts.open(files);
    disk['a.js'] = 'const a = 2;';
    open.delete(uri('a.js'));
    await scripts.modelClosed(encodeURI(uri('a.js')));
    expect(published.at(-1)?.find((l) => l.filePath.endsWith('a.js'))?.content).toBe('const a = 2;');

    disk['c.js'] = 'const c = 3;';
    delete disk['b.js'];
    await scripts.changed([
      { type: 'created', relPath: 'c.js' },
      { type: 'deleted', relPath: 'b.js' },
    ]);
    expect(names(published.at(-1)).map((n) => n.slice(n.lastIndexOf('/') + 1))).toEqual(['a.js', 'c.js']);

    await scripts.changed([{ type: 'renamed', from: 'c.js', to: 'd.js', caseOnly: false }]);
    expect(names(published.at(-1)).some((n) => n.endsWith('c.js'))).toBe(false);
  });

  it('does not re-send an unchanged set of libs', async () => {
    const { scripts, published, files } = setup({ 'a.js': 'x' });
    await scripts.open(files);
    const count = published.length;
    scripts.modelsChanged();
    scripts.modelsChanged();
    expect(published.length).toBe(count);
  });

  it('is bounded: too many or too large files are left out', async () => {
    const disk: Record<string, string> = {};
    for (let i = 0; i < MAX_SCRIPTS + 5; i += 1) disk[`f${String(i).padStart(3, '0')}.js`] = 'let x;';
    disk['big.js'] = 'x'.repeat(MAX_SCRIPT_CHARS + 1);
    const { scripts, published, files } = setup(disk);
    await scripts.open(files);
    const libs = published.at(-1) ?? [];
    expect(libs.length).toBe(MAX_SCRIPTS);
    expect(libs.some((l) => l.filePath.endsWith('big.js'))).toBe(false);
  });

  it('S57: maps language-service file names back to project paths and says when scripts were left out', async () => {
    const { scripts, open, uri, files } = setup({ 'js/a.js': 'let a;', 'b.mjs': 'export const b = 1;' });
    open.add(uri('js/a.js'));
    await scripts.open(files);
    expect(scripts.relPathOf(uri('js/a.js'))).toBe('js/a.js'); // an open model's URI
    expect(scripts.relPathOf(encodeURI(uri('b.mjs')))).toBe('b.mjs'); // an extra lib's name
    expect(scripts.relPathOf('lib.dom.d.ts')).toBeNull();
    expect(scripts.complete()).toBe(true);

    const big = setup({ 'a.js': 'let a;', 'big.js': 'x'.repeat(MAX_SCRIPT_CHARS + 1) });
    await big.scripts.open(big.files);
    expect(big.scripts.complete()).toBe(false);
  });

  it('S57: a navigation that arrives while the project is still being read waits for the index', async () => {
    // Reads are gated: the test decides when each file "arrives" from main, like IPC on a slow disk.
    const gates: (() => void)[] = [];
    const disk = { 'app.js': "greet('a');", 'config.js': 'function greet() {}' };
    const { scripts, uri } = setup(disk);
    const slow = new ProjectScripts({
      read: (rel) =>
        new Promise((resolve) => {
          gates.push(() => resolve({ text: disk[rel as keyof typeof disk], uri: uri(rel) }));
        }),
      hasModel: () => false,
      libName: (u) => encodeURI(u),
      setLibs: () => undefined,
    });
    void scripts; // the plain setup is only used for its URI helper
    const files = Object.keys(disk).map((relPath) => ({ relPath, uri: uri(relPath) }));

    expect(slow.indexing()).toBe(false);
    expect(await slow.whenIndexed(1000)).toBe(true); // no project: nothing to wait for
    const opening = slow.open(files);
    expect(slow.indexing()).toBe(true);
    expect(slow.relPathOf(uri('app.js'))).toBeNull(); // this is the false "not found" the wait prevents

    // F12 before any file arrived: the answer is pending, not "not found".
    let settled: boolean | null = null;
    const wait = slow.whenIndexed(10_000).then((ok) => (settled = ok));
    await Promise.resolve();
    expect(settled).toBeNull();

    gates.shift()?.(); // app.js arrives
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBeNull(); // config.js is still missing: still waiting
    gates.shift()?.(); // config.js arrives: the index completes after the command was issued
    await opening;
    expect(await wait).toBe(true);
    expect(slow.indexing()).toBe(false);
    expect(slow.relPathOf(uri('app.js'))).toBe('app.js');
    expect(slow.relPathOf(encodeURI(uri('config.js')))).toBe('config.js');
  });

  it('S57: the index counts as ready only once the service has taken the libs (Monaco posts them on a timer)', async () => {
    let takeLibs: (() => void) | null = null;
    const scripts = new ProjectScripts({
      read: async (rel) => ({ text: 'let x;', uri: `file:///p/${rel}` }),
      hasModel: () => false,
      libName: (u) => u,
      setLibs: (libs) =>
        libs.length === 0
          ? undefined // the clearing publish at open() needs no wait
          : new Promise<void>((resolve) => {
              takeLibs = resolve;
            }),
    });
    let settled: boolean | null = null;
    const opening = scripts.open([{ relPath: 'a.js', uri: 'file:///p/a.js' }]);
    const wait = scripts.whenIndexed(10_000).then((ok) => (settled = ok));
    await new Promise((r) => setTimeout(r, 0));
    expect(takeLibs).not.toBeNull(); // every file is read and the libs are handed over…
    expect(settled).toBeNull(); // …but until the service has them, an answer could still miss a file
    (takeLibs as unknown as () => void)();
    await opening;
    expect(await wait).toBe(true);
  });

  it('S57: the wait is bounded, and a project closed meanwhile releases it', async () => {
    const disk = { 'a.js': 'let a;' };
    const { uri } = setup(disk);
    const files = [{ relPath: 'a.js', uri: uri('a.js') }];
    const never = new ProjectScripts({
      read: () => new Promise(() => undefined),
      hasModel: () => false,
      libName: (u) => u,
      setLibs: () => undefined,
    });
    // A fake clock: the first call starts the wait, the second finds the deadline passed (no real 10 s).
    let t = 0;
    const now = () => (t += 11_000);
    void never.open(files);
    expect(await never.whenIndexed(10_000, now)).toBe(false);

    const closed = new ProjectScripts({
      read: () => new Promise(() => undefined),
      hasModel: () => false,
      libName: (u) => u,
      setLibs: () => undefined,
    });
    void closed.open(files);
    const wait = closed.whenIndexed(10_000);
    closed.close();
    expect(await wait).toBe(true); // nothing left to index: the answer is "not a project script", which is right
  });

  it('closing the project removes every lib and drops reads still in flight', async () => {
    const { scripts, published, files } = setup({ 'a.js': 'x' });
    const opening = scripts.open(files);
    scripts.close();
    await opening;
    expect(published.at(-1)).toEqual([]);
  });
});
