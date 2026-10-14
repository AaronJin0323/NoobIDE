/**
 * zh-CN is the default locale and the source of truth for message keys (AGENTS.md: i18n invariant).
 * Every key must also exist in en.ts — the type system and i18n.test.ts enforce it.
 */
export const zhCN = {
  'app.name': 'NoobIDE',
  'topbar.noProject': '未打开项目',
  'topbar.sampleNotice': '正在编辑示例，不会保存到磁盘',
  'topbar.saveStatus': '保存状态',
  'topbar.saveStatus.noFile': '没有打开的文件',
  'topbar.language': '界面语言',
  'topbar.switchLanguage': 'English',
  'region.topbar': '顶栏',
  'region.rail': '工具栏',
  'region.files': '文件',
  'region.editor': '编辑器',
  'region.preview': '预览',
  'region.problems': '问题和控制台',
  'rail.files': '文件',
  'rail.problems': '问题',
  'files.empty': '还没有打开文件夹。',
  'files.emptyHint': '打开文件夹和新建项目会在后续版本加入。',
  'editor.loading': '正在加载编辑器…',
  'editor.welcomeTab': '示例.html',
  'editor.sampleBadge': '示例 · 未保存到磁盘',
  'preview.stopped': '未运行',
  'preview.placeholder': '网页预览会显示在这里。',
  'preview.hint': '打开项目后，你的网页会在一个单独的安全窗口里运行。',
  'problems.tab': '问题',
  'problems.unchecked': '还没检查',
  'problems.uncheckedDetail': '还没有检查过代码。打开项目并保存后，这里会列出问题。',
  'problems.toggle': '显示或隐藏问题面板',
  'problems.collapse': '收起问题面板',
  'narrow.switch': '显示代码或预览',
  'narrow.code': '代码',
  'narrow.preview': '预览',
} as const;

export type MessageKey = keyof typeof zhCN;
