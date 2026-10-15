import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhCN, type MessageKey } from './zh-CN';
import { translate } from './index';
import { ONE_FORMS } from './plural';
import { fill } from '../recovery/format';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('English plurals', () => {
  it('picks the singular form for a count of 1 and the dictionary text otherwise', () => {
    expect(fill(translate('en', 'problems.count.errors', 1), { n: 1 })).toBe('1 error');
    expect(fill(translate('en', 'problems.count.errors', 3), { n: 3 })).toBe('3 errors');
    expect(fill(translate('en', 'problems.count.warnings', 1), { n: 1 })).toBe('1 warning');
    expect(fill(translate('en', 'problems.count.info', 1), { n: 1 })).toBe('1 note');
    expect(fill(translate('en', 'recovery.files', 1), { n: 1 })).toBe('1 file with unsaved changes');
    expect(fill(translate('en', 'recovery.files', 2), { n: 2 })).toBe('2 files with unsaved changes');
    expect(fill(translate('en', 'agent.diff.added', 0), { n: 0 })).toBe('0 lines added');
    expect(fill(translate('en', 'ai.history.revoke.deleted', 1), { n: 1 })).toBe('1 chat deleted.');
    expect(translate('en', 'problems.count.errors')).toBe('{n} errors'); // no count: the dictionary text
  });

  it('leaves zh-CN unchanged (no grammatical plural)', () => {
    expect(translate('zh-CN', 'problems.count.errors', 1)).toBe(zhCN['problems.count.errors']);
    expect(ONE_FORMS['zh-CN']).toBeUndefined();
  });

  it('every singular form has the same placeholders as its plural, and no English text says “(s)”', () => {
    for (const [key, one] of Object.entries(ONE_FORMS.en ?? {})) {
      expect(placeholders(one), key).toEqual(placeholders(en[key as MessageKey]));
      expect(one, key).not.toBe(en[key as MessageKey]);
    }
    const listed = [
      'recovery.files',
      'recovery.added',
      'recovery.removed',
      'recovery.skipped',
      'history.group.undoPartial',
      'agent.diff.added',
      'agent.diff.removed',
      'agent.undo.done',
      'agent.undo.partial',
      'ai.chat.proposal.unsupported',
      'ai.history.skipped',
      'ai.history.revoke.ask',
      'ai.history.revoke.deleted',
      'welcome.recentChats.ask',
      'problems.count.errors',
      'problems.count.warnings',
      'problems.count.info',
    ] as const;
    for (const key of listed) expect(ONE_FORMS.en?.[key], key).toBeDefined();
    for (const [key, text] of Object.entries(en)) expect(text, key).not.toMatch(/\w\(s\)/);
  });
});
