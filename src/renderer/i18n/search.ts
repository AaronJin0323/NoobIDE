/**
 * Messages of S51: find and replace in the current file, find and replace in files, and quick open. Spread into
 * zh-CN.ts / en.ts like the other feature files.
 */
export const searchZhCN = {
  // ── S51.1 当前文件的查找和替换 ──
  'command.find': '查找',
  'command.replace': '替换',
  // ── S51.3 在文件中查找 ──
  'command.findInFiles': '在文件中查找',
  'search.title': '在文件中查找',
  'search.toggle': '在项目的所有文件里查找文字',
  'search.close': '收起查找面板',
  'search.refresh': '重新查找',
  'search.query': '要查找的文字',
  'search.placeholder': '查找（Enter 立即查找，↓ 到结果）',
  'search.option.case': '区分大小写',
  'search.option.word': '全字匹配',
  'search.option.regex': '使用正则表达式',
  'search.results': '查找结果',
  'search.noProject': '打开一个项目文件夹后，就能在它的所有文件里查找。',
  'search.idle': '输入要查找的文字，会在项目的所有文件里找（隐藏文件和 node_modules 除外）。',
  'search.searching': '正在查找…',
  'search.empty': '没有找到“{query}”。检查一下拼写，或者关掉“区分大小写”“全字匹配”再试。',
  'search.invalidRegex': '这个正则表达式写得不对：{message}。如果只想查找普通文字，请关掉“使用正则表达式”。',
  'search.failed': '查找没能完成（{message}）。请再试一次。',
  'search.count.matches': '{n} 个结果',
  'search.count.files': '在 {n} 个文件里',
  'search.summary': '{matches}，{files}',
  'search.truncated': '结果太多，只列出了前 {n} 个。把要查找的文字写得更具体一些，就能看到全部。',
  'search.fileMatches': '{n} 个',
  'search.line': '第 {n} 行',
  // ── S51.4 在文件中替换 ──
  'command.replaceInFiles': '在文件中替换',
  'replace.toggle': '替换',
  'replace.toggleLabel': '显示替换',
  'replace.input': '替换为',
  'replace.placeholder': '替换为（留空就是删掉找到的文字）',
  'replace.hint':
    '下面每一处都显示替换后的样子。取消勾选的文件或某一处不会被修改。替换会打开这些文件，在编辑器里各算一次可以撤销的修改，然后正常保存。',
  'replace.apply': '替换 {n} 处',
  'replace.includeFile': '替换“{file}”里的匹配',
  'replace.includeHit': '替换“{file}”第 {line} 行的这一处',
  'replace.was': '原来：',
  'replace.becomes': '替换为：',
  'replace.applying': '正在替换…',
  'replace.done': '已在 {n} 个文件里替换。每个文件都能在它的编辑器里撤销（Ctrl/Cmd+Z）。',
  'replace.failedTitle': '{n} 个文件没有替换：',
  'replace.failed.changed-since-search': '查找之后这个文件改过了。为了不改错地方，没有替换。请重新查找。',
  'replace.failed.read-only': '这个文件不是 UTF-8 编码，只能查看，不能修改。',
  'replace.failed.blocked': '这个文件正在改名、移动，或者和磁盘上的版本有冲突。先在它的标签页里处理好。',
  'replace.failed.open-failed': '打不开这个文件。',
  'replace.failed.project-changed': '替换开始后打开了另一个项目，这个文件没有改动。',
  'replace.failed.editor-failed': '编辑器没能放入这次修改，这个文件没有改动。',
  'replace.failed.save-failed': '替换已经放进编辑器（可以撤销），但没能保存。打开它的标签页看原因，可以重试。',
} as const;

export const searchEn: Record<keyof typeof searchZhCN, string> = {
  'command.find': 'Find',
  'command.replace': 'Replace',
  // ── S51.3 find in files ──
  'command.findInFiles': 'Find in Files',
  'search.title': 'Find in files',
  'search.toggle': 'Find text in all files of the project',
  'search.close': 'Collapse the search panel',
  'search.refresh': 'Search again',
  'search.query': 'Text to find',
  'search.placeholder': 'Find (Enter searches now, ↓ goes to the results)',
  'search.option.case': 'Match case',
  'search.option.word': 'Match whole word',
  'search.option.regex': 'Use regular expression',
  'search.results': 'Search results',
  'search.noProject': 'Open a project folder to search all of its files.',
  'search.idle': 'Type the text to find. All files of the project are searched (except hidden files and node_modules).',
  'search.searching': 'Searching…',
  'search.empty':
    'No results for “{query}”. Check the spelling, or turn off “Match case” and “Match whole word” and try again.',
  'search.invalidRegex':
    'This regular expression is not valid: {message}. To search for plain text, turn off “Use regular expression”.',
  'search.failed': 'The search could not finish ({message}). Please try again.',
  'search.count.matches': '{n} results',
  'search.count.files': 'in {n} files',
  'search.summary': '{matches} {files}',
  'search.truncated':
    'Too many results: only the first {n} are listed. Search for something more specific to see them all.',
  'search.fileMatches': '{n}',
  'search.line': 'line {n}',
  // ── S51.4 replace in files ──
  'command.replaceInFiles': 'Replace in Files',
  'replace.toggle': 'Replace',
  'replace.toggleLabel': 'Show replace',
  'replace.input': 'Replace with',
  'replace.placeholder': 'Replace with (leave empty to delete the found text)',
  'replace.hint':
    'Each match below shows what it will become. Unticked files or matches are not changed. Replacing opens these files, makes one undoable edit in each editor, then saves them as usual.',
  'replace.apply': 'Replace {n} matches',
  'replace.includeFile': 'Replace the matches in “{file}”',
  'replace.includeHit': 'Replace this match on line {line} of “{file}”',
  'replace.was': 'was: ',
  'replace.becomes': 'becomes: ',
  'replace.applying': 'Replacing…',
  'replace.done': 'Replaced in {n} files. Each file can be undone in its editor (Ctrl/Cmd+Z).',
  'replace.failedTitle': '{n} files were not changed:',
  'replace.failed.changed-since-search':
    'This file changed after the search. To avoid changing the wrong places, nothing was replaced. Search again.',
  'replace.failed.read-only': 'This file is not UTF-8 text: it can be viewed but not changed.',
  'replace.failed.blocked':
    'This file is being renamed or moved, or conflicts with its version on disk. Sort that out in its tab first.',
  'replace.failed.open-failed': 'This file could not be opened.',
  'replace.failed.project-changed': 'Another project was opened during the replace; this file was not changed.',
  'replace.failed.editor-failed': 'The editor could not take the change; this file was not changed.',
  'replace.failed.save-failed':
    'The replacement is in the editor (undoable) but could not be saved. Its tab says why and can try again.',
};
