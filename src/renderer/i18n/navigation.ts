/**
 * Messages of M18 Track C navigation (S49.4 console pinning, search and copy; S49.5 palette recents and the All-tabs
 * list). Kept in their own file and spread into zh-CN.ts / en.ts, so these features touch the shared dictionaries in
 * one line each.
 */
export const navigationZhCN = {
  // ── S49.4 控制台 ──
  'preview.console.search': '搜索',
  'preview.console.search.placeholder': '搜索输出',
  'preview.console.search.label': '搜索控制台输出（不区分大小写）',
  'preview.console.emptySearch': '没有包含“{query}”的输出。',
  'preview.console.copyLine': '复制这一行',
  'preview.console.copyLine.label': '复制第 {n} 行',
  'preview.console.copyAll': '复制显示的全部',
  'preview.console.copyAll.title': '复制当前显示的 {n} 行（筛选和搜索之后）',
  'preview.console.copied': '已复制 {n} 行',
  'preview.console.copyFailed': '无法复制到剪贴板',
  'preview.console.jumpLatest': '回到最新',
  'preview.console.jumpPending': '{n} 行新输出',
  // ── S49.5 命令面板最近使用、所有标签 ──
  'palette.recent': '最近使用',
  'tabs.all': '所有标签',
  'tabs.all.title': '列出所有打开的文件（{n} 个）',
  'tabs.all.menu': '所有打开的文件',
  'tabs.all.close': '关闭 {name}',
  'tabs.all.saved': '已保存',
  'tabs.all.current': '当前',
} as const;

export const navigationEn: Record<keyof typeof navigationZhCN, string> = {
  'preview.console.search': 'Search',
  'preview.console.search.placeholder': 'Search output',
  'preview.console.search.label': 'Search the console output (ignores upper/lower case)',
  'preview.console.emptySearch': 'No output contains “{query}”.',
  'preview.console.copyLine': 'Copy line',
  'preview.console.copyLine.label': 'Copy line {n}',
  'preview.console.copyAll': 'Copy all visible',
  'preview.console.copyAll.title': 'Copy the {n} lines shown now (after the filter and the search)',
  'preview.console.copied': 'Copied {n} lines',
  'preview.console.copyFailed': 'Could not copy to the clipboard',
  'preview.console.jumpLatest': 'Jump to latest',
  'preview.console.jumpPending': '{n} new lines',
  'palette.recent': 'Recent',
  'tabs.all': 'All tabs',
  'tabs.all.title': 'List every open file ({n})',
  'tabs.all.menu': 'All open files',
  'tabs.all.close': 'Close {name}',
  'tabs.all.saved': 'Saved',
  'tabs.all.current': 'shown',
};
