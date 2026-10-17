/**
 * Messages of S51: find and replace in the current file, find and replace in files, and quick open. Spread into
 * zh-CN.ts / en.ts like the other feature files.
 */
export const searchZhCN = {
  // ── S51.1 当前文件的查找和替换 ──
  'command.find': '查找',
  'command.replace': '替换',
} as const;

export const searchEn: Record<keyof typeof searchZhCN, string> = {
  'command.find': 'Find',
  'command.replace': 'Replace',
};
