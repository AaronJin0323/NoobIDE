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
  // ── S48.7 草稿、重试和等待 ──
  'ai.draft.restored': '已恢复你上次没有发送的内容。',
  'ai.draft.saveFailed': '没能把草稿保存到磁盘。在 NoobIDE 关闭前，它仍然留在这里。',
  'ai.retry.button': '重试',
  'ai.retry.now': '立即重试',
  'ai.retry.kept': '你的问题还在，按“重试”可以再发送一次。',
  'ai.backoff.cause429': '原因：AI 服务回复“请求太多”（HTTP 429）。',
  'ai.backoff.cause503': '原因：AI 服务暂时不可用（HTTP 503）。',
  'ai.backoff.waiting': '{time}后自动重试（第 {attempt} 次，最多 {max} 次）。',
  'ai.backoff.minutes': '{n} 分钟',
  'ai.backoff.seconds': '{n} 秒',
  'ai.backoff.exhausted': '已经自动重试了 {max} 次，仍然没有成功。等一会儿再按“重试”。',
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
  'ai.draft.restored': 'Restored what you had not sent yet.',
  'ai.draft.saveFailed': 'Could not keep the draft on disk. It stays here while NoobIDE is open.',
  'ai.retry.button': 'Retry',
  'ai.retry.now': 'Retry now',
  'ai.retry.kept': 'Your question is kept. Press Retry to send it again.',
  'ai.backoff.cause429': 'Cause: the AI service answered “too many requests” (HTTP 429).',
  'ai.backoff.cause503': 'Cause: the AI service is temporarily unavailable (HTTP 503).',
  'ai.backoff.waiting': 'Trying again in {time} (attempt {attempt} of {max}).',
  'ai.backoff.minutes': '{n} minutes',
  'ai.backoff.seconds': '{n} seconds',
  'ai.backoff.exhausted': 'Tried again {max} times automatically without success. Wait a little, then press Retry.',
};
