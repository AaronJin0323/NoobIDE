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
  // 链接指向了不存在的页面（页面本身是 404）
  'notFound.title.page': '页面 {path} 不存在（404）：有一个链接指向了不存在的页面。',
  'notFound.explanation.page':
    '可能是页面里的一个链接（<a href>）打开了这个页面，但项目里没有这个文件，所以预览显示“找不到这个页面”。点预览工具栏里的“回到入口页面”就能回去。',
  'notFound.check.link': '检查 {initiator} 里这个链接的 href：文件名、扩展名和大小写。',
  'notFound.check.createPage': '如果这个页面还没写，就在文件列表里用完全相同的名字新建它。',

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

  // Rule 9 — unhandled promise rejection
  'rejection.title': '一个 Promise 失败了，但没有代码处理这个错误。',
  'rejection.explanation':
    '异步操作（例如 fetch 或 await 的结果）可能失败了，而代码里没有 .catch() 或 try…catch 来处理它。原始错误里可能写着失败的原因。',
  'rejection.check.catch': '给这个 Promise 加上 .catch(error => { … })，或者把 await 写在 try { … } catch { … } 里。',
  'rejection.check.reason': '展开“显示原始错误”，看看失败的原因。',

  // Rule 10 — fetch failures
  'fetch.failed.title': '请求没有发出去，或者没有收到回应（Failed to fetch）。',
  'fetch.status.title': '请求 {path} 失败了，服务器返回 {status}。',
  'fetch.network.title': '请求 {path} 失败了（{netError}）。',
  'fetch.explanation': '可能是地址写错了、文件不存在，或者对方的服务器没有运行、不允许访问。',
  'fetch.cause.notFound': '地址里的文件可能不存在，或者路径写错了。',
  'fetch.cause.cors': '如果控制台里同时有带“CORS”字样的错误，可能是对方网站不允许这个页面读取它的数据。',
  'fetch.cause.offline': '如果请求的是网上的地址，可能是电脑没有联网。',
  'fetch.cause.serverDown': '如果请求的是本机上另一个服务器的地址，可能那个服务器没有运行。',
  'fetch.check.url': "检查 fetch 里的地址；项目里的文件用相对路径，例如 fetch('data.json')。",
  'fetch.check.console': '在控制台里看看同一时间有没有其他错误。',

  // Rule 11 — CORS
  'cors.title': '浏览器阻止了页面读取 {url} 的数据（CORS）。',
  'cors.titleGeneric': '浏览器阻止了页面读取另一个网站的数据（CORS）。',
  'cors.explanation':
    '那个网站没有允许其他网页读取它的数据，这是浏览器的安全规则。NoobIDE 不会关闭这项安全检查，在其他浏览器里打开也会一样。',
  'cors.check.local': "如果只是要用一些数据，可以把数据保存成项目里的 .json 文件，再用 fetch('文件名.json') 读取。",
  'cors.check.api': '如果要用网上的接口，查一下它的文档，确认它允许网页直接调用（支持 CORS）。',

  // Rule 12 — JSON parse errors
  'json.title': '无法把这段文本解析成 JSON。',
  'json.html.explanation':
    '收到的内容很可能是一个网页（以 < 开头），而不是 JSON。常见原因是请求的地址不对，服务器返回了“找不到”页面。',
  'json.empty.explanation': '要解析的文本可能是空的，或者只有一半。',
  'json.quotes.explanation': 'JSON 的写法可能不对：属性名和字符串必须用双引号，最后一项后面不能有逗号。',
  'json.undefined.explanation':
    '传给 JSON.parse 的值是 undefined，可能是要读取的数据还不存在（例如 localStorage 里还没有这一项）。',
  'json.generic.explanation': '要解析的文本可能不是正确的 JSON。',
  'json.check.url': '如果数据来自 fetch，确认地址正确，并在控制台里打印收到的文本看看。',
  'json.check.file': '如果数据来自项目里的 .json 文件，打开它检查双引号和逗号。',

  // Rule 13 — "x is not a function"
  'notFunction.title': '{name} 不是函数，不能用 () 调用。',
  'notFunction.explanation.typo': '可能是拼写错误：你想用的可能是 {candidate}。',
  'notFunction.explanation.several': '可能是拼写错误，相近的名字有：{candidates}。',
  'notFunction.explanation.notArray': '{object} 可能不是数组，所以没有 {method} 方法。',
  'notFunction.explanation.generic': '这个名字可能不是函数：也许它是一个普通的值、拼错了，或者在赋值之前就被调用了。',
  'notFunction.check.spelling': '检查名字的拼写和大小写（JavaScript 区分大小写，例如 getElementById 里的 Id）。',
  'notFunction.check.log': '在这一行前面加上 console.log({name})，看看它到底是什么。',
  'notFunction.check.array': '确认 {object} 是一个数组，例如用 console.log({object}) 查看它。',

  // Rule 14 — unclosed HTML tag
  'htmlUnclosed.title': '<{tag}> 标签没有找到对应的 </{tag}>。',
  'htmlUnclosed.explanation': '很可能少写了 </{tag}>，后面的内容可能都被当成了这个元素的一部分，页面布局可能因此错乱。',
  'htmlUnclosed.check.findFromLine': '从第 {line} 行往下找，在这个元素的内容结束的地方加上 </{tag}>。',
  'htmlUnclosed.check.find': '在这个元素的内容结束的地方加上 </{tag}>。',
  'htmlUnclosed.check.typo': '检查结束标签的拼写，拼错的结束标签不能闭合元素。',
  'htmlUnclosed.check.indent': '保持缩进整齐，更容易看出哪个标签没有闭合。',

  // S42.3 — an /ai prompt line that has not been run yet
  'aiPrompt.title': '这一行 /ai 是你给 AI 的要求，还不是代码。',
  'aiPrompt.explanation':
    '在运行或删除它之前，这一行会作为普通文字保存在文件里，会显示在网页上，或者让 CSS、JavaScript 出错。',
  'aiPrompt.check.runAtLine':
    '把光标放到第 {line} 行末尾，按 Ctrl+Enter（Mac 上是 ⌘Enter），让 AI 写出代码。刚输入的 /ai 行直接按 Enter 也可以。',
  'aiPrompt.check.run':
    '把光标放到 /ai 这一行末尾，按 Ctrl+Enter（Mac 上是 ⌘Enter），让 AI 写出代码。刚输入的 /ai 行直接按 Enter 也可以。',
  'aiPrompt.check.delete': '如果不需要了，删掉这一行即可。',

  // Rule 15 — selector does not match (guided checks)
  'selector.title': '选择器 {selector} 可能没有匹配到页面上的任何元素。',
  'selector.titleGeneric': '样式没有生效。',
  'selector.explanation': 'NoobIDE 不能确定原因。可以按下面的步骤逐一检查。',
  'selector.cause.similarId': 'HTML 里有一个相似的 id：“{candidate}”，可能是拼写或大小写不一致。',
  'selector.cause.similarClass': 'HTML 里有一个相似的 class：“{candidate}”，可能是拼写或大小写不一致。',
  'selector.cause.isId': 'HTML 里的“{name}”是 id，选择器可能要写成 #{name}。',
  'selector.cause.isClass': 'HTML 里的“{name}”是 class，选择器可能要写成 .{name}。',
  'selector.check.spelling': '对照 HTML，检查 class 或 id 的拼写和大小写是否和选择器完全一致。',
  'selector.check.prefix': '选择器里 . 表示 class，# 表示 id，标签名前面不加符号。',
  'selector.check.linked':
    '确认 HTML 的 <head> 里用 <link rel="stylesheet" href="…"> 引入了这个 CSS 文件，并且路径正确。',
  'selector.check.override': '看看后面有没有其他规则或更具体的选择器设置了同一个属性。',
  'selector.check.saved': '保存文件，并确认预览已经刷新。',
  // S16.6 — opaque cross-origin "Script error."
  'crossOrigin.title': '另一个网站的脚本出错了，但浏览器隐藏了详细信息（Script error.）。',
  'crossOrigin.explanation':
    '这个错误很可能来自另一个网站的脚本（例如 CDN 上的库）。出于安全原因，浏览器不会把这类错误的细节告诉页面，所以 NoobIDE 无法显示文件名和行号。',
  'crossOrigin.cause.script': '页面加载了另一个网站的脚本：{url}',
  'crossOrigin.check.download': '把这个库的 .js 文件放进项目里，再用相对路径引入；之后再出错时就能看到具体位置。',
  'crossOrigin.check.crossorigin':
    '如果那个网站支持 CORS，也可以给 <script> 加上 crossorigin 属性，这样能看到错误详情。',
  'crossOrigin.check.console': '在控制台里看看同一时间有没有其他更具体的错误。',
  'crossOrigin.external.title': '另一个网站的脚本报告了错误：{url}',
  'crossOrigin.external.explanation':
    '浏览器报告这个错误发生在从另一个网站加载的脚本里（{url}），不在你的项目文件中，所以 NoobIDE 无法带你跳到你代码中的某一行。页面自己只会收到“Script error.”：浏览器会隐藏其他网站脚本中错误的细节。',
  'crossOrigin.external.check.calls':
    '检查你自己的代码里在出错前使用这个库的那几行：传给它的值是否正确，页面是否已经准备好（例如元素是否已经存在）。',
  // S55.2 rules 16–25 (docs/product/explanation-rules-16-25.md) and their quick-fix labels (S55.3)
  'action.usePath': '把路径改成 {path}',
  'action.createFile': '新建文件 {path}',
  'action.addAlt': '给这个 <img> 加上 alt=""',
  'action.fixClosingTag': '把 </{from}> 改成 </{to}>',
  'action.useSelector': "把 '{from}' 改成 '{to}'",
  // Rule 16 — broken relative path, found statically
  'brokenRef.title': '{attr}="{ref}" 指向的文件在项目里找不到。',
  'brokenRef.explanation':
    'NoobIDE 在项目的文件列表里没有找到 {path}，所以网页运行时这个文件可能加载不出来。文件列表偶尔会比磁盘慢一点；如果文件刚刚建好，保存一下再看。',
  'brokenRef.cause.similar': '项目里有一个名字相近的文件：{actual}，路径可能写错了。',
  'brokenRef.cause.several': '项目里有几个名字相近的文件：{candidates}，可能是其中一个。',
  'brokenRef.cause.missing': '这个文件可能还没有建，或者放在了别的文件夹里。',
  'brokenRef.check.relative': '路径是从 {file} 所在的文件夹开始算的：../ 表示上一层文件夹。',
  'brokenRef.check.compare': '在文件树里找到这个文件，逐个字母对照路径（包括扩展名）。',
  // Rule 17 — duplicate id
  'dupId.title': 'id “{id}” 在这个文件里用了不止一次（第一次在第 {firstLine} 行）。',
  'dupId.explanation':
    '一个 id 在一个页面里只能用一次。用了两次时，getElementById("{id}") 只会找到第一个元素，#{id} 的样式却会同时作用到两个元素上。',
  'dupId.check.rename': '给其中一个元素换一个不重复的 id；如果几个元素要用同样的样式，改用 class。',
  'dupId.check.code': '检查 JavaScript 和 CSS 里用到 {id} 的地方，确认它们要的是哪一个元素。',
  // Rule 18 — <img> without alt
  'imgAlt.title': '这个 <img> 没有 alt 属性。',
  'imgAlt.explanation':
    'alt 是图片的文字说明：读屏软件会读出它，图片加载失败时也会显示它。只用来装饰的图片可以写 alt=""（空的）。',
  'imgAlt.check.describe': '在 alt="" 的引号里用几个字写出图片内容，例如 alt="网站标志"。',
  // Rule 19 — mismatched closing tag
  'mismatch.title': '结束标签 </{tag}> 没有对应的开始标签。',
  'mismatch.explanation.open':
    '浏览器会忽略这个 </{tag}>。这里打开着的是 <{open}>，你可能想写的是 </{open}>，或者多写了一个结束标签。',
  'mismatch.explanation.none':
    '这里没有打开着的 <{tag}>，浏览器会忽略这个结束标签。它可能是多写的，或者开始标签写错了。',
  'mismatch.check.pair': '从这一行往上找，看看 <{open}> 是在哪里开始的，它的结束标签应该写在哪里。',
  'mismatch.check.spelling': '检查开始标签和结束标签的名字拼写是否完全一样。',
  // Rule 20 — CSS length without unit
  'unitless.title': '{property}: {value} 缺少单位，浏览器会忽略这一条样式。',
  'unitless.explanation':
    '除了 0，长度都要带单位，例如 {value}px、{value}%、{value}em 或 {value}rem。你可能想写 {value}px，但具体用哪个单位要看你想要的效果。',
  'unitless.check.unit': '在数字后面紧挨着写上单位（中间不要空格），保存后看预览。',
  // Rule 21 — inline handler calling an undefined function
  'inlineHandler.title': '页面上的 on… 属性调用了 {name}，但浏览器找不到这个函数。',
  'inlineHandler.explanation':
    '像 onclick="{name}()" 这样的写法只能调用全局函数。浏览器在点击（或其他事件）发生时没有找到 {name}，可能的原因见下面。',
  'inlineHandler.cause.module': '函数可能写在 <script type="module"> 里：模块里的函数不是全局的，onclick 找不到它。',
  'inlineHandler.cause.notLoaded': '定义这个函数的 .js 文件可能没有用 <script src="…"> 引入，或者路径不对。',
  'inlineHandler.cause.spelling': '属性里的名字和定义时的名字可能拼写或大小写不一致。',
  'inlineHandler.cause.nested': '函数可能写在另一个函数里面，外面看不到它。',
  'inlineHandler.check.compare': '对照 HTML 里的 on…="{name}()" 和 JavaScript 里的 function {name}，逐个字母比较。',
  'inlineHandler.check.listener': '也可以改用 addEventListener：在 JavaScript 里找到元素，再给它加事件。',
  // Rule 22 — script runs before the element it reads
  'scriptEarly.title': '脚本读取 #{id} 时得到了 null，但 HTML 里确实有 id="{id}" 的元素。',
  'scriptEarly.explanation':
    '元素存在却没找到，很可能是脚本运行得太早：<script> 写在这个元素前面，浏览器运行脚本时还没读到这个元素。',
  'scriptEarly.check.move': '把 <script> 移到 </body> 前面，或者给它加上 defer：<script src="…" defer>。',
  'scriptEarly.check.dynamic': '如果这个元素是后来用 JavaScript 加进页面的，要在加进去之后再去找它。',
  'scriptEarly.check.page': '确认出错的页面就是有 id="{id}" 的那个 HTML 文件。',
  // Rule 23 — selector-prefix mistakes
  'selPrefix.title.byIdHash': "getElementById('{selector}') 里多了一个 {prefix}。",
  'selPrefix.title.queryBare': "querySelector('{selector}') 少了 # 或 .。",
  'selPrefix.explanation.byIdHash':
    'getElementById 只要 id 本身，不需要 # 或 .，所以这里很可能找不到元素，会得到 null。',
  'selPrefix.explanation.queryBare':
    'querySelector 用的是 CSS 选择器：不带符号的 {selector} 表示 <{selector}> 标签。页面里的“{selector}”是 id 或 class，所以很可能要写成 #{selector} 或 .{selector}。',
  'selPrefix.cause.isId': '项目的 HTML 里有 id="{name}"。',
  'selPrefix.cause.isClass': '项目的 HTML 里有 class="{name}"。',
  'selPrefix.check.prefix': '记住：getElementById("名字")，querySelector("#名字") 或 querySelector(".名字")。',
  // Rule 24 — reference differs only in letter case
  'refCase.title': '{attr}="{ref}" 和项目里的文件 {actual} 只差大小写。',
  'refCase.explanation':
    '在 Windows 和大多数 Mac 上这个文件可能还能打开，但在区分大小写的系统或网站服务器上可能打不开。',
  'refCase.check.match': '把路径的每个字母写得和文件名完全一样（包括大小写和扩展名）。',
  // Rule 25 — assignment in an if/while condition
  'assignCond.title': '{keyword} 的条件里用了一个 =。',
  'assignCond.explanation': '一个 = 是赋值：它会改变变量，然后用新值来判断条件。这里可能本想比较两个值，应该写 ===。',
  'assignCond.check.compare': '如果是想比较，把 = 改成 ===；如果确实想赋值，把赋值写到条件外面的上一行。',
} as const satisfies Record<string, string>;

export type DiagnosticsMessageKey = keyof typeof zhCN;
