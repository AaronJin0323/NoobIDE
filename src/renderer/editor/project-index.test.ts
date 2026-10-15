import { describe, expect, it } from 'vitest';
import { MAX_INDEXED_CHARS, MAX_INDEXED_FILES, ProjectIndex, indexedLanguage } from './project-index';

const FOUR =
  '<main>\n    <section>\n        <h2>A</h2>\n        <ul>\n            <li>1</li>\n            <li>2</li>\n        </ul>\n        <p>x</p>\n    </section>\n    <footer>f</footer>\n</main>\n';

function setup(disk: Record<string, string>) {
  const reads: string[] = [];
  const index = new ProjectIndex({
    read: async (relPath) => {
      reads.push(relPath);
      return relPath in disk ? { text: disk[relPath] ?? '' } : null;
    },
  });
  const files = Object.keys(disk).map((relPath) => ({ relPath, uri: `file:///C:/网页 练习/p/${relPath}` }));
  return { index, reads, files, disk };
}

const names = (map: ReadonlyMap<string, readonly string[]>) => Object.fromEntries(map);

describe('ProjectIndex (S43.4)', () => {
  it('indexes HTML, CSS and JavaScript only', () => {
    expect(['a.html', 'b.HTM', 'c.css', 'd.js', 'e.mjs', 'f.png', 'g.json'].map(indexedLanguage)).toEqual([
      'html',
      'html',
      'css',
      'javascript',
      'javascript',
      null,
      null,
    ]);
  });

  it('collects ids and classes with the files that define them', async () => {
    const { index, files } = setup({
      'index.html': '<h1 id="title" class="big red">Hi</h1>\n<button id="plus-button">+</button>',
      'css/style.css': '.big { color: red; }\n.card #title { margin: 0; }\n',
      'images/猫 照片.png': '',
    });
    await index.open(files);
    const symbols = index.symbols();
    expect(names(symbols.ids)).toEqual({ title: ['index.html', 'css/style.css'], 'plus-button': ['index.html'] });
    expect(names(symbols.classes)).toEqual({
      big: ['index.html', 'css/style.css'],
      red: ['index.html'],
      card: ['css/style.css'],
    });
    expect(index.files()).toContain('images/猫 照片.png');
  });

  it('an open file’s live symbols win over its disk copy, and unsaved files are added', async () => {
    const { index, files } = setup({ 'index.html': '<p id="old"></p>' });
    await index.open(files);
    const live = (relPath: string) => (relPath === 'index.html' ? { ids: ['new'], classes: [] } : null);
    const extra = new Map([['draft.html', { ids: ['draft'], classes: ['x'] }]]);
    const symbols = index.symbols(live, extra);
    expect([...symbols.ids.keys()]).toEqual(['new', 'draft']);
    expect([...symbols.classes.keys()]).toEqual(['x']);
  });

  it('follows watcher events: created, changed, renamed, deleted', async () => {
    const { index, files, disk } = setup({ 'index.html': '<p id="a"></p>' });
    await index.open(files);
    disk['about.html'] = '<p id="b"></p>';
    await index.changed([{ type: 'created', relPath: 'about.html' }]);
    expect([...index.symbols().ids.keys()].sort()).toEqual(['a', 'b']);
    disk['index.html'] = '<p id="c"></p>';
    await index.changed([{ type: 'changed', relPath: 'index.html' }]);
    expect([...index.symbols().ids.keys()].sort()).toEqual(['b', 'c']);
    disk['me.html'] = disk['about.html'];
    await index.changed([{ type: 'renamed', from: 'about.html', to: 'me.html', caseOnly: false }]);
    expect(index.files().sort()).toEqual(['index.html', 'me.html']);
    await index.changed([{ type: 'deleted', relPath: 'me.html' }]);
    expect([...index.symbols().ids.keys()]).toEqual(['c']);
    expect(index.files()).toEqual(['index.html']);
  });

  it('never lists hidden files and reads no file that is too large', async () => {
    const { index, files, reads } = setup({
      '.noobide/project.json': '{}',
      '.git/x.html': '<p id="hidden"></p>',
      'big.css': `.${'a'.repeat(MAX_INDEXED_CHARS)} {}`,
      'ok.css': '.ok {}',
    });
    await index.open(files);
    expect(index.files().sort()).toEqual(['big.css', 'ok.css']);
    expect(reads).not.toContain('.git/x.html');
    expect([...index.symbols().classes.keys()]).toEqual(['ok']);
  });

  it(`reads at most ${MAX_INDEXED_FILES} files`, async () => {
    const disk: Record<string, string> = {};
    for (let i = 0; i < MAX_INDEXED_FILES + 20; i += 1) disk[`p${i}.html`] = `<p id="i${i}"></p>`;
    const { index, files, reads } = setup(disk);
    await index.open(files);
    expect(reads).toHaveLength(MAX_INDEXED_FILES);
    expect(index.symbols().ids.size).toBe(MAX_INDEXED_FILES);
  });

  it('the project convention needs two agreeing confident files (S43.3)', async () => {
    const one = setup({ 'a.html': FOUR, 'b.css': 'p {}' });
    await one.index.open(one.files);
    expect(one.index.convention()).toBeNull();
    const two = setup({ 'a.html': FOUR, 'b.html': FOUR, 'empty.js': '' });
    await two.index.open(two.files);
    expect(two.index.convention()).toEqual({ insertSpaces: true, tabSize: 4 });
  });

  it('a newer project replaces the previous one, even while it is still loading', async () => {
    const { index, files } = setup({ 'a.html': '<p id="a"></p>' });
    const first = index.open(files);
    const second = setup({ 'b.html': '<p id="b"></p>' });
    void first;
    index.close();
    await first;
    expect(index.symbols().ids.size).toBe(0);
    await index.open(second.files);
    expect(index.files()).toEqual(['b.html']);
  });

  it('notifies subscribers and stops after unsubscribe', async () => {
    const { index, files } = setup({ 'a.html': '' });
    let calls = 0;
    const off = index.subscribe(() => (calls += 1));
    await index.open(files);
    expect(calls).toBeGreaterThan(0);
    off();
    const before = calls;
    index.close();
    expect(calls).toBe(before);
  });
});
