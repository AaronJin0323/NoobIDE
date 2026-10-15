/**
 * Messages of the S40 Liquid Glass refresh: the command palette and the top bar's command search. Spread into
 * zh-CN.ts / en.ts like the other feature files.
 */
export const paletteZhCN = {
  'command.palette': '搜索命令…',
  'palette.open': '搜索命令',
  'palette.title': '命令',
  'palette.label': '搜索要做的事',
  'palette.placeholder': '输入要做的事，例如：保存、预览、主题、save',
  'palette.results': '可以运行的命令',
  'palette.empty': '没有找到能做这件事的命令。换个说法试试，或者用英文搜索。',
  'palette.count': '找到 {n} 个命令',
  'palette.other': '英文：{label}',
  'palette.keys': '↑ ↓ 选择 · Enter 运行 · Esc 关闭',
} as const;

export const paletteEn: Record<keyof typeof paletteZhCN, string> = {
  'command.palette': 'Search Commands…',
  'palette.open': 'Search commands',
  'palette.title': 'Commands',
  'palette.label': 'Search for what you want to do',
  'palette.placeholder': 'Type what you want to do, e.g. save, preview, theme, 保存',
  'palette.results': 'Commands you can run',
  'palette.empty': 'No command does that. Try other words, or search in Chinese.',
  'palette.count': 'Commands found: {n}',
  'palette.other': 'Chinese: {label}',
  'palette.keys': '↑ ↓ choose · Enter run · Esc close',
};
