/**
 * Messages of the AI ghost-text suggestions (S32.1). Kept in their own file and spread into zh-CN.ts / en.ts, so the
 * feature touches the shared dictionaries in one line each. S47.5: the status strip shows the short state word
 * (`ai.inline.state.*`); the full sentence (`ai.inline.status.*`) is its tooltip.
 */
export const aiInlineZhCN = {
  'command.toggleInlineAi': '开启或关闭 AI 建议',
  'ai.inline.status.on': 'AI 建议：开（Tab 接受，Esc 忽略）',
  'ai.inline.status.off': 'AI 建议：关',
  'ai.inline.state.on': 'AI 建议：开',
  'ai.inline.state.off': 'AI 建议：关',
  'ai.inline.state.paused': 'AI 建议：已暂停',
} as const;

export const aiInlineEn: Record<keyof typeof aiInlineZhCN, string> = {
  'command.toggleInlineAi': 'Turn AI suggestions on or off',
  'ai.inline.status.on': 'AI suggestions: on (Tab accepts, Esc dismisses)',
  'ai.inline.status.off': 'AI suggestions: off',
  'ai.inline.state.on': 'AI suggestions: on',
  'ai.inline.state.off': 'AI suggestions: off',
  'ai.inline.state.paused': 'AI suggestions: paused',
};
