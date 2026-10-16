/**
 * Messages of the AI ghost-text suggestions (S32.1). Kept in their own file and spread into zh-CN.ts / en.ts, so the
 * feature touches the shared dictionaries in one line each.
 */
export const aiInlineZhCN = {
  'command.toggleInlineAi': '开启或关闭 AI 建议',
  'ai.inline.status.on': 'AI 建议：开（Tab 接受，Esc 忽略）',
  'ai.inline.status.off': 'AI 建议：关',
} as const;

export const aiInlineEn: Record<keyof typeof aiInlineZhCN, string> = {
  'command.toggleInlineAi': 'Turn AI suggestions on or off',
  'ai.inline.status.on': 'AI suggestions: on (Tab accepts, Esc dismisses)',
  'ai.inline.status.off': 'AI suggestions: off',
};
