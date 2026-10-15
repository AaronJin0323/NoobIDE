/**
 * Messages of the AI inline edit (S35.1, Ctrl/Cmd+I) and "Fix with AI" on the problem card (S35.2). Spread into
 * zh-CN.ts / en.ts in one line each. `{name}` placeholders are filled with `fill()` (src/renderer/recovery/format.ts).
 */
export const aiEditZhCN = {
  // ── S35.1 命令和编辑器右键菜单 ──
  'command.ai.inlineEdit': '用 AI 修改代码',
  'ai.editor.inlineEdit': '用 AI 修改这段代码',
  // ── S35.1 编辑器里的修改区域 ──
  'ai.edit.region': 'AI 修改代码',
  'ai.edit.target.lines': '要修改的代码：{file} 第 {start}–{end} 行',
  'ai.edit.target.line': '要修改的代码：{file} 第 {start} 行',
  'ai.edit.target.file': '要修改的代码：整个 {file}',
  'ai.edit.instruction': '想怎么改？',
  'ai.edit.instructionPlaceholder': '例如：把按钮改成蓝色',
  'ai.edit.instructionHint': '按 Enter 发送，Esc 取消。这几行代码和它前后的一些代码会发送给 AI。',
  'ai.edit.send': '发送',
  'ai.edit.cancel': '取消',
  'ai.edit.running': 'AI 正在写修改……',
  'ai.edit.stop': '停止',
  'ai.edit.review':
    'AI 建议的修改：删除 {removed} 行，添加 {added} 行（“−”是删除的行，“+”是添加的行）。接受后会替换高亮的代码，拒绝则什么都不改。',
  'ai.edit.accept': '接受',
  'ai.edit.reject': '拒绝',
  'ai.edit.diff': 'AI 建议的修改',
  'ai.edit.diff.removed': '删除：',
  'ai.edit.diff.added': '添加：',
  'ai.edit.diff.skipped': '（{n} 行没有变化）',
  'ai.edit.diff.tooLarge': '修改太大，没法逐行显示：删除 {removed} 行，添加 {added} 行。',
  'ai.edit.applying': '正在应用修改并保存……',
  'ai.edit.applied': '已接受 AI 的修改并保存。在编辑器里按 {shortcut} 可以撤销。',
  'ai.edit.rejected': '已拒绝 AI 的修改，代码没有变化。',
  'ai.edit.closed': '已关闭 AI 修改，代码没有变化。',
  'ai.edit.noChange': 'AI 没有提出任何修改，代码没有变化。可以换个说法再试。',
  'ai.edit.saveFailed': '修改已经放进编辑器，但保存失败：{reason} 修改还在编辑器里，不会丢失。',
  'ai.edit.stale': '发送之后这段代码又被改动了，所以没有应用 AI 的修改，你的代码保持不变。可以用现在的代码再试一次。',
  'ai.edit.blocked':
    '这个文件现在不能修改（只读，或者正在重命名、移动或删除），所以没有应用 AI 的修改，你的代码保持不变。等操作完成后可以再试一次。',
  'ai.edit.cancelled': '已停止，代码没有变化。',
  'ai.edit.retry': '再试一次',
  'ai.edit.close': '关闭',
  'ai.edit.readOnly': '这个文件现在不能修改（只读、使用了其他编码，或者正在重命名、移动或删除），所以 AI 也不能改它。',
  'ai.edit.noKey': '还没有 API 密钥，所以不能用 AI 修改代码。请先在“设置 → AI”里填写密钥。',
  'ai.edit.openSettings': '打开 AI 设置',
  'ai.edit.error.empty-answer': 'AI 返回了空的回答，所以没有修改任何代码。可以再试一次。',
  'ai.edit.consentDeclined': '没有发送任何代码。',
  // ── S35.2 问题卡片上的“用 AI 修复” ──
  'problems.card.fixWithAi': '用 AI 修复',
  'problems.card.fixWithAiHint': 'AI 会针对这个问题提出修改，你看过对比后再决定接受还是拒绝。',
  'ai.fix.instructionLabel': '请 AI 修复：{title}',
  'ai.fix.heading': '刚才用 AI 做的修复',
  'ai.fix.saveFailed': 'AI 的修改已经在编辑器里，但保存失败：{reason} 问题还没有解决。',
  'ai.fix.checking': '已保存 AI 的修改，正在重新检查……',
  'ai.fix.unchecked':
    '已保存 AI 的修改，但没能重新检查（代码检查没有回应，或文件已经关闭）。所以还不能说问题已经解决，可以点“重新检查”再试。',
  'ai.fix.awaitingRefresh': '已保存 AI 的修改，代码检查不再报告这个问题。还要等预览刷新后，确认页面运行时也不再出现。',
  'ai.fix.stillReported': '已保存 AI 的修改，但重新检查后仍然报告这个问题。可以看看原始错误，或转到代码检查一下。',
  'ai.fix.undoHint': '在编辑器里按 {shortcut} 可以撤销 AI 的修改。',
} as const;

