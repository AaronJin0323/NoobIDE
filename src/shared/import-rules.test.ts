import { describe, expect, it } from 'vitest';
import { IMAGE_DIALOG_EXTENSIONS, MAX_IMPORT_FILE_BYTES, importRefusal } from './import-rules';

/** S52.4: which files from outside a project may be added, and why not (each refusal names its limit or type). */
const file = (name: string, bytes = 10) => ({ name, kind: 'file' as const, bytes });

describe('import rules (S52.4)', () => {
  it('ordinary web files, images and folders can be added', () => {
    for (const name of ['页面 二.html', 'style.css', 'app.js', '标志 图.PNG', 'data.json', 'README', '字体.woff2']) {
      expect(importRefusal(file(name), 'files')).toBeNull();
    }
    expect(importRefusal({ name: '图片 素材', kind: 'directory', bytes: 0 }, 'files')).toBeNull();
  });

  it('a file over the size cap is refused with "too-large"; exactly at the cap is fine', () => {
    expect(importRefusal(file('big.mp4', MAX_IMPORT_FILE_BYTES + 1), 'files')).toBe('too-large');
    expect(importRefusal(file('ok.mp4', MAX_IMPORT_FILE_BYTES), 'files')).toBeNull();
  });

  it('programs, scripts that run on the computer and shortcuts are refused, ignoring case', () => {
    for (const name of ['setup.exe', 'run.BAT', 'x.cmd', 'tool.ps1', 'link.lnk', 'site.url', 'App.app', 'a.dmg']) {
      expect(importRefusal(file(name), 'files')).toBe('refused-type');
    }
  });

  it('"Add image…" takes images only; links and devices are never added', () => {
    expect(importRefusal(file('a.webp'), 'image')).toBeNull();
    expect(importRefusal(file('notes.txt'), 'image')).toBe('not-an-image');
    expect(importRefusal({ name: '图片', kind: 'directory', bytes: 0 }, 'image')).toBe('not-an-image');
    expect(importRefusal({ name: 'x', kind: 'other', bytes: 0 }, 'files')).toBe('not-a-file');
    expect(IMAGE_DIALOG_EXTENSIONS).toEqual(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico']);
  });
});
