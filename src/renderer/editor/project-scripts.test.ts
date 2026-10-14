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
    setLibs: (libs) => published.push([...libs]),
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

  it('closing the project removes every lib and drops reads still in flight', async () => {
    const { scripts, published, files } = setup({ 'a.js': 'x' });
    const opening = scripts.open(files);
    scripts.close();
    await opening;
    expect(published.at(-1)).toEqual([]);
  });
});