export const aiEditEn: Record<keyof typeof aiEditZhCN, string> = {
  'command.ai.inlineEdit': 'Edit code with AI',
  'ai.editor.inlineEdit': 'Edit this code with AI',
  'ai.edit.region': 'AI edit',
  'ai.edit.target.lines': 'Code to change: {file} lines {start}–{end}',
  'ai.edit.target.line': 'Code to change: {file} line {start}',
  'ai.edit.target.file': 'Code to change: all of {file}',
  'ai.edit.instruction': 'What should change?',
  'ai.edit.instructionPlaceholder': 'For example: make the button blue',
  'ai.edit.instructionHint': 'Enter sends, Esc cancels. These lines and some code around them are sent to the AI.',
  'ai.edit.send': 'Send',
  'ai.edit.cancel': 'Cancel',
  'ai.edit.running': 'The AI is writing the change…',
  'ai.edit.stop': 'Stop',
  'ai.edit.review':
    'Proposed change: {removed} lines removed, {added} lines added ("−" marks removed lines, "+" added lines). Accept replaces the highlighted code; Reject changes nothing.',
  'ai.edit.accept': 'Accept',
  'ai.edit.reject': 'Reject',
  'ai.edit.diff': 'Proposed change',
  'ai.edit.diff.removed': 'removed: ',
  'ai.edit.diff.added': 'added: ',
  'ai.edit.diff.skipped': '({n} unchanged lines)',
  'ai.edit.diff.tooLarge':
    'The change is too large to show line by line: {removed} lines removed, {added} lines added.',
  'ai.edit.applying': 'Applying the change and saving…',
  'ai.edit.applied': 'AI change applied and saved. Press {shortcut} in the editor to undo it.',
  'ai.edit.rejected': 'AI change rejected. Your code is unchanged.',
  'ai.edit.closed': 'AI edit closed. Your code is unchanged.',
  'ai.edit.noChange': 'The AI suggested no change, so your code is unchanged. Try saying it differently.',
  'ai.edit.saveFailed':
    'The change is in the editor, but saving failed: {reason} It stays in the editor; nothing is lost.',
  'ai.edit.stale':
    'This code changed after it was sent, so the AI change was not applied and your code stays as it is. You can try again with the current code.',
  'ai.edit.blocked':
    'This file cannot be changed right now (it is read-only, or being renamed, moved or deleted), so the AI change was not applied and your code stays as it is. You can try again once that has finished.',
  'ai.edit.cancelled': 'Stopped. Your code is unchanged.',
  'ai.edit.retry': 'Try again',
  'ai.edit.close': 'Close',
  'ai.edit.readOnly':
    'This file cannot be changed right now (read-only, in another encoding, or being renamed, moved or deleted), so the AI cannot change it.',
  'ai.edit.noKey': 'There is no API key yet, so AI cannot edit code. Add your key in Settings → AI first.',
  'ai.edit.openSettings': 'Open AI settings',
  'ai.edit.error.empty-answer': 'The AI returned an empty answer, so nothing was changed. You can try again.',
  'ai.edit.consentDeclined': 'Nothing was sent.',
  'problems.card.fixWithAi': 'Fix with AI',
  'problems.card.fixWithAiHint':
    'The AI proposes a change for this problem; you see the difference and then accept or reject it.',
  'ai.fix.instructionLabel': 'Asking the AI to fix: {title}',
  'ai.fix.heading': 'Your AI fix',
  'ai.fix.saveFailed': 'The AI change is in the editor, but saving failed: {reason} The problem is not resolved yet.',
  'ai.fix.checking': 'Saved the AI change. Checking again…',
  'ai.fix.unchecked':
    'Saved the AI change, but could not check again (the code check did not answer, or the file was closed). So it cannot be called resolved yet; use Check again to retry.',
  'ai.fix.awaitingRefresh':
    'Saved the AI change; the code check no longer reports this problem. Waiting for the preview to refresh to confirm the page no longer reports it either.',
  'ai.fix.stillReported':
    'Saved the AI change, but checking again still reports this problem. Look at the original error, or go to the code.',
  'ai.fix.undoHint': 'You can undo the AI change in the editor with {shortcut}.',
};
