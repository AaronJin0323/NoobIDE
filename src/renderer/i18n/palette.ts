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
  // 命令的其他叫法（用空格分隔），搜索时也会匹配
  'palette.keywords.newProject': '创建 新建 做网页 第一个网页 网站 开始',
  // ── S51.5 快速打开文件（Ctrl/Cmd+P）──
  'command.quickOpen': '按名称打开文件…',
  'palette.files.title': '打开文件',
  'palette.files.label': '要打开的文件名',
  'palette.files.placeholder': '输入文件名查找；输入 > 改为搜索命令',
  'palette.files.results': '项目里的文件',
  'palette.files.empty': '项目里没有这个名字的文件（隐藏文件和 node_modules 不在这里）。输入 > 可以搜索命令。',
  'palette.files.count': '找到 {n} 个文件',
  'palette.files.recent': '最近打开',
  'palette.files.keys': '↑ ↓ 选择 · Enter 打开 · > 搜索命令 · Esc 关闭',
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
  // Other words for a command (space-separated), also matched by the search
  'palette.keywords.newProject': 'create make start webpage website site page',
  // ── S51.5 quick open (Ctrl/Cmd+P) ──
  'command.quickOpen': 'Go to File…',
  'palette.files.title': 'Open a file',
  'palette.files.label': 'Name of the file to open',
  'palette.files.placeholder': 'Type a file name; type > to search commands instead',
  'palette.files.results': 'Files of the project',
  'palette.files.empty':
    'No file of the project has that name (hidden files and node_modules are not listed). Type > to search commands.',
  'palette.files.count': 'Files found: {n}',
  'palette.files.recent': 'recently opened',
  'palette.files.keys': '↑ ↓ choose · Enter open · > commands · Esc close',
};
