/**
 * Messages of the command registry and the native menus (S24). Kept in their own file and spread into zh-CN.ts /
 * en.ts, so these features touch the shared dictionaries in one line each.
 */
export const commandsZhCN = {
  // ── S24.1 命令 ──
  'command.newProject': '新建项目…',
  'command.openFolder': '打开文件夹…',
  'command.save': '保存',
  'command.closeTab': '关闭标签页',
  'command.showHistory': '本地历史…',
  'command.toggleFiles': '显示或隐藏文件列表',
  'command.toggleProblems': '显示或隐藏问题面板',
  'command.nextTab': '下一个标签页',
  'command.previousTab': '上一个标签页',
};

export const commandsEn: Record<keyof typeof commandsZhCN, string> = {
  // ── S24.1 commands ──
  'command.newProject': 'New project…',
  'command.openFolder': 'Open folder…',
  'command.save': 'Save',
  'command.closeTab': 'Close tab',
  'command.showHistory': 'Local history…',
  'command.toggleFiles': 'Show or hide files',
  'command.toggleProblems': 'Show or hide problems',
  'command.nextTab': 'Next tab',
  'command.previousTab': 'Previous tab',
};
