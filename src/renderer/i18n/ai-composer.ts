/**
 * Messages of the chat composer and message log refinements of M18 (S48.4 slash commands and @file mentions, S48.6
 * long messages and per-message actions, S48.7 drafts, Retry and provider backoff). Spread into zh-CN.ts / en.ts.
 */
export const aiComposerZhCN = {
  // ── S48.4 / 命令和 @文件 ──
  'ai.composer.triggerHint': '输入 / 运行命令，输入 @ 添加项目里的文件。',
  'ai.composer.commands': '命令',
  'ai.composer.files': '项目文件',
  'ai.composer.loadingFiles': '正在读取项目里的文件…',
  'ai.composer.noCommands': '没有匹配的命令。',
  'ai.composer.noFiles': '没有匹配的文件。',
  'ai.composer.listHint': '↑↓ 选择，Enter 或 Tab 确定，Esc 关闭列表。',
  'ai.composer.folderRoot': '项目根目录',
  // ── S48.6 长消息和消息操作 ──
  'ai.message.showMore': '展开全文',
  'ai.message.showLess': '收起',
  'ai.message.actions': '消息操作',
  'ai.message.copy': '复制这条消息',
  'ai.message.reask': '再问一次',
  'ai.message.reaskHint': '再问一次：把这个问题放回输入框，可以改一改再发送',
};

export const aiComposerEn: Record<keyof typeof aiComposerZhCN, string> = {
  'ai.composer.triggerHint': 'Type / for commands, @ to add a project file.',
  'ai.composer.commands': 'Commands',
  'ai.composer.files': 'Project files',
  'ai.composer.loadingFiles': 'Reading the project’s files…',
  'ai.composer.noCommands': 'No matching command.',
  'ai.composer.noFiles': 'No matching file.',
  'ai.composer.listHint': '↑↓ to choose, Enter or Tab to accept, Esc to close the list.',
  'ai.composer.folderRoot': 'Project folder',
  'ai.message.showMore': 'Show more',
  'ai.message.showLess': 'Show less',
  'ai.message.actions': 'Message actions',
  'ai.message.copy': 'Copy this message',
  'ai.message.reask': 'Ask again',
  'ai.message.reaskHint': 'Ask again: puts this question back in the box, so you can change it before sending',
};
