import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhCN, type MessageKey } from './zh-CN';

/**
 * S47.4 — one name per feature (docs/history.md, "Standing design rules", rule 3). The term
 * table of the assessment is the source for zh-CN and en: every place a feature is named — rail, menus, palette
 * (the command labels), tooltips, banners and the lessons' hints — uses the one term, and the retired names cannot
 * come back. The catalogues are the only place UI text lives (hardcoded-ui-strings.test.ts), so a test over them
 * covers every component.
 */
interface Term {
  readonly feature: string;
  readonly zh: string;
  readonly en: string;
  /** Messages that are the term and nothing else (a rail button, a heading, a short button). */
  readonly exact?: readonly MessageKey[];
  /** Menu / palette entries: the term, optionally followed by an ellipsis (… opens a dialog). */
  readonly menu?: readonly MessageKey[];
  /** Longer messages (tooltips, toggles, hints) that must name the feature by its term. */
  readonly mentions?: readonly MessageKey[];
}

export const TERMS: readonly Term[] = [
  {
    feature: 'Local history',
    zh: '历史版本',
    en: 'History',
    exact: ['rail.history', 'history.open', 'history.title'],
    menu: ['command.showHistory'],
    mentions: ['history.openFor'],
  },
  {
    feature: 'Beginner lessons',
    zh: '课程',
    en: 'Lessons',
    exact: ['rail.lessons', 'welcome.lessons', 'walkthrough.region'],
    menu: ['command.walkthrough'],
    mentions: ['rail.lessons.title', 'walkthrough.closeHint', 'walkthrough.finish', 'walkthrough.close'],
  },
  {
    feature: 'Problems',
    zh: '问题',
    en: 'Problems',
    exact: ['rail.problems', 'problems.tab'],
    menu: [],
    mentions: ['command.toggleProblems', 'problems.toggle', 'problems.collapse', 'region.problems'],
  },
  {
    feature: 'Ask AI (chat, no code edit)',
    zh: '问 AI',
    en: 'Ask AI',
    exact: ['rail.ai', 'ai.chat.title', 'problems.card.askAi', 'annotations.askAi'],
    menu: [],
    mentions: ['command.ai.toggleChat', 'annotations.askAll'],
  },
  {
    feature: 'AI edit (changes code)',
    zh: 'AI 修改',
    en: 'Edit with AI',
    exact: ['ai.editor.editButton', 'ai.editor.inlineEdit', 'ai.edit.region', 'ai.purpose.edit'],
    menu: ['command.ai.inlineEdit'],
  },
  {
    feature: 'AI fix (problem)',
    zh: 'AI 修复',
    en: 'Fix with AI',
    exact: ['problems.card.fixWithAi'],
    mentions: ['problems.row.fixWithAiLabel'],
  },
  {
    feature: 'AI suggestions (ghost text)',
    zh: 'AI 建议',
    en: 'AI suggestions',
    exact: ['ai.purpose.inline'],
    menu: [],
    mentions: [
      'command.toggleInlineAi',
      'ai.settings.inline',
      'ai.inline.status.on',
      'ai.inline.status.off',
      'ai.inline.state.on',
      'ai.inline.state.off',
      'ai.inline.state.paused',
    ],
  },
  {
    feature: 'AI project changes (agent)',
    zh: '修改项目',
    en: 'Change project',
    exact: ['ai.purpose.agent'],
    mentions: ['ai.chat.kind.agent'],
  },
  {
    feature: 'Crash recovery',
    zh: '恢复上次未保存的修改',
    en: 'Recover unsaved edits',
    exact: ['recovery.title'],
  },
  {
    feature: 'External change',
    zh: '文件在外部被改动',
    en: 'Changed outside NoobIDE',
    mentions: ['disk.reloaded', 'conflict.title'],
  },
];

/**
 * Names the features used to go by. None may appear in either catalogue again (comparison is case-insensitive for
 * English). "Agent" is checked as a whole word: the English catalogue may still say "the AI" or "changes".
 */
const RETIRED: Record<'zh-CN' | 'en', readonly (string | RegExp)[]> = {
  'zh-CN': [
    '本地历史',
    '入门导览',
    '导览',
    'AI 编辑',
    '内联编辑',
    '自动补全',
    '智能体',
    'AI 代码建议',
    '用 AI 修复',
    '用 AI 修改',
    '更多操作',
  ],
  en: [
    'local history',
    'walkthrough',
    'inline edit',
    /\bcompletions?\b/i,
    /\bagent\b/i,
    'AI code suggestions',
    'edit code with AI',
    'edit this code with AI',
    /\bAI edit\b/i,
    'more actions',
  ],
};

const catalogues = { 'zh-CN': zhCN, en } as const;

describe('S47.4 term table: one name per feature in zh-CN and en', () => {
  for (const term of TERMS) {
    describe(term.feature, () => {
      for (const locale of ['zh-CN', 'en'] as const) {
        const name = locale === 'zh-CN' ? term.zh : term.en;
        const messages = catalogues[locale];
        it(`${locale}: is "${name}" wherever the feature is named`, () => {
          for (const key of term.exact ?? []) expect(messages[key], key).toBe(name);
          for (const key of term.menu ?? []) expect(messages[key], key).toMatch(new RegExp(`^${name}…?$`));
          for (const key of term.mentions ?? []) expect(messages[key], key).toContain(name);
        });
      }
    });
  }

  it('the retired names do not come back in either catalogue', () => {
    const hits: string[] = [];
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const [key, value] of Object.entries(catalogues[locale])) {
        for (const retired of RETIRED[locale]) {
          const hit =
            retired instanceof RegExp ? retired.test(value) : value.toLowerCase().includes(retired.toLowerCase());
          if (hit) hits.push(`${locale} ${key} = "${value}" still says "${String(retired)}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('a term is never the empty string and differs per feature', () => {
    for (const locale of ['zh', 'en'] as const) {
      const names = TERMS.map((term) => term[locale]);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(name.trim()).not.toBe('');
    }
  });
});
