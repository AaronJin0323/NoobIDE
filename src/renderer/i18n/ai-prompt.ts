/**
 * Messages of the inline `/ai` prompt (S42.3, decision 0031). Spread into zh-CN.ts / en.ts in one line each.
 * `{name}` placeholders are filled with `fill()` (src/renderer/recovery/format.ts).
 */
export const aiPromptZhCN = {
  // ── 编辑器里 /ai 行末尾的提示（文字，不只靠颜色） ──
  'aiPrompt.hint.run': '⏎ 让 AI 写代码（或 {shortcut}）',
  'aiPrompt.hint.shortcut': '{shortcut} 让 AI 写代码',
  'aiPrompt.hint.bare': '在 /ai 后面写下你想要的效果，例如：/ai 把标题居中',
  // ── 警告标记（悬停和“问题”面板里显示） ──
  'aiPrompt.marker':
    '还没有运行的 AI 要求：按 {shortcut} 让 AI 写代码（刚输入的 /ai 行直接按 Enter 也可以），或者删掉这一行。在此之前它会作为普通文字保存在文件里。',
  // ── 编辑器右键菜单 ──
  'aiPrompt.menu': '运行这一行 /ai 要求',
  // ── 修改区域 ──
  'aiPrompt.target': 'AI 写的代码会替换 {file} 第 {start} 行的 /ai 要求',
  'aiPrompt.request': '你的要求：{prompt}',
} as const;

export const aiPromptEn: Record<keyof typeof aiPromptZhCN, string> = {
  'aiPrompt.hint.run': '⏎ let AI write it (or {shortcut})',
  'aiPrompt.hint.shortcut': '{shortcut} lets AI write it',
  'aiPrompt.hint.bare': 'Write what you want after /ai, e.g. /ai center the heading',
  'aiPrompt.marker':
    'AI request not run yet: press {shortcut} to let AI write the code (Enter also works right after typing the /ai line), or delete this line. Until then it is saved into the file as plain text.',
  'aiPrompt.menu': 'Run this /ai request',
  'aiPrompt.target': 'The AI code replaces the /ai request on line {start} of {file}',
  'aiPrompt.request': 'Your request: {prompt}',
};
