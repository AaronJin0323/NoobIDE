/**
 * Messages added by the beginner-journey fixes: the preview's current page and "back to the entry page", the page
 * the preview server shows for a missing page, and the editor's overflow menu. Spread into zh-CN.ts / en.ts.
 */
export const journeyZhCN = {
  // ── 预览：当前页面 ──
  'preview.page': '当前页面',
  'preview.page.title': '预览里正在显示的页面',
  'preview.page.missing': '这个页面不存在',
  'preview.goToEntry': '回到入口页面',
  'preview.goToEntry.title': '打开入口页面 {entry}',
  'preview.openExternal.short': '在浏览器中打开',
  // ── 预览服务器的“找不到页面”（显示在预览里，也显示在外部浏览器里）──
  'previewNotFound.title': '找不到这个页面',
  'previewNotFound.body': '项目里没有 {path} 这个文件，所以这里什么也显示不了。',
  'previewNotFound.cause': '常见原因：链接（<a href="…">）里的文件名写错了，或者这个页面还没有创建。',
  'previewNotFound.next':
    '点预览工具栏里的“回到入口页面”就能回去。然后检查链接里的文件名（包括大小写和扩展名），或者在文件列表里新建这个页面。',
  // ── 编辑器：更多操作 ──
  'editor.more': '编辑器选项',
  'editor.more.title': '整理格式、代码字号',
  'tabs.scrollStart': '显示前面的标签页',
  'tabs.scrollEnd': '显示后面的标签页',
  // ── 关键功能始终可见：侧栏“课程” ──
  'rail.lessons': '课程',
  'rail.lessons.title': '打开入门课程：一步步带你做出第一个网页',
} as const;

export const journeyEn: Record<keyof typeof journeyZhCN, string> = {
  'preview.page': 'Page',
  'preview.page.title': 'The page the preview is showing',
  'preview.page.missing': 'This page does not exist',
  'preview.goToEntry': 'Back to entry page',
  'preview.goToEntry.title': 'Open the entry page {entry}',
  'preview.openExternal.short': 'Open in browser',
  'previewNotFound.title': 'Page not found',
  'previewNotFound.body': 'The project has no file named {path}, so there is nothing to show here.',
  'previewNotFound.cause':
    'Usually the file name in a link (<a href="…">) is misspelled, or the page has not been created yet.',
  'previewNotFound.next':
    'Use “Back to entry page” in the preview toolbar to go back. Then check the file name in the link (capital letters and extension too), or create the page in the file list.',
  'editor.more': 'Editor options',
  'editor.more.title': 'Format, code font size',
  'tabs.scrollStart': 'Show earlier tabs',
  'tabs.scrollEnd': 'Show later tabs',
  'rail.lessons': 'Lessons',
  'rail.lessons.title': 'Open the beginner lessons: build your first web page step by step',
};
