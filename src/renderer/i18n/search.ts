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
};
