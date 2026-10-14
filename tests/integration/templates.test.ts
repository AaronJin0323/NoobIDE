import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { existsWithExactCase, listTemplates, MANIFEST_FILE, type TemplateInfo } from '../../src/workspace/templates';
import { checkHtml, cssReferences, htmlReferences, networkUrls, resolveLocal } from './template-check';

/**
 * S20.1: the three built-in templates in resources/templates are valid, self-contained, offline projects.
 * Their behaviour in a real page (zero console errors, zero failed loads, working buttons) is proven in
 * tests/e2e/templates.spec.ts.
 */
const TEMPLATES_DIR = path.resolve(import.meta.dirname, '..', '..', 'resources', 'templates');
const TEXT = /\.(html?|css|js|json|svg|txt|md)$/i;

async function allFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await allFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}

const read = (t: TemplateInfo, rel: string) => readFile(path.join(t.dir, ...rel.split('/')), 'utf8');

const listing = await listTemplates(TEMPLATES_DIR);
if (!listing.ok) throw new Error(listing.message);
const templates = listing.value.templates;

describe('built-in templates (S20.1)', () => {
  it('ships exactly the three PLAN §2 templates, all valid, personal intro first and default', () => {
    expect(listing.value.problems).toEqual([]);
    expect(templates.map((t) => t.id)).toEqual(['personal-intro', 'product-showcase', 'button-counter']);
    expect(templates.map((t) => t.name['zh-CN'])).toEqual(['个人介绍页', '产品展示页', '按钮计数器']);
    expect(templates.map((t) => t.name.en)).toEqual(['Personal introduction', 'Product showcase', 'Button counter']);
    expect(templates.filter((t) => t.default).map((t) => t.id)).toEqual(['personal-intro']);
  });

  describe.each(templates.map((t) => [t.id, t] as const))('%s', (_id, t) => {
    it('has the beginner trio index.html / style.css / script.js with index.html as entry', () => {
      expect(t.entry).toBe('index.html');
      expect(t.files).toEqual(expect.arrayContaining(['index.html', 'style.css', 'script.js']));
    });

    it('lists every file in its folder (nothing unlisted is left behind or copied by surprise)', async () => {
      const onDisk = (await allFiles(t.dir)).sort();
      expect(onDisk).toEqual([...t.files, MANIFEST_FILE, t.thumbnail].sort());
    });

    it('has well-formed HTML pages', async () => {
      for (const page of t.files.filter((f) => f.endsWith('.html'))) {
        expect(checkHtml(await read(t, page)).errors, page).toEqual([]);
      }
    });

    it('references only local files that exist with exactly matching case and are copied with the project', async () => {
      const referenced = new Set<string>();
      for (const file of t.files) {
        let refs: string[] = [];
        if (file.endsWith('.html')) refs = htmlReferences(checkHtml(await read(t, file)).tags);
        else if (file.endsWith('.css')) refs = cssReferences(await read(t, file));
        for (const ref of refs) {
          const local = resolveLocal(file, ref);
          if ('error' in local) throw new Error(`${file}: ${local.error}`);
          expect(await existsWithExactCase(t.dir, local.path), `${file} → ${ref}`).toBe(true);
          expect(t.files, `${file} → ${ref} must be copied into the project`).toContain(local.path);
          referenced.add(local.path);
        }
      }
      // The entry page pulls in the stylesheet, the script and at least one local image.
      expect([...referenced]).toEqual(expect.arrayContaining(['style.css', 'script.js']));
      expect([...referenced].some((r) => r.startsWith('images/'))).toBe(true);
    });

    it('contains no network URLs in any text file (offline first, no CDN)', async () => {
      for (const file of [...t.files, MANIFEST_FILE, t.thumbnail].filter((f) => TEXT.test(f))) {
        expect(networkUrls(await read(t, file)), file).toEqual([]);
      }
    });

    it('stays readable for beginners: short files, no frameworks, no module syntax', async () => {
      for (const file of t.files.filter((f) => /\.(html|css|js)$/.test(f))) {
        const text = await read(t, file);
        expect(text.split('\n').length, file).toBeLessThanOrEqual(120);
        expect(text, file).not.toMatch(/\b(import|export|require)\b\s*[({'"*]/);
      }
    });
  });

  it('personal intro supports the 10-minute task script (heading, button, message, userName in two places)', async () => {
    const t = templates[0]!;
    const html = await read(t, 'index.html');
    const js = await read(t, 'script.js');
    expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html).toContain('<script src="script.js"></script>');
    expect(js.match(/\buserName\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(js).toMatch(/addEventListener\(['"]click['"]/);
  });
});

describe('template checker catches mistakes', () => {
  it('flags unclosed and mismatched tags, missing doctype/lang/charset/title, duplicate ids', () => {
    const errors = checkHtml('<html><head></head><body><div id="a"><p id="a">x</div></body></html>').errors.join('\n');
    expect(errors).toMatch(/must start with <!doctype html>/);
    expect(errors).toMatch(/<\/div> does not match <p>/);
    expect(errors).toMatch(/duplicate id a/);
    expect(errors).toMatch(/lang/);
    expect(errors).toMatch(/charset/);
    expect(errors).toMatch(/<title>/);
  });

  it('accepts a minimal valid page and skips script contents', () => {
    const ok = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>t</title></head>
      <body><img src="a.png" alt="" /><script>if (1 < 2 && "</p>") {}</script></body></html>`;
    expect(checkHtml(ok).errors).toEqual([]);
  });

  it('finds network URLs but ignores SVG namespaces and // comments', () => {
    expect(networkUrls('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual([]);
    expect(networkUrls('// 找到按钮\n// comment text')).toEqual([]);
    expect(networkUrls('<link href="https://cdn.example.com/x.css">')).toHaveLength(1);
    expect(networkUrls('url(//fonts.example.com/a.woff2)')).toHaveLength(1);
  });

  it('resolves relative references and refuses absolute, remote and escaping ones', () => {
    expect(resolveLocal('index.html', 'images/a.svg')).toEqual({ path: 'images/a.svg' });
    expect(resolveLocal('css/site.css', '../images/a.svg?v=1')).toEqual({ path: 'images/a.svg' });
    expect(resolveLocal('index.html', '../x.png')).toHaveProperty('error');
    expect(resolveLocal('index.html', '/x.png')).toHaveProperty('error');
    expect(resolveLocal('index.html', 'https://x.test/a.png')).toHaveProperty('error');
    expect(cssReferences('a{background:url("i/b.png")} /* url(c.png) */ @import "d.css";')).toEqual([
      'i/b.png',
      'd.css',
    ]);
  });
});
