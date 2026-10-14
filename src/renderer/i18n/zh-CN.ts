/**
 * zh-CN is the default locale and the source of truth for message keys (AGENTS.md: i18n invariant).
 * Every key must also exist in en.ts — the type system and i18n.test.ts enforce it.
 */
export const zhCN = {
  'app.name': 'NoobIDE',
  'topbar.noProject': '未打开项目',
  'topbar.saveStatus': '保存状态',
  'topbar.saveStatus.noFile': '没有打开的文件',
  'topbar.preview': '预览',
  'topbar.help': '帮助',
  'topbar.moreTools': '更多工具',
  'topbar.language': '界面语言',
  'topbar.switchLanguage': 'English',
  'region.topbar': '顶栏',
  'region.files': '文件',
  'region.editor': '编辑器',
  'region.preview': '预览',
  'region.problems': '问题和控制台',
  'files.empty': '还没有打开文件夹。',
  'editor.loading': '正在加载编辑器…',
  'editor.welcomeTab': '欢迎.html',
  'preview.placeholder': '网页预览会显示在这里。',
  'problems.tab': '问题',
  'console.tab': '控制台',
  'problems.none': '没有发现问题。',
} as const;

export type MessageKey = keyof typeof zhCN;
