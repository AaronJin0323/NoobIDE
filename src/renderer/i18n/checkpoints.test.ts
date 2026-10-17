import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { glossaryEntry } from '../walkthrough/lessons';
import { checkpointsEn, checkpointsZhCN } from './checkpoints';
import { en } from './en';
import { zhCN } from './zh-CN';

/**
 * S56.4 (PLAN §7: separate mechanisms, separate UI states): the wording keeps checkpoint (whole project, named),
 * local history (per file, automatic) and undo (in the editor) apart, and no checkpoint text claims to be version
 * control or Git. Checked over the zh-CN and en strings, the glossary and the user documentation.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Dict = Readonly<Record<string, string>>;
const LOCALES: readonly { name: string; all: Dict; checkpoints: Dict }[] = [
  { name: 'zh-CN', all: zhCN, checkpoints: checkpointsZhCN },
  { name: 'en', all: en, checkpoints: checkpointsEn },
];

/** Words of version control that would make a checkpoint sound like Git (in either language). */
const VCS = /\bgit\b|commit|branch|merge|repositor|version control|提交|分支|合并|仓库|版本控制/i;

/** The few strings that may name Git or version control: only to say a checkpoint is NOT that. */
const NEGATIONS = ['checkpoints.intro'];

describe('S56.4 checkpoint wording', () => {
  for (const { name, all, checkpoints } of LOCALES) {
    describe(name, () => {
      it('no checkpoint string claims to be version control or Git', () => {
        for (const [key, text] of Object.entries(checkpoints)) {
          if (NEGATIONS.includes(key)) continue;
          expect(text, key).not.toMatch(VCS);
        }
      });

      it('the intro says what a checkpoint is (whole project, named) and is not (history, undo, Git, backup)', () => {
        const intro = checkpoints['checkpoints.intro'] ?? '';
        if (name === 'zh-CN') {
          for (const part of ['整个项目', '命名', '本地历史', '单个文件', '撤销', '不是 Git', '版本控制', '备份']) {
            expect(intro, part).toContain(part);
          }
          expect(intro).toMatch(/不会写进项目文件夹/);
        } else {
          for (const part of [
            'whole project',
            'name you choose',
            'local history',
            'each file',
            'undo',
            'not version control like Git',
            'backups',
          ]) {
            expect(intro, part).toContain(part);
          }
          expect(intro).toMatch(/never in the project folder/);
        }
      });

      it('local-history and undo strings never call themselves checkpoints', () => {
        for (const [key, text] of Object.entries(all)) {
          if (!key.startsWith('history.') || key === 'history.checkpointNote') continue;
          expect(text, key).not.toMatch(/检查点|checkpoint/i);
        }
        for (const [key, text] of Object.entries(all)) {
          if (/undo|撤销/i.test(key)) expect(text, key).not.toMatch(/检查点|checkpoint/i);
        }
      });

      it('the history window points to checkpoints for the whole project', () => {
        const note = checkpoints['history.checkpointNote'] ?? '';
        expect(note).toMatch(
          name === 'zh-CN' ? /一个文件.*整个项目.*项目检查点/ : /one file.*whole project.*Project checkpoints/,
        );
      });

      it('an automatic checkpoint is always labelled with its cause', () => {
        for (const cause of ['manual', 'before-ai', 'before-history-restore', 'before-checkpoint-restore']) {
          expect(checkpoints[`checkpoints.cause.${cause}`], cause).toBeTruthy();
        }
        expect(checkpoints['checkpoints.kind.auto']).toBeTruthy();
        expect(checkpoints['checkpoints.kind.named']).toBeTruthy();
      });
    });
  }

  it('zh-CN: a checkpoint is 检查点 and is restored with 还原; local history restores with 恢复', () => {
    for (const [key, text] of Object.entries(checkpointsZhCN)) {
      if (!key.startsWith('checkpoints.restore') || /本地历史/.test(text)) continue;
      expect(text, key).not.toMatch(/恢复/);
    }
    expect(checkpointsZhCN['checkpoints.restoreAll']).toMatch(/还原/);
    expect(zhCN['history.restore']).toMatch(/恢复/);
    expect(zhCN['checkpoints.title']).toContain('检查点');
    expect(zhCN['history.title']).toBe('本地历史');
  });

  it('the glossary explains checkpoint, local history and undo as three different things', () => {
    const checkpoint = glossaryEntry('checkpoint');
    const history = glossaryEntry('local history');
    const undo = glossaryEntry('undo');
    expect(checkpoint && history && undo).toBeTruthy();
    expect(checkpoint?.['zh-CN'].name).toBe('检查点');
    expect(checkpoint?.['zh-CN'].text).toMatch(/整个项目/);
    expect(checkpoint?.['zh-CN'].text).toMatch(/不是 Git/);
    expect(checkpoint?.en.text).toMatch(/whole project/);
    expect(checkpoint?.en.text).toMatch(/not version control like Git/);
    expect(history?.['zh-CN'].text).toMatch(/每个文件/);
    expect(history?.['zh-CN'].text).toMatch(/撤销/);
    expect(history?.['zh-CN'].text).toMatch(/检查点/);
    expect(history?.en.text).toMatch(/each file/);
    expect(history?.en.text).toMatch(/not undo/);
    expect(undo?.['zh-CN'].text).toMatch(/编辑器/);
    expect(undo?.en.text).toMatch(/in the editor/);
    for (const entry of [history, undo]) {
      expect(entry?.en.text).not.toMatch(VCS);
      expect(entry?.['zh-CN'].text).not.toMatch(VCS);
    }
  });

  it('the user documentation separates the three mechanisms and denies being version control', () => {
    const doc = readFileSync(path.join(ROOT, 'docs', 'product', 'checkpoints.md'), 'utf8');
    for (const part of [
      '**Undo**',
      '**Local history**',
      '**Checkpoint**',
      'not version control',
      'not Git',
      'never inside the project folder',
      'Named checkpoints are never removed automatically',
    ]) {
      expect(doc, part).toContain(part);
    }
  });
});
