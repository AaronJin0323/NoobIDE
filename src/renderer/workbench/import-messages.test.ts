import { describe, expect, it } from 'vitest';
import { translate } from '../i18n/index';
import { importRefusalMessage, needsNewName } from './import-messages';

/** S52.4: every refusal of an outside file is explained, naming the size limit or the type, in zh-CN and en. */
describe('import refusal messages (S52.4)', () => {
  const zh = (key: Parameters<typeof translate>[1]) => translate('zh-CN', key);
  const en = (key: Parameters<typeof translate>[1]) => translate('en', key);

  it('a file over the cap names the cap (50.0 MB) and the file', () => {
    expect(importRefusalMessage(zh, 'too-large', '大 视频.mp4')).toContain('50.0 MB');
    expect(importRefusalMessage(zh, 'too-large', '大 视频.mp4')).toContain('大 视频.mp4');
    expect(importRefusalMessage(en, 'too-large', 'big.mp4')).toContain('50.0 MB');
    expect(importRefusalMessage(en, 'too-large', '素材', 'directory')).toContain('10000 files or 2 GB');
  });

  it('a refused type names its ending; the other refusals are explained too', () => {
    expect(importRefusalMessage(zh, 'refused-type', 'setup.exe')).toContain('.exe');
    expect(importRefusalMessage(en, 'refused-type', 'run.BAT')).toContain('.BAT');
    expect(importRefusalMessage(en, 'not-an-image', 'a.txt')).toContain('png, jpg, jpeg, gif, svg, webp, ico');
    expect(importRefusalMessage(zh, 'not-a-file', '快捷方式')).toContain('快捷方式');
    expect(importRefusalMessage(zh, 'contains-refused', '素材 包', 'directory', '工具/setup.exe')).toContain('.exe');
    expect(importRefusalMessage(en, 'contains-too-large', 'pack', 'directory', 'big.mp4')).toContain('50.0 MB');
    for (const refusal of [
      'too-large',
      'refused-type',
      'not-an-image',
      'not-a-file',
      'contains-refused',
      'contains-too-large',
    ] as const) {
      expect(importRefusalMessage(zh, refusal, 'x')).not.toMatch(/\{\w+\}/);
      expect(importRefusalMessage(en, refusal, 'x')).not.toMatch(/\{\w+\}/);
    }
  });

  it('only a taken or invalid name asks the user for a new one', () => {
    expect(needsNewName('exists')).toBe(true);
    expect(needsNewName('case-conflict')).toBe(true);
    expect(needsNewName('invalid-name')).toBe(true);
    expect(needsNewName('too-large')).toBe(false);
  });
});
