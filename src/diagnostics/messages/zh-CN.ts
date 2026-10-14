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

  // Rule 1 — misspelled / undefined variable
  'undefinedName.title': '找不到变量 {name}。',
  'undefinedName.explanation': '这个名字可能拼错了，也可能还没有定义。',
  'undefinedName.check.matchWithLine': '检查它的拼写是否和定义时的 {candidate}（第 {line} 行）一致。',
  'undefinedName.check.match': '检查它的拼写是否和定义时的 {candidate} 一致。',
  'undefinedName.check.matchSeveral': '检查它的拼写是否和这些已定义的名字之一一致：{candidates}。',
  'undefinedName.check.caseOnly': 'JavaScript 区分大小写：{name} 和 {candidate} 是两个不同的名字。',
  'undefinedName.check.spelling': '检查名字的拼写和大小写是否和定义时完全一样。',
  'undefinedName.check.declare': '如果这个变量还没有定义，先声明它。',
  'undefinedName.check.otherFile': '如果它定义在另一个 .js 文件里，检查 HTML 是否在这之前用 <script> 引入了那个文件。',

  // Rule 2 — brackets and other syntax errors
  'syntax.title.endOfInput': '代码还没写完就结束了（意外的结尾）。',
  'syntax.title.missingParen': '函数调用缺少右括号 )。',
  'syntax.title.unexpected': '这里出现了意外的 {token}。',
  'syntax.title.expected': '这里应该有一个 {token}。',
  'syntax.title.invalidToken': '这一行有浏览器无法识别的字符。',
  'syntax.title.generic': '代码的写法有错误（语法错误）。',
  'syntax.explanation.unclosed': '很可能有一个 {、( 或 [ 没有闭合，浏览器一直读到最后也没有找到和它配对的括号。',
  'syntax.explanation.bracket': '很可能有括号没有配对：每个 (、[、{ 都需要一个对应的 )、]、}。',
  'syntax.explanation.invalidToken': '可能有引号没有闭合，或者用了中文标点。',
  'syntax.explanation.generic': '浏览器读不懂这里的写法，可能是少了逗号、运算符或括号。',
  'syntax.cause.extraClose': '可能多写了一个 {token}，或者它前面少了对应的开括号。',
  'syntax.cause.unclosedQuote': '可能有一个引号（\' 或 "）没有闭合。',
  'syntax.cause.fullWidth': '这一行有中文标点 {char}，代码里的符号需要用英文标点。',
  'syntax.cause.previousLine': '问题可能在上一行：例如上一行末尾少了逗号或括号。',
  'syntax.check.countBrackets': '从出错的那一行往上看，数一数 {、( 和 [ 是否都有对应的 }、) 和 ]。',
  'syntax.check.bracketHighlight': '把光标放在一个括号旁边，编辑器会高亮和它配对的那一个。',
  'syntax.check.quotes': '检查这一行的引号是否成对出现。',
  'syntax.check.englishPunctuation': '切换到英文输入法，重新输入这一行的标点。',
  'syntax.check.previousLine': '同时检查出错位置前面一两行的写法。',

  // Rule 3 — DOM element not found (null)
  'nullElement.title': '要操作的页面元素没有找到（得到的是 null），所以无法使用 {property}。',
  'nullElement.explanation': 'getElementById 或 querySelector 可能没有找到元素，返回了 null。',
  'nullElement.cause.idMissing': 'HTML 里可能没有 id 为“{id}”的元素。',
  'nullElement.cause.idSimilar': 'HTML 里有一个相似的 id：“{candidate}”，可能是拼写或大小写不一致。',
  'nullElement.cause.idHash': "getElementById 的参数不需要 #：可能应该写成 getElementById('{id}')。",
  'nullElement.cause.selector': '选择器“{selector}”可能没有匹配到任何元素。',
  'nullElement.cause.tooEarly': '脚本可能在元素出现之前就运行了：<script> 写在 <head> 里或元素的上方。',
  'nullElement.check.compare': '对照 HTML，检查 id 或选择器的拼写和大小写（# 表示 id，. 表示 class）。',
  'nullElement.check.scriptPosition': '把 <script> 放到 </body> 前面，或者给它加上 defer。',

  // Rules 4–6 — script, image and stylesheet not found (404)
  'notFound.title.script': '脚本 {path} 没有加载出来（404），里面的代码不会运行。',
  'notFound.title.image': '图片 {path} 没有加载出来（404）。',
  'notFound.title.stylesheet': '样式表 {path} 没有加载出来（404），里面的样式不会生效。',
  'notFound.explanation': '页面请求了这个文件，但项目里没有找到它。可能是路径或文件名写得不对。',
  'notFound.cause.case': '文件名大小写不一致：项目里是 {actual}。在 Windows 上能显示，在 Mac 或网站上可能不行。',
  'notFound.cause.otherFolder': '文件可能放在了别的文件夹：项目里有 {actual}。',
  'notFound.cause.wrongFolder': '文件不在 {folder} 文件夹里。',
  'notFound.cause.similarName': '文件名可能拼错了：项目里有一个相似的文件 {actual}。',
  'notFound.cause.missing': '项目里可能还没有这个文件，或者文件名写错了。',
  'notFound.cause.absolutePath': '路径可能写成了电脑上的位置（例如 C:\\ 或 file://），网页只能使用项目里的相对路径。',
  'notFound.check.relative': '路径是从 {initiator} 所在的文件夹开始算的；去上一级文件夹要写 ../。',
  'notFound.check.compareName': '在文件树里找到这个文件，对照它的名字和扩展名（包括大小写）。',

  // Rule 7 — misspelled CSS property
  'cssProperty.title': '浏览器不认识 CSS 属性 {property}，这条样式会被忽略。',
  'cssProperty.explanation.one': '可能是 {candidate} 拼错了。',
  'cssProperty.explanation.several': '可能是拼错了，相近的属性有：{candidates}。',
  'cssProperty.explanation.none': '可能是拼写错误，也可能这个属性并不存在。',
  'cssProperty.check.spelling': '对照拼写改成正确的属性名，保存后预览会更新。',
  'cssProperty.check.reference': '不确定属性名时，可以在帮助里查找 CSS 属性列表。',

  // Rule 8 — module import failures
  'module.bare.title': '无法加载模块 "{specifier}"。',
  'module.bare.explanation':
    '浏览器只能按路径加载模块。"{specifier}" 不是以 ./、../ 或 / 开头的路径，看起来像 npm 包的名字，而 NoobIDE 目前不支持 npm 包。',
  'module.bare.check.relative': '如果它是项目里的文件，写成以 ./ 开头的路径，并带上 .js 扩展名。',
  'module.bare.check.download': '如果它是第三方库，把它的 .js 文件放进项目里，再用 ./ 路径引入。',
  'module.notModule.title': '这个脚本用了 import 或 export，但没有作为模块加载。',
  'module.notModule.explanation': '很可能是 HTML 里的 <script> 没有写 type="module"。',
  'module.notModule.check.type': '在 HTML 里给这个 <script> 加上 type="module"。',
  'module.missingExport.title': '{module} 里没有名为 {name} 的导出。',
  'module.missingExport.explanation':
    '这里导入了 {name}，但 {module} 没有用这个名字导出任何东西。可能是名字拼错了，或者那边忘了写 export。',
  'module.missingExport.check.export': '打开 {module}，检查是否写了 export，并且名字的拼写和大小写一致。',
  'module.missingExport.check.default': '如果那边用的是 export default，这里要写成 import 名字 from …（不加花括号）。',
  'module.loadFailed.title': '模块文件没有加载出来。',
  'module.loadFailed.explanation': '模块文件可能不存在，或者路径写错了：服务器返回的不是 JavaScript 文件。',
  'module.loadFailed.check.path': '检查 import 里的路径和文件名，包括大小写和 .js 扩展名。',
} as const satisfies Record<string, string>;

export type DiagnosticsMessageKey = keyof typeof zhCN;
