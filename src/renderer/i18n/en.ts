import type { MessageKey } from './zh-CN';

/** English (required locale). Must define exactly the keys of zh-CN.ts. */
export const en: Record<MessageKey, string> = {
  'app.name': 'NoobIDE',
  'topbar.noProject': 'No project open',
  'topbar.saveStatus': 'Save status',
  'topbar.saveStatus.noFile': 'No file open',
  'topbar.preview': 'Preview',
  'topbar.help': 'Help',
  'topbar.moreTools': 'More tools',
  'topbar.language': 'Interface language',
  'topbar.switchLanguage': '中文',
  'region.topbar': 'Top bar',
  'region.files': 'Files',
  'region.editor': 'Editor',
  'region.preview': 'Preview',
  'region.problems': 'Problems and console',
  'files.empty': 'No folder is open yet.',
  'editor.loading': 'Loading the editor…',
  'editor.welcomeTab': 'welcome.html',
  'preview.placeholder': 'The webpage preview will appear here.',
  'problems.tab': 'Problems',
  'console.tab': 'Console',
  'problems.none': 'No problems found.',
};
