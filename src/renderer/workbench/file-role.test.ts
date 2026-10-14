import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { zhCN } from '../i18n/zh-CN';
import { fileRoleDetailKey, fileRoleFor, fileRoleLabelKey, type FileRole } from './file-role';

describe('fileRoleFor (S20.3)', () => {
  it('maps the beginner trio to structure / style / behavior', () => {
    expect(fileRoleFor('index.html')).toBe('structure');
    expect(fileRoleFor('style.css')).toBe('style');
    expect(fileRoleFor('script.js')).toBe('behavior');
  });

  it.each([
    ['about/关于 我.HTML', 'structure'],
    ['page.htm', 'structure'],
    ['css\\site.css', 'style'],
    ['lib/app.mjs', 'behavior'],
    ['images/头像.png', 'image'],
    ['images/avatar.svg', 'image'],
    ['img/photo.JPEG', 'image'],
    ['fonts/a.woff2', 'font'],
    ['data/list.json', 'data'],
  ] as const)('%s → %s', (path, role) => {
    expect(fileRoleFor(path)).toBe(role);
  });

  it.each(['README.md', 'notes.txt', 'Makefile', '.css', 'archive.', 'folder.css/readme', ''])(
    'has no role for %j',
    (path) => {
      expect(fileRoleFor(path)).toBeNull();
    },
  );

  it('decides by the file name only, not by folder names', () => {
    expect(fileRoleFor('style.css/notes.txt')).toBeNull();
    expect(fileRoleFor('scripts.js/index.html')).toBe('structure');
  });
});

describe('file role strings', () => {
  const roles: FileRole[] = ['structure', 'style', 'behavior', 'image', 'font', 'data'];

  it('exist in zh-CN and en for every role', () => {
    for (const role of roles) {
      for (const key of [fileRoleLabelKey(role), fileRoleDetailKey(role)]) {
        expect(zhCN[key as keyof typeof zhCN], key).toBeTruthy();
        expect(en[key], key).toBeTruthy();
      }
    }
  });

  it('use the task-script wording for the three template files', () => {
    expect([zhCN['fileRole.structure'], zhCN['fileRole.style'], zhCN['fileRole.behavior']]).toEqual([
      '页面结构',
      '视觉样式',
      '交互行为',
    ]);
    expect([en['fileRole.structure'], en['fileRole.style'], en['fileRole.behavior']]).toEqual([
      'Page structure',
      'Visual styling',
      'Interactive behavior',
    ]);
  });

  it('keeps labels short enough for a file row', () => {
    for (const role of roles) {
      expect(zhCN[fileRoleLabelKey(role) as keyof typeof zhCN].length).toBeLessThanOrEqual(6);
      expect(en[fileRoleLabelKey(role)].length).toBeLessThanOrEqual(22);
    }
  });
});
