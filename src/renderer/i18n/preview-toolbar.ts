/**
 * Messages of the preview manager and toolbar (S14.2–S14.5, S15.4). Kept in their own file and spread into zh-CN.ts /
 * en.ts, so these features touch the shared dictionaries in one line each.
 */
export const previewToolbarZhCN = {
  // ── S15.4 命令 ──
  'command.preview.refresh': '刷新预览',
  'command.preview.stop': '停止预览',
  'command.preview.openExternal': '在浏览器中打开预览',
  'command.preview.devTools': '打开预览的开发者工具（高级）',
  'command.preview.clearData': '清除这个项目的预览数据',
  'menu.preview': '预览',
  // ── S15.4 工具栏 ──
  'preview.toolbar': '预览工具栏',
  'preview.openExternal': '在浏览器中打开',
  'preview.openExternal.title': '在你的默认浏览器中打开当前页面',
  'preview.openExternal.note':
    '已在你的浏览器中打开。浏览器有自己的存储：在这里的预览中保存的数据（localStorage、Cookie 等）在浏览器里看不到，反过来也一样。',
  'preview.openExternal.failed': '没能在浏览器中打开：预览没有在运行。',
  'preview.advanced': '高级',
  'preview.advanced.title': '更多预览选项',
  'preview.devTools': '开发者工具',
  'preview.devTools.detail': '给有经验的用户：Chromium 自带的调试工具，在单独的窗口里打开。',
  'preview.clearData': '清除预览数据',
  'preview.clearData.detail':
    '删除这个项目的网页在预览里保存的数据（localStorage、IndexedDB、Cookie、缓存）。其他项目的数据和你的文件都不受影响。',
  'preview.clearData.externalNote': '外部浏览器的数据是分开保存的，要清除它请到浏览器的设置里操作。',
  'preview.clearData.done': '这个项目的预览数据已清除。',
  'preview.clearData.failed': '没能清除预览数据。',
  'preview.note.dismiss': '知道了',
  // ── S14.2 刷新方式 ──
  'preview.refreshMode': '保存后自动刷新',
  'preview.refreshMode.title': '打开：保存成功并停止输入后自动刷新预览。关闭：只在你点“刷新”时刷新。',
  'preview.refreshMode.locked': '无法更改：项目里的 .noobide/project.json 无法读取。修好或删掉它之后再试。',
  'preview.refreshMode.failed': '没能保存刷新方式。',
  'preview.outdated': '有未显示的保存',
  'preview.outdatedDetail': '手动刷新：页面还是上次保存前的样子。点“刷新”查看最新的文件。',
  'preview.reloadNote': '提示：刷新会重新加载页面——在页面里输入的内容、滚动位置和变量都会从头开始。',
  // ── S14.3 入口页面 ──
  'preview.entry': '入口页面',
  'preview.entry.default': '（默认）',
  'preview.entry.none': '没有找到 HTML 页面',
  'preview.entry.truncated': '页面太多，只列出了一部分。',
  'preview.entry.failed': '没能保存入口页面。',
  // ── S14.4 启动预览前的确认 ──
  'preview.consent.title': '这个文件夹的网页还没有运行',
  'preview.consent.detail':
    '这个文件夹是从你的电脑上打开的。为了安全，只有在你点“开始预览”之后才会运行它的网页脚本；NoobIDE 会记住你的选择，下次打开时自动预览。',
} as const;

export const previewToolbarEn: Record<keyof typeof previewToolbarZhCN, string> = {
  'command.preview.refresh': 'Refresh preview',
  'command.preview.stop': 'Stop preview',
  'command.preview.openExternal': 'Open preview in browser',
  'command.preview.devTools': 'Open preview developer tools (advanced)',
  'command.preview.clearData': 'Clear this project’s preview data',
  'menu.preview': 'Preview',
  'preview.toolbar': 'Preview toolbar',
  'preview.openExternal': 'Open in browser',
  'preview.openExternal.title': 'Open the current page in your default browser',
  'preview.openExternal.note':
    'Opened in your browser. The browser keeps its own storage: data the page saved here in the preview (localStorage, cookies…) is not there, and the other way round.',
  'preview.openExternal.failed': 'Could not open the browser: the preview is not running.',
  'preview.advanced': 'Advanced',
  'preview.advanced.title': 'More preview options',
  'preview.devTools': 'Developer tools',
  'preview.devTools.detail': 'For experienced users: Chromium’s own debugging tools, in a separate window.',
  'preview.clearData': 'Clear preview data',
  'preview.clearData.detail':
    'Deletes what this project’s page saved in the preview (localStorage, IndexedDB, cookies, cache). Other projects’ data and your files are not touched.',
  'preview.clearData.externalNote':
    'Your external browser keeps its data separately; clear it in the browser’s settings.',
  'preview.clearData.done': 'This project’s preview data was cleared.',
  'preview.clearData.failed': 'The preview data could not be cleared.',
  'preview.note.dismiss': 'Got it',
  'preview.refreshMode': 'Refresh after saving',
  'preview.refreshMode.title':
    'On: the preview refreshes after a successful save once you pause typing. Off: only when you click Refresh.',
  'preview.refreshMode.locked':
    'Can’t change it: the project’s .noobide/project.json cannot be read. Fix or delete it, then try again.',
  'preview.refreshMode.failed': 'The refresh setting could not be saved.',
  'preview.outdated': 'Saved changes not shown',
  'preview.outdatedDetail':
    'Manual refresh: the page still shows the files from before your last save. Click Refresh to see the latest.',
  'preview.reloadNote':
    'Note: refreshing reloads the page — anything typed into it, its scroll position and its variables start over.',
  'preview.entry': 'Entry page',
  'preview.entry.default': '(default)',
  'preview.entry.none': 'No HTML page found',
  'preview.entry.truncated': 'Too many pages: only some are listed.',
  'preview.entry.failed': 'The entry page could not be saved.',
  'preview.consent.title': 'This folder’s page has not run yet',
  'preview.consent.detail':
    'This folder was opened from your computer. For safety, its page scripts only run after you click “Start preview”; NoobIDE remembers your choice and previews it by itself next time.',
};
