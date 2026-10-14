/**
 * Problem explanation texts, zh-CN (default locale). `{name}` placeholders are filled from MessageRef params, which
 * hold identifiers, paths and numbers only — never source code. en.ts must define exactly the same keys.
 *
 * Honesty rule (PLAN §9, §13): only texts used with certainty 'certain' may state a cause as fact. Every other
 * explanation is worded as a possibility (可能…) and comes with checks.
 */
export const zhCN = {
  // Location and headings
  'location.fileLine': '{file}，第 {line} 行：',
  'location.file': '{file}：',
  'heading.possibleCauses': '可能的原因：',
  'heading.checks': '可以这样检查：',
  'certainty.certain': '原因已确认',
  'certainty.likely': '很可能的原因',
  'certainty.possible': '可能的原因',
  'certainty.unknown': '原因不确定',

  // Actions
  'action.goToCode': '转到代码',
  'action.showOriginal': '显示原始错误',
  'action.revealInFiles': '在文件树中显示 {path}',
  'action.replaceWith': '改成 {name}',

  // Fallback (no rule matched)
  'fallback.title.static': '代码检查发现了一个问题。',
  'fallback.title.runtime': '页面运行时出错了。',
  'fallback.title.resource': '有一个文件没有加载出来。',
  'fallback.title.console': '页面在控制台输出了一条错误。',
  'fallback.explanation': 'NoobIDE 还不能确定原因。原始错误是浏览器给出的原话，里面提到的名字或文件可能就是线索。',
  'fallback.check.goToCode': '点“转到代码”，看看出错的那一行。',
  'fallback.check.readOriginal': '展开“显示原始错误”，找找里面提到的变量名、文件名或行号。',
} as const satisfies Record<string, string>;

export type DiagnosticsMessageKey = keyof typeof zhCN;
